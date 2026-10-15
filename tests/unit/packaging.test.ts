import { describe, expect, it } from "vitest";
import {
  byteCount,
  charCount,
  cleanDescription,
  cleanHashtags,
  cleanHeadline,
  cleanTitle,
  DESCRIPTION_MAX_BYTES,
  normalizeHashtag,
  packagingText,
} from "@/lib/packaging/limits";

describe("YouTube limits (PKG-02)", () => {
  it("keeps titles to 100 characters without < or >", () => {
    expect(cleanTitle("  <b>Edit</b>   faster  ")).toBe("bEdit/b faster");
    const long = "😀".repeat(120);
    expect(charCount(cleanTitle(long))).toBe(100); // emoji count as one character each
  });

  it("keeps descriptions to 5,000 bytes, counting multi-byte characters correctly", () => {
    const text = "Café ☕ 😀 ".repeat(800); // ~9,600 bytes
    const cleaned = cleanDescription(`${text}<script>`);
    expect(byteCount(cleaned)).toBeLessThanOrEqual(DESCRIPTION_MAX_BYTES);
    expect(cleaned).not.toMatch(/[<>�]/);
    expect(cleanDescription("Line one\r\nLine two")).toBe("Line one\nLine two");
  });

  it("normalises and de-duplicates hashtags", () => {
    expect(normalizeHashtag("#video editing!")).toBe("videoEditing");
    expect(normalizeHashtag("#2024")).toBeNull();
    expect(normalizeHashtag("Café")).toBe("Café");
    expect(cleanHashtags(["#Editing", "editing", "EDITING", "#Shorts", "  ", "#a b"])).toEqual([
      "Editing",
      "Shorts",
      "aB",
    ]);
    expect(cleanHashtags(Array.from({ length: 30 }, (_, i) => `tag${i}`))).toHaveLength(15);
  });

  it("keeps thumbnail headlines to 5 words", () => {
    expect(cleanHeadline("one two three four five six <seven>")).toBe("one two three four five");
  });

  it("builds the copy-all text", () => {
    expect(packagingText("Title", "Description\n", ["Editing", "Shorts"])).toBe(
      "Title\n\nDescription\n\n#Editing #Shorts",
    );
  });
});
