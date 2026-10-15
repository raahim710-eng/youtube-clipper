import { describe, expect, it } from "vitest";
import {
  buildCaptions,
  type Caption,
  CAPTION_MAX_CHARS,
  CAPTION_MAX_WORDS,
  captionAt,
  type CaptionWord,
  mergeCaptionsForRange,
  normalizeCaptions,
} from "@/lib/shorts/captions";
import {
  CAPTION_PRESETS,
  captionStyleSchema,
  DEFAULT_CAPTION_STYLE,
  hookStyle,
  parseCaptionStyle,
  renderStyle,
} from "@/lib/shorts/caption-style";
import { centerAt, cropBox, previewVideoLayout, relativeKeyframes } from "@/lib/shorts/framing";
import { clampRange, commitTrim, snapOutOfWords } from "@/lib/shorts/range";

/** "Transcripts make editing much faster. Did you know that? Yes." with natural timings and a long pause. */
const WORDS: CaptionWord[] = [
  { startMs: 1000, endMs: 1600, text: "Transcripts" },
  { startMs: 1650, endMs: 1900, text: "make" },
  { startMs: 1950, endMs: 2400, text: "editing" },
  { startMs: 2450, endMs: 2700, text: "much" },
  { startMs: 2750, endMs: 3200, text: "faster." },
  { startMs: 3300, endMs: 3450, text: "Did" },
  { startMs: 3500, endMs: 3600, text: "you" },
  { startMs: 3650, endMs: 3900, text: "know" },
  { startMs: 3950, endMs: 4300, text: "that?" },
  { startMs: 6500, endMs: 6900, text: "Yes." }, // after a 2.2 s pause
  { startMs: 7000, endMs: 7400, text: "Supercalifragilisticexpialidocious" },
];

function expectWellFormed(captions: Caption[], startMs: number, endMs: number) {
  for (const [i, caption] of captions.entries()) {
    expect(caption.startMs).toBeGreaterThanOrEqual(startMs);
    expect(caption.endMs).toBeLessThanOrEqual(endMs);
    expect(caption.endMs).toBeGreaterThan(caption.startMs);
    if (i > 0) expect(caption.startMs).toBeGreaterThanOrEqual(captions[i - 1].endMs); // no overlaps
  }
}

describe("caption chunking (SHORT-04)", () => {
  const captions = buildCaptions(WORDS, 0, 10_000);

  it("groups 1–4 words of at most ~18 characters", () => {
    for (const caption of captions) {
      const words = caption.text.split(" ");
      expect(words.length).toBeGreaterThanOrEqual(1);
      expect(words.length).toBeLessThanOrEqual(CAPTION_MAX_WORDS);
      if (words.length > 1) expect(caption.text.length).toBeLessThanOrEqual(CAPTION_MAX_CHARS);
    }
    expect(captions.map((c) => c.text)).toEqual([
      "Transcripts make",
      "editing much",
      "faster.",
      "Did you know that?",
      "Yes.",
      "Supercalifragilisticexpialidocious",
    ]);
  });

  it("keeps captions on screen between close phrases but not across long pauses", () => {
    expectWellFormed(captions, 0, 10_000);
    expect(captions[0]).toMatchObject({ startMs: 1000, endMs: 1950 }); // bridged to the next caption
    const question = captions[3];
    expect(question.endMs).toBe(4300 + 300); // lingers briefly, then nothing during the pause
    expect(captions[4].startMs).toBe(6500);
  });

  it("only uses words inside the range and stays inside it", () => {
    const part = buildCaptions(WORDS, 2_000, 4_000);
    expectWellFormed(part, 2_000, 4_000);
    expect(part.map((c) => c.text).join(" ")).toBe("editing much faster. Did you know");
    expect(buildCaptions([], 0, 5_000)).toEqual([]);
  });
});

describe("caption clean-up and trims", () => {
  it("sorts, trims overlaps and drops empty captions", () => {
    const fixed = normalizeCaptions(
      [
        { startMs: 2000, endMs: 3000, text: "second" },
        { startMs: 500, endMs: 2500, text: "  first\r\n  line  " },
        { startMs: 3000, endMs: 3050, text: "too short" },
        { startMs: 3500, endMs: 9000, text: "   " },
        { startMs: 4000, endMs: 12_000, text: "clipped" },
      ],
      1000,
      10_000,
    );
    expect(fixed).toEqual([
      { startMs: 1000, endMs: 2000, text: "first\nline" },
      { startMs: 2000, endMs: 3000, text: "second" },
      { startMs: 4000, endMs: 10_000, text: "clipped" },
    ]);
  });

  it("keeps edited text when the range changes and adds captions for new parts only", () => {
    const original = buildCaptions(WORDS, 1000, 3300);
    const edited = original.map((c, i) => (i === 0 ? { ...c, text: "TRANSCRIPTS rule" } : c));
    const extended = mergeCaptionsForRange(
      edited,
      WORDS,
      { startMs: 1000, endMs: 3300 },
      { startMs: 1000, endMs: 4500 },
    );
    expect(extended[0].text).toBe("TRANSCRIPTS rule");
    expect(extended.at(-1)?.text).toBe("Did you know that?");
    expectWellFormed(extended, 1000, 4500);

    const trimmed = mergeCaptionsForRange(
      extended,
      WORDS,
      { startMs: 1000, endMs: 4500 },
      { startMs: 2000, endMs: 4500 },
    );
    expect(trimmed[0].startMs).toBe(2000);
    expect(trimmed.map((c) => c.text)).not.toContain("TRANSCRIPTS rule");
  });

  it("finds the caption on screen at a time", () => {
    const captions = buildCaptions(WORDS, 0, 10_000);
    expect(captionAt(captions, 1200)?.text).toBe("Transcripts make");
    expect(captionAt(captions, 5500)).toBeNull();
  });
});

