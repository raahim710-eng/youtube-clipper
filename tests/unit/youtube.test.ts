import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cleanTags, publishProblems, type PublishInput, tagsLength } from "@/lib/youtube/publish";
import { DecryptionError, decryptSecret, encryptSecret, readEncryptionKey } from "@/server/crypto";
import { nextQuotaReset, quotaDay } from "@/server/youtube/quota";

describe("token encryption (SECURITY.md §3.3)", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh IV every time", () => {
    const a = encryptSecret("1//refresh-token-value", key);
    const b = encryptSecret("1//refresh-token-value", key);
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("refresh-token-value");
    expect(decryptSecret(a, key)).toBe("1//refresh-token-value");
  });

  it("fails on tampering or a wrong key instead of returning garbage", () => {
    const sealed = encryptSecret("secret", key);
    const parts = sealed.split(":");
    const ciphertext = Buffer.from(parts[3], "base64");
    ciphertext[0] ^= 1;
    expect(() => decryptSecret([...parts.slice(0, 3), ciphertext.toString("base64")].join(":"), key)).toThrow(
      DecryptionError,
    );
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow(DecryptionError);
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow(DecryptionError);
  });

  it("only accepts a 32-byte base64 key", () => {
    expect(readEncryptionKey("")).toEqual({ problem: "TOKEN_ENCRYPTION_KEY is not set." });
    expect("problem" in readEncryptionKey(randomBytes(16).toString("base64"))).toBe(true);
    expect("problem" in readEncryptionKey("not base64 at all!!")).toBe(true);
    expect("key" in readEncryptionKey(randomBytes(32).toString("base64"))).toBe(true);
  });
});

const input: PublishInput = {
  kind: "short",
  targetId: "s1",
  channelId: "c1",
  title: "My Short",
  description: "About it.",
  tags: ["editing"],
  categoryId: "22",
  privacyStatus: "private",
  publishAt: null,
  madeForKids: false,
  containsSyntheticMedia: false,
  thumbnailId: null,
};
const short = { kind: "short" as const, fileReady: true, durationMs: 60_000, width: 1080, height: 1920 };

describe("checks before uploading (YT-08, YT-05)", () => {
  it("accepts a complete private Short", () => {
    expect(publishProblems(input, short, { audited: false })).toEqual([]);
  });

  it("rejects a 4-minute or horizontal Short, and a missing export", () => {
    expect(publishProblems(input, { ...short, durationMs: 240_000 }, { audited: true })).toEqual([
      "A Short can be at most 3 minutes long. Trim it in the Shorts Editor.",
    ]);
    expect(publishProblems(input, { ...short, width: 1920, height: 1080 }, { audited: true })).toEqual([
      "A Short must be vertical or square. Export it from the Shorts Editor.",
    ]);
    expect(publishProblems(input, { ...short, fileReady: false }, { audited: true })[0]).toMatch(
      /Export the Short first/,
    );
    // Long-form videos may be any shape or length.
    expect(
      publishProblems(
        { ...input, kind: "video" },
        { ...short, kind: "video", width: 1920, height: 1080, durationMs: 3_600_000 },
        { audited: true },
      ),
    ).toEqual([]);
  });

  it("needs the required answers and valid fields", () => {
    const problems = publishProblems(
      { ...input, title: " ", categoryId: "999", madeForKids: null, containsSyntheticMedia: null, description: "<b>" },
      short,
      { audited: true },
    );
    expect(problems).toEqual([
      "Add a title.",
      "Remove < and > from the title and description — YouTube doesn't allow them.",
      "Choose a category.",
      "Answer whether the video is made for kids (YouTube requires it).",
      "Answer whether the video contains realistic altered or AI-made content.",
    ]);
  });

  it("allows only private uploads and no scheduling until the project is audited", () => {
    expect(publishProblems({ ...input, privacyStatus: "public" }, short, { audited: false })).toEqual([
      "Until your Google Cloud project passes YouTube's API audit, uploads are private only.",
    ]);
    const now = Date.parse("2026-10-14T12:00:00Z");
    const soon = { ...input, publishAt: "2026-10-14T12:05:00.000Z" };
    const later = { ...input, publishAt: "2026-10-15T09:00:00.000Z" };
    expect(publishProblems(later, short, { audited: false, now })).toEqual([
      "Scheduling is available after your Google Cloud project passes YouTube's API audit.",
    ]);
    expect(publishProblems(soon, short, { audited: true, now })).toEqual(["Schedule at least 15 minutes from now."]);
    expect(publishProblems(later, short, { audited: true, now })).toEqual([]);
  });

  it("counts tags like YouTube: commas and quotes around tags with spaces", () => {
    expect(tagsLength(["a", "b c"])).toBe(1 + 1 + 3 + 2);
    expect(cleanTags(["#Editing", "editing", " video  tips ", "<x>", ""])).toEqual(["Editing", "video tips", "x"]);
    const tooMany = Array.from({ length: 60 }, (_, i) => `tag number ${i}`);
    expect(publishProblems({ ...input, tags: tooMany }, short, { audited: true })).toContain(
      "The tags are longer than 500 characters in total.",
    );
  });
});

describe("quota day (YT-07)", () => {
  it("uses Pacific time and resets at midnight there", () => {
    // 06:30 UTC on 14 Oct = 23:30 on 13 Oct in California (PDT, UTC−7).
    const late = new Date("2026-10-14T06:30:00Z");
    expect(quotaDay(late)).toBe("2026-10-13");
    expect(nextQuotaReset(late).toISOString()).toBe("2026-10-14T07:00:00.000Z");
    expect(quotaDay(new Date("2026-10-14T07:00:01Z"))).toBe("2026-10-14");
    // Winter time (PST, UTC−8).
    expect(nextQuotaReset(new Date("2026-12-01T12:00:00Z")).toISOString()).toBe("2026-12-02T08:00:00.000Z");
  });
});
