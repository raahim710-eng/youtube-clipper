import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { listUserSessions, revokeUserSession } from "@/server/services/sessions";
import { getSystemStatus } from "@/server/services/system-status";

async function createUserWithSessions(email: string, count: number) {
  const user = await db.user.create({ data: { id: randomUUID(), name: email, email } });
  const sessions = [];
  for (let index = 0; index < count; index += 1) {
    sessions.push(
      await db.session.create({
        data: {
          id: randomUUID(),
          userId: user.id,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 86_400_000),
          userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0",
        },
      }),
    );
  }
  return { user, sessions };
}

describe("session management", () => {
  let alice: Awaited<ReturnType<typeof createUserWithSessions>>;
  let bob: Awaited<ReturnType<typeof createUserWithSessions>>;

  beforeAll(async () => {
    await db.user.deleteMany();
    alice = await createUserWithSessions("alice@example.test", 2);
    bob = await createUserWithSessions("bob@example.test", 1);
  });

  it("lists only the user's own sessions and marks the current one", async () => {
    const list = await listUserSessions(alice.user.id, alice.sessions[0].id);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.isCurrent)?.id).toBe(alice.sessions[0].id);
    expect(list[0]).not.toHaveProperty("token");
  });

  it("won't revoke the current session", async () => {
    await expect(revokeUserSession(alice.user.id, alice.sessions[0].id, alice.sessions[0].id)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("won't revoke another user's session", async () => {
    await expect(revokeUserSession(alice.user.id, bob.sessions[0].id, alice.sessions[0].id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await db.session.count({ where: { id: bob.sessions[0].id } })).toBe(1);
  });

  it("revokes another of the user's own sessions and audits it", async () => {
    await revokeUserSession(alice.user.id, alice.sessions[1].id, alice.sessions[0].id);
    expect(await db.session.count({ where: { userId: alice.user.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "auth.session_revoked", userId: alice.user.id } })).toBe(1);
  });
});

describe("system status (FND-06)", () => {
  it("reports core checks as OK and explains missing tools", async () => {
    const status = await getSystemStatus({ fresh: true });
    const byId = Object.fromEntries(status.groups.flatMap((g) => g.checks).map((c) => [c.id, c]));

    expect(byId.database.status).toBe("ok");
    expect(byId.storage.status).toBe("ok");
    expect(byId.auth.status).toBe("ok");
    expect(byId["worker-secret"].status).toBe("ok");
    // The test setup points FFmpeg at a missing file: required from Phase 3, so it's an error now.
    expect(byId.ffmpeg.status).toBe("error");
    expect(byId.ffmpeg.hint).toContain("winget install Gyan.FFmpeg");
    // No worker has checked in during tests; uploads still work, so it's only a warning.
    expect(byId["media-worker"].status).toBe("warning");
    expect(byId.ollama.status).toBe("info");
    expect(status.counts.error).toBe(2); // ffmpeg + ffprobe
  });

  it("never exposes secret values", async () => {
    const status = await getSystemStatus({ fresh: true });
    expect(JSON.stringify(status)).not.toContain(process.env.BETTER_AUTH_SECRET);
  });
});