describe("caption styles (SHORT-04/06)", () => {
  it("has at least four valid presets", () => {
    expect(CAPTION_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const preset of CAPTION_PRESETS) expect(captionStyleSchema.parse(preset.style)).toEqual(preset.style);
  });

  it("turns a style into the numbers the export uses", () => {
    expect(renderStyle(DEFAULT_CAPTION_STYLE)).toEqual({
      fontName: "Geist Black",
      bold: false,
      fontSize: 96,
      textColor: "#FFFFFF",
      background: "outline",
      backgroundColor: "#000000",
      backgroundAlpha: 0,
      outline: 7,
      centerY: 1344,
      marginX: 90,
    });
    const boxed = renderStyle({ ...DEFAULT_CAPTION_STYLE, background: "box", backgroundOpacity: 75, positionY: 50 });
    expect(boxed).toMatchObject({ background: "box", backgroundAlpha: 64, outline: 19, centerY: 960 });
    expect(hookStyle(DEFAULT_CAPTION_STYLE)).toMatchObject({ background: "box", positionY: 16, size: 72 });
  });

  it("falls back to the default for missing or damaged styles", () => {
    expect(parseCaptionStyle(null)).toEqual(DEFAULT_CAPTION_STYLE);
    expect(parseCaptionStyle("{not json")).toEqual(DEFAULT_CAPTION_STYLE);
    expect(parseCaptionStyle(JSON.stringify({ ...DEFAULT_CAPTION_STYLE, size: 999 }))).toEqual(DEFAULT_CAPTION_STYLE);
  });
});

describe("framing geometry (SHORT-03, same numbers as the worker)", () => {
  it("crops 16:9 to a full-height 9:16 box and leaves vertical video alone", () => {
    expect(cropBox(1920, 1080)).toEqual({ width: 606, height: 1080, y: 0, horizontal: true });
    expect(cropBox(1080, 1920)).toEqual({ width: 1080, height: 1920, y: 0, horizontal: false });
    expect(cropBox(1000, 3000)).toEqual({ width: 1000, height: 1776, y: 612, horizontal: false });
  });

  it("interpolates the crop centre and jumps at cuts", () => {
    const keyframes = [
      { tMs: 1000, x: 0.3 },
      { tMs: 3000, x: 0.5 },
      { tMs: 3000, x: 0.8 },
    ];
    expect(centerAt(keyframes, 0)).toBe(0.3);
    expect(centerAt(keyframes, 2000)).toBeCloseTo(0.4);
    expect(centerAt(keyframes, 3000)).toBe(0.8);
    expect(centerAt([], 5)).toBe(0.5);
    // Relative to the Short's start; the jump inside the range is kept.
    expect(relativeKeyframes(keyframes, 2000, 4000)).toEqual([
      { tMs: 0, x: 0.4 },
      { tMs: 1000, x: 0.5 },
      { tMs: 1000, x: 0.8 },
      { tMs: 2000, x: 0.8 },
    ]);
  });

  it("positions the preview video so exactly the crop is visible", () => {
    const left = previewVideoLayout(1920, 1080, 0);
    expect(left.leftPct).toBe(-0);
    expect(left.widthPct).toBeCloseTo((1920 / 606) * 100);
    const right = previewVideoLayout(1920, 1080, 1);
    expect(right.leftPct).toBeCloseTo((-(1920 - 606) / 606) * 100);
  });
});

describe("trimming (SHORT-02)", () => {
  const bounds = { startMs: 0, endMs: 300_000 };

  it("moves a trim point out of a word, never into silence", () => {
    expect(snapOutOfWords(WORDS, 1200, "start")).toBe(1000);
    expect(snapOutOfWords(WORDS, 1200, "end")).toBe(1600);
    expect(snapOutOfWords(WORDS, 5000, "start")).toBe(5000);
  });

  it("keeps Shorts between 1 second and 3 minutes and inside the video", () => {
    expect(clampRange({ startMs: 5000, endMs: 5200 }, bounds, "end")).toEqual({ startMs: 5000, endMs: 6000 });
    expect(clampRange({ startMs: 0, endMs: 250_000 }, bounds, "end")).toEqual({ startMs: 70_000, endMs: 250_000 });
    expect(clampRange({ startMs: -500, endMs: 400_000 }, bounds, "start")).toEqual({ startMs: 0, endMs: 180_000 });
    expect(commitTrim(WORDS, { startMs: 1200, endMs: 3100 }, bounds, "both")).toEqual({ startMs: 1000, endMs: 3200 });
  });
});
