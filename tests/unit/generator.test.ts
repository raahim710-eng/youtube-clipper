import { describe, expect, it } from "vitest";
import { isAllowedDownload, stockCandidateSchema } from "@/lib/generator/stock";
import {
  creditsText,
  estimateMs,
  frameCaptionStyle,
  frameSize,
  sceneOffsets,
  timelineCaptions,
  totalDurationMs,
} from "@/lib/generator/timeline";
import { DEFAULT_CAPTION_STYLE, renderStyle } from "@/lib/shorts/caption-style";

describe("generated video timeline (GEN-05)", () => {
  it("sizes frames by shape and resolution, always even", () => {
    expect(frameSize("9:16", 1080)).toEqual({ width: 1080, height: 1920 });
    expect(frameSize("16:9", 1080)).toEqual({ width: 1920, height: 1080 });
    expect(frameSize("9:16", 720)).toEqual({ width: 720, height: 1280 });
    expect(frameSize("16:9", 720)).toEqual({ width: 1280, height: 720 });
  });

  it("places scenes back to back and adds the final transition", () => {
    const scenes = [{ durationMs: 2000 }, { durationMs: 1500 }, { durationMs: 3000 }];
    expect(sceneOffsets(scenes)).toEqual([0, 2000, 3500]);
    expect(totalDurationMs(scenes)).toBe(6900);
    expect(totalDurationMs([{ durationMs: 2000 }])).toBe(2000);
    expect(estimateMs(Array(150).fill("word").join(" "))).toBe(60_000);
  });

  it("builds captions from each scene's word timings, shifted to its place and never crossing scenes", () => {
    const captions = timelineCaptions(
      [
        {
          durationMs: 1000,
          words: [
            [100, 400, "Hello"],
            [400, 900, "there."],
          ],
        },
        {
          durationMs: 2000,
          words: [
            [50, 300, "The"],
            [300, 700, "ocean"],
            [700, 1100, "is"],
            [1100, 2500, "salty."],
          ],
        },
      ],
      { ...DEFAULT_CAPTION_STYLE, uppercase: false },
    );
    expect(captions.map((c) => c.text)).toEqual(["Hello there.", "The ocean is", "salty."]);
    expect(captions[0]).toMatchObject({ startMs: 100 });
    expect(captions[0].endMs).toBeLessThanOrEqual(1000);
    expect(captions[1].startMs).toBe(1050);
    expect(captions.at(-1)?.endMs).toBeLessThanOrEqual(3000); // a word past the audio is clipped
  });

  it("uppercases captions when the style says so", () => {
    const captions = timelineCaptions([{ durationMs: 800, words: [[0, 500, "salt"]] }], {
      ...DEFAULT_CAPTION_STYLE,
      uppercase: true,
    });
    expect(captions[0].text).toBe("SALT");
  });

  it("scales caption sizes to the frame and keeps the position percentage", () => {
    const base = renderStyle(DEFAULT_CAPTION_STYLE);
    expect(frameCaptionStyle(DEFAULT_CAPTION_STYLE, 1080, 1920)).toEqual(base);
    const small = frameCaptionStyle(DEFAULT_CAPTION_STYLE, 720, 1280);
    expect(small.fontSize).toBe(Math.round(base.fontSize * (720 / 1080)));
    expect(small.centerY).toBe(Math.round((1280 * DEFAULT_CAPTION_STYLE.positionY) / 100));
    const wide = frameCaptionStyle(DEFAULT_CAPTION_STYLE, 1920, 1080);
    expect(wide.fontSize).toBe(base.fontSize);
    expect(wide.centerY).toBe(Math.round((1080 * DEFAULT_CAPTION_STYLE.positionY) / 100));
  });
});

describe("credits (GEN-06)", () => {
  it("lists each stock creator once with the licence, own footage and the synthetic voice", () => {
    const pexels = {
      kind: "stock" as const,
      provider: "pexels",
      creatorName: "Ana",
      pageUrl: "https://www.pexels.com/video/1/",
      licenseName: "Pexels License",
    };
    const text = creditsText([pexels, pexels, { kind: "library" }], {
      provider: "sapi",
      name: "Microsoft Zira Desktop",
    });
    expect(text.split("\n")).toEqual([
      "Credits",
      "Video by Ana on Pexels: https://www.pexels.com/video/1/",
      "Stock footage used under the Pexels License.",
      "Some footage is the creator's own.",
      "Narration: synthetic voice (Microsoft Zira Desktop, a Windows text-to-speech voice).",
    ]);
  });
});

describe("stock candidates (GEN-04)", () => {
  const candidate = {
    provider: "pexels",
    providerAssetId: "123",
    pageUrl: "https://www.pexels.com/video/123/",
    creatorName: "Ana",
    creatorUrl: null,
    downloadUrl: "https://videos.pexels.com/video-files/123/hd.mp4",
    previewImageUrl: "https://images.pexels.com/videos/123/x.jpg",
    width: 1080,
    height: 1920,
    durationMs: 12_000,
    licenseName: "Pexels License",
    filePath: "stock-cache/pexels/123.mp4",
  };

  it("accepts files from the providers' own hosts only", () => {
    expect(stockCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(stockCandidateSchema.safeParse({ ...candidate, downloadUrl: "https://evil.example/x.mp4" }).success).toBe(
      false,
    );
    expect(
      stockCandidateSchema.safeParse({ ...candidate, downloadUrl: "http://videos.pexels.com/x.mp4" }).success,
    ).toBe(false);
    expect(isAllowedDownload("pixabay", "https://cdn.pixabay.com/video/x.mp4")).toBe(true);
    expect(isAllowedDownload("pixabay", "https://videos.pexels.com/x.mp4")).toBe(false);
  });

  it("only allows the expected cache path", () => {
    expect(stockCandidateSchema.safeParse({ ...candidate, filePath: "videos/x/source.mp4" }).success).toBe(false);
    expect(stockCandidateSchema.safeParse({ ...candidate, providerAssetId: "../x" }).success).toBe(false);
    expect(stockCandidateSchema.safeParse({ ...candidate, filePath: null }).success).toBe(true);
  });
});
