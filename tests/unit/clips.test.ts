import { describe, expect, it } from "vitest";
import { originLabel } from "@/lib/clips";
import { formatTimecode, parseTimecode } from "@/lib/time";
import { snapToWords, type TranscriptWord } from "@/server/transcripts/transcript-file";

// "Did you know this?" spoken 1.0–2.6 s, then "Yes." at 4.0–4.4 s.
const WORDS: TranscriptWord[] = [
  { startMs: 1000, endMs: 1300, text: "Did" },
  { startMs: 1350, endMs: 1600, text: "you" },
  { startMs: 1650, endMs: 2000, text: "know" },
  { startMs: 2050, endMs: 2600, text: "this?" },
  { startMs: 4000, endMs: 4400, text: "Yes." },
];

describe("snapToWords (CLIP-05: never cut a word in half)", () => {
  it("extends a cut that lands mid-word to include the whole word", () => {
    const snapped = snapToWords(WORDS, 1500, 2300, 10_000); // inside "you" … inside "this?"
    expect(snapped.startMs).toBeLessThanOrEqual(1350);
    expect(snapped.startMs).toBeGreaterThanOrEqual(1300); // never reaches into "Did"
    expect(snapped.endMs).toBeGreaterThanOrEqual(2600);
    expect(snapped.endMs).toBeLessThanOrEqual(4000); // never reaches into "Yes."
    expect(snapped.text).toBe("you know this?");
  });

  it("keeps requested silence before and after the words", () => {
    const snapped = snapToWords(WORDS, 500, 3500, 10_000);
    expect(snapped).toMatchObject({ startMs: 500, endMs: 3500, text: "Did you know this?" });
  });

  it("refuses ranges without speech and clips that are too long", () => {
    expect(() => snapToWords(WORDS, 2700, 3900, 10_000)).toThrow(/No speech/);
    const long = Array.from({ length: 400 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: "w" }));
    expect(() => snapToWords(long, 0, 300_000, 400_000)).toThrow(/at most 3 minutes/);
  });
});

describe("timecodes", () => {
  it.each([
    [0, "0:00.0"],
    [65_500, "1:05.5"],
    [3_723_400, "1:02:03.4"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatTimecode(ms)).toBe(text);
  });

  it.each([
    ["75.5", 75_500],
    ["1:15.5", 75_500],
    ["1:02:03", 3_723_000],
    ["abc", null],
    ["1:-2", null],
    ["", null],
  ])("parses %j", (input, expected) => {
    expect(parseTimecode(input)).toBe(expected);
  });
});

describe("origin labels (results are never presented as AI unless they are)", () => {
  it("names the model for AI, and says when no AI was used", () => {
    expect(originLabel({ origin: "ai", provider: "ollama", model: "qwen2.5:1.5b" })).toBe("AI · qwen2.5:1.5b");
    expect(originLabel({ origin: "heuristic", provider: null, model: null })).toBe("Speech patterns (no AI)");
    expect(originLabel({ origin: "manual", provider: null, model: null })).toBe("Chosen by you");
  });
});
