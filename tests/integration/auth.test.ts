import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as authRoute } from "@/app/api/auth/[...all]/route";
import { getAuth } from "@/server/auth";
import { db } from "@/server/db";

/**
 * Drives Better Auth through its real HTTP handler (so hooks, rate limiting and
 * origin checks all apply) against a temporary database. Tests run in order.
 */

const BASE = process.env.BETTER_AUTH_URL ?? "http://localhost:3999";
const OWNER = { name: "Test Owner", email: "owner@example.test", password: "integration-test-password" };

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return getAuth().handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  await db.auditLog.deleteMany();
  await db.user.deleteMany();
  await db.ownerLock.deleteMany();
});

describe("first-run setup and sign-up lock (FND-01)", () => {
  it("rejects a common password even for the first account", async () => {
    const response = await post("/sign-up/email", { ...OWNER, password: "password1234" });
    expect(response.status).toBe(400);
    expect(await db.user.count()).toBe(0);
  });

  it("two simultaneous first-run sign-ups create only one owner (Phase 10)", async () => {
    const [a, b] = await Promise.all([
      post(
        "/sign-up/email",
        { name: "A", email: "a@example.test", password: "first-racer-password" },
        {
          "x-forwarded-for": "10.0.0.1",
        },
      ),
      post(
        "/sign-up/email",
        { name: "B", email: "b@example.test", password: "second-racer-password" },
        {
          "x-forwarded-for": "10.0.0.2",
        },
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    expect(await db.user.count()).toBe(1);
    // Start again with a clean first run for the tests below.
    await db.user.deleteMany();
    await db.ownerLock.deleteMany();
  });

  it("creates the owner, their settings row and an audit entry", async () => {
    const response = await post("/sign-up/email", OWNER);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");

    const user = await db.user.findUniqueOrThrow({ where: { email: OWNER.email }, include: { settings: true } });
    expect(user.settings).toMatchObject({ defaultLanguage: "auto", autoTranscribe: true, llmProvider: "ollama" });
    expect(await db.auditLog.count({ where: { action: "auth.setup_completed", userId: user.id } })).toBe(1);
  });

  it("stores a hash, never the plain password", async () => {
    const account = await db.account.findFirstOrThrow({ where: { providerId: "credential" } });
    expect(account.password).toBeTruthy();
    expect(account.password).not.toContain(OWNER.password);
  });

  it("refuses any second account", async () => {
    const response = await post("/sign-up/email", {
      name: "Second",
      email: "second@example.test",
      password: "another-long-password",
    });
    expect(response.status).toBe(403);
    expect(await db.user.count()).toBe(1);
  });
});

describe("sign-in (FND-02)", () => {
  it("rejects requests from a foreign origin", async () => {
    const response = await post(
      "/sign-in/email",
      { email: OWNER.email, password: OWNER.password },
      { origin: "http://evil.example" },
    );
    expect(response.status).toBe(403);
  });

  it("signs in with the right password and records it", async () => {
    const response = await post("/sign-in/email", { email: OWNER.email, password: OWNER.password });
    expect(response.status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "auth.login" } })).toBe(1);
  });

  it("rejects a wrong password, audits it, and rate-limits repeated attempts", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await post("/sign-in/email", { email: OWNER.email, password: "definitely-wrong-password" });
      statuses.push(response.status);
    }
    // The rejected foreign-origin attempt and the successful sign-in above already used 2 of the
    // 5 attempts per minute, so 3 more failures fit and the rest are blocked.
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    expect(await db.auditLog.count({ where: { action: "auth.login_failed" } })).toBeGreaterThanOrEqual(3);
  });
});

describe("abuse protection (Phase 10)", () => {
  it("a made-up X-Forwarded-For doesn't give a fresh rate-limit bucket", async () => {
    // The tests above used up the sign-in attempts for this computer. Through the real route, a new fake
    // client IP per guess must not help.
    const response = await authRoute(
      // NextRequest, like the real server passes (a plain Request hid a bug here once).
      new NextRequest(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify({ email: OWNER.email, password: "guess-number-seven" }),
      }),
    );
    expect(response.status).toBe(429);
  });

  it("changing the password always signs out other devices", async () => {
    const signIn = await post(
      "/sign-in/email",
      { email: OWNER.email, password: OWNER.password },
      { "x-forwarded-for": "10.1.1.1" },
    );
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await post(
      "/change-password",
      { currentPassword: OWNER.password, newPassword: "a-brand-new-long-password", revokeOtherSessions: false },
      { cookie, "x-forwarded-for": "10.1.1.1" },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("must sign out other devices");
  });
});
