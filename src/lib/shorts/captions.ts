import { z } from "zod";

/**
 * Caption chunks for Shorts (SHORT-04, TECHNICAL_SPEC.md §7.3). Pure functions shared by the editor
 * (instant updates while trimming) and the server (validation before saving and exporting).
 * All times are in source-video milliseconds.
 */

export type Caption = { startMs: number; endMs: number; text: string };
export type CaptionWord = { startMs: number; endMs: number; text: string };

export const CAPTION_MAX_WORDS = 4;
export const CAPTION_MAX_CHARS = 18;
export const CAPTION_TEXT_MAX = 200;
export const CAPTIONS_MAX = 2_000;
/** A pause longer than this starts a new caption. */
const PAUSE_BREAK_MS = 500;
/** Gaps up to this long are bridged, so captions don't flicker off between phrases. */
const BRIDGE_GAP_MS = 1_000;
/** How long a caption stays after its last word when nothing follows soon. */
const LINGER_MS = 300;
const MIN_CAPTION_MS = 100;

export const captionSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().max(CAPTION_TEXT_MAX),
});
export const captionsSchema = z.array(captionSchema).max(CAPTIONS_MAX);

/** Words whose middle falls inside the range — a word cut by a boundary belongs to the side it mostly lies on. */
export function wordsInRange(words: CaptionWord[], startMs: number, endMs: number): CaptionWord[] {
  return words.filter((word) => {
    const middle = (word.startMs + word.endMs) / 2;
    return middle >= startMs && middle < endMs && word.text.trim().length > 0;
  });
}

function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text);
}

function endsClause(text: string): boolean {
  return /[,;:]$/.test(text);
}

/** Groups the transcript words in [startMs, endMs) into short captions: 1–4 words, at most ~18 characters. */
export function buildCaptions(words: CaptionWord[], startMs: number, endMs: number): Caption[] {
  const chunks: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const word of wordsInRange(words, startMs, endMs)) {
    const previous = current.at(-1);
    if (previous) {
      const joined = [...current, word].map((w) => w.text.trim()).join(" ");
      const previousText = previous.text.trim();
      const breakHere =
        current.length >= CAPTION_MAX_WORDS ||
        joined.length > CAPTION_MAX_CHARS ||
        word.startMs - previous.endMs > PAUSE_BREAK_MS ||
        endsSentence(previousText) ||
        (endsClause(previousText) && current.length >= 2);
      if (breakHere) {
        chunks.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) chunks.push(current);

  const captions = chunks.map((chunk, index): Caption => {
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const nextStart = chunks[index + 1]?.[0].startMs;
    let end = last.endMs + LINGER_MS;
    if (nextStart !== undefined) end = nextStart - last.endMs <= BRIDGE_GAP_MS ? nextStart : Math.min(end, nextStart);
    return {
      startMs: Math.max(startMs, first.startMs),
      endMs: Math.min(endMs, end),
      text: chunk.map((w) => w.text.trim()).join(" "),
    };
  });
  return normalizeCaptions(captions, startMs, endMs);
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, CAPTION_TEXT_MAX);
}

/**
 * Makes captions safe to save and render: text trimmed, times rounded and kept inside the range,
 * sorted, no overlaps (an earlier caption ends where the next one starts), empty or tiny ones dropped.
 */
export function normalizeCaptions(captions: Caption[], startMs: number, endMs: number): Caption[] {
  const sorted = captions
    .map((caption) => ({
      startMs: Math.round(Math.max(startMs, caption.startMs)),
      endMs: Math.round(Math.min(endMs, caption.endMs)),
      text: cleanText(caption.text),
    }))
    .filter((caption) => caption.text.length > 0 && caption.endMs - caption.startMs >= MIN_CAPTION_MS)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const result: Caption[] = [];
  for (const caption of sorted) {
    const previous = result.at(-1);
    if (previous && previous.endMs > caption.startMs) {
      previous.endMs = caption.startMs;
      if (previous.endMs - previous.startMs < MIN_CAPTION_MS) result.pop();
    }
    result.push({ ...caption });
  }
  return result.slice(0, CAPTIONS_MAX);
}

/**
 * After a trim: keeps (and clips) the captions the user already has inside the new range and adds
 * automatic captions only for newly included parts, so text edits survive range changes.
 */
export function mergeCaptionsForRange(
  existing: Caption[],
  words: CaptionWord[],
  previous: { startMs: number; endMs: number },
  next: { startMs: number; endMs: number },
): Caption[] {
  const kept = normalizeCaptions(existing, next.startMs, next.endMs);
  const before =
    next.startMs < previous.startMs ? buildCaptions(words, next.startMs, Math.min(previous.startMs, next.endMs)) : [];
  const after =
    next.endMs > previous.endMs ? buildCaptions(words, Math.max(previous.endMs, next.startMs), next.endMs) : [];
  return normalizeCaptions([...before, ...kept, ...after], next.startMs, next.endMs);
}

export function captionAt(captions: Caption[], ms: number): Caption | null {
  return captions.find((caption) => caption.startMs <= ms && ms < caption.endMs) ?? null;
}
