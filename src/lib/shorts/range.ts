import { CLIP_MAX_MS, CLIP_MIN_MS } from "@/lib/constants";
import type { CaptionWord } from "./captions";

/** Trimming helpers for the Shorts editor timeline (SHORT-02). Times are source-video milliseconds. */

export type Range = { startMs: number; endMs: number };

/**
 * A trim point inside a word moves outwards to include the whole word, so a Short never starts
 * or ends half-way through a word. Points in silence stay exactly where they are.
 */
export function snapOutOfWords(words: CaptionWord[], ms: number, side: "start" | "end"): number {
  const word = words.find((w) => w.startMs < ms && ms < w.endMs);
  if (!word) return ms;
  return side === "start" ? word.startMs : word.endMs;
}

/** Keeps a range inside the allowed area and between 1 second and 3 minutes long. */
export function clampRange(range: Range, bounds: Range, moving: "start" | "end" | "both" = "both"): Range {
  let startMs = Math.round(Math.max(bounds.startMs, Math.min(range.startMs, bounds.endMs - CLIP_MIN_MS)));
  let endMs = Math.round(Math.min(bounds.endMs, Math.max(range.endMs, bounds.startMs + CLIP_MIN_MS)));
  if (endMs - startMs < CLIP_MIN_MS) {
    if (moving === "start") startMs = endMs - CLIP_MIN_MS;
    else endMs = startMs + CLIP_MIN_MS;
  }
  if (endMs - startMs > CLIP_MAX_MS) {
    if (moving === "start") endMs = startMs + CLIP_MAX_MS;
    else startMs = endMs - CLIP_MAX_MS;
  }
  return { startMs, endMs };
}

/** The final range after a trim: snapped out of words, then clamped. */
export function commitTrim(words: CaptionWord[], range: Range, bounds: Range, moving: "start" | "end" | "both"): Range {
  return clampRange(
    { startMs: snapOutOfWords(words, range.startMs, "start"), endMs: snapOutOfWords(words, range.endMs, "end") },
    bounds,
    moving,
  );
}
