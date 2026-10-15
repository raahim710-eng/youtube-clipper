import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "@/server/logger";

describe("redact (SECURITY.md §6)", () => {
  it("hides values of sensitive keys at any depth", () => {
    const result = redact({
      user: "owner",
      password: "hunter2-hunter2",
      nested: { refreshToken: "abc", apiKey: "k", API_KEY: "k2", list: [{ authorization: "Bearer x" }] },
      cookie: "session=1",
    });
    expect(result).toEqual({
      user: "owner",
      password: REDACTED,
      nested: { refreshToken: REDACTED, apiKey: REDACTED, API_KEY: REDACTED, list: [{ authorization: REDACTED }] },
      cookie: REDACTED,
    });
  });

  it("keeps errors readable", () => {
    const result = redact({ error: new Error("boom") }) as { error: { message: string } };
    expect(result.error.message).toBe("boom");
  });
});

describe("secrets inside text (Phase 10)", () => {
  it("masks keys and tokens in messages, stacks and error causes", () => {
    const cause = new Error("POST https://oauth2.googleapis.com/token?code=4/abc-def&client_secret=GOCSPX-xyz failed");
    const error = new Error("Authorization: Bearer ya29.a0AfH6SMBlongtokenvalue rejected", { cause });
    const out = JSON.stringify(redact({ error, note: "https://pixabay.com/api/videos/?key=12345-abcdef&q=sea" }));
    for (const secret of ["4/abc-def", "GOCSPX-xyz", "ya29.a0AfH6SMBlongtokenvalue", "12345-abcdef"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("q=sea");
    expect(out).toContain("[redacted]");
  });
});
