import { describe, expect, it } from "vitest";
import { getAuthConfigProblems, getEnv } from "@/server/env";

const strongSecret = "s".repeat(40);

describe("getAuthConfigProblems", () => {
  it("reports a missing auth secret", () => {
    const problems = getAuthConfigProblems({ NODE_ENV: "test" });
    expect(problems.map((p) => p.variable)).toContain("BETTER_AUTH_SECRET");
  });

  it("reports a too-short auth secret", () => {
    const problems = getAuthConfigProblems({ NODE_ENV: "test", BETTER_AUTH_SECRET: "short" });
    expect(problems[0]?.message).toMatch(/too short/i);
  });

  it("reports a non-SQLite database URL", () => {
    const problems = getAuthConfigProblems({
      NODE_ENV: "test",
      BETTER_AUTH_SECRET: strongSecret,
      DATABASE_URL: "postgres://localhost/db",
    });
    expect(problems.map((p) => p.variable)).toEqual(["DATABASE_URL"]);
  });

  it("returns no problems for a valid configuration", () => {
    expect(getAuthConfigProblems({ NODE_ENV: "test", BETTER_AUTH_SECRET: strongSecret })).toEqual([]);
  });

  it("explains invalid formats instead of crashing", () => {
    const problems = getAuthConfigProblems({ NODE_ENV: "test", BETTER_AUTH_URL: "not a url" });
    expect(problems[0]?.variable).toBe(".env");
    expect(problems[0]?.message).toContain("BETTER_AUTH_URL");
  });
});

describe("getEnv defaults", () => {
  it("fills in documented defaults and treats empty strings as unset", () => {
    const env = getEnv({ NODE_ENV: "test", FFMPEG_PATH: "", OLLAMA_MODEL: "  " });
    expect(env.DATABASE_URL).toBe("file:./data/app.db");
    expect(env.STORAGE_DIR).toBe("./storage");
    expect(env.FFMPEG_PATH).toBeUndefined();
    expect(env.OLLAMA_MODEL).toBeUndefined();
    expect(env.NEXT_PUBLIC_APP_NAME).not.toMatch(/youtube/i); // DECISIONS.md D-021
  });
});
