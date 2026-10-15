import fs from "node:fs/promises";
import { z } from "zod";
import { CLIP_MAX_MS, CLIP_MIN_MS } from "@/lib/constants";
import { AppError } from "../errors";
import { resolveStoragePath } from "../storage";

/**
 * The transcript JSON written by the media worker (media-worker/src/media_worker/jobs/transcribe.py).
 * Words are compact [startMs, endMs, text] triples.
 */
const wordSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.string()]);

export const transcriptFileSchema = z.object({
  version: z.literal(1),
  provider: z.string(),
  model: z.string().nullable().optional(),
  language: z.string().nullable(),
  languageProbability: z.number().nullable(),
  durationMs: z.number().int().nonnegative(),
  segments: z.array(
    z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
      text: z.string(),
      words: z.array(wordSchema),
    }),
  ),
  /** Loudness in dBFS per window (drawn as the Shorts editor's waveform). */
  loudness: z.object({ windowMs: z.number().int().positive(), db: z.array(z.number()) }).optional(),
});
export type TranscriptFile = z.infer<typeof transcriptFileSchema>;

export type TranscriptWord = { startMs: number; endMs: number; text: string };

export async function readTranscriptFile(relativePath: string): Promise<TranscriptFile> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveStoragePath(relativePath), "utf8");
  } catch {
    throw new AppError("NOT_FOUND", "The transcript file is missing. Transcribe the video again.");
  }
  const parsed = transcriptFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new AppError("INTERNAL", "The transcript file is damaged. Transcribe the video again.");
  return parsed.data;
}

export function transcriptWords(file: TranscriptFile): TranscriptWord[] {
  return file.segments
    .flatMap((segment) => segment.words.map(([startMs, endMs, text]) => ({ startMs, endMs, text })))
    .sort((a, b) => a.startMs - b.startMs);
}

export function transcriptFullText(file: TranscriptFile): string {
  return file.segments.map((segment) => segment.text.trim()).join(" ");
}

/**
 * Moves a requested range to whole words: the start goes to the first word that ends after it,
 * the end to the last word that starts before it — so a clip never cuts a word in half (CLIP-05).
 * Returns the snapped range (with a little padding, never overlapping neighbouring words) and its text.
 */
export function snapToWords(
  words: TranscriptWord[],
  requestedStartMs: number,
  requestedEndMs: number,
  durationMs: number,
): { startMs: number; endMs: number; text: string } {
  const first = words.findIndex((word) => word.endMs > requestedStartMs);
  let last = -1;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (words[i].startMs < requestedEndMs) {
      last = i;
      break;
    }
  }
  if (first === -1 || last === -1 || last < first) {
    throw new AppError("VALIDATION", "No speech in that range. Choose a section that contains words.");
  }
  const previousEnd = first > 0 ? words[first - 1].endMs : 0;
  const nextStart = last + 1 < words.length ? words[last + 1].startMs : durationMs;
  // Respect a request for extra lead-in/out, add a little air otherwise, never reach into neighbouring words.
  const startMs = Math.max(0, previousEnd, Math.min(requestedStartMs, words[first].startMs - 150));
  const endMs = Math.min(durationMs, nextStart, Math.max(requestedEndMs, words[last].endMs + 250));
  const finalStart = Math.min(startMs, words[first].startMs);
  const finalEnd = Math.max(endMs, words[last].endMs);

  const length = finalEnd - finalStart;
  if (length < CLIP_MIN_MS) throw new AppError("VALIDATION", "A clip must be at least 1 second long.");
  if (length > CLIP_MAX_MS) throw new AppError("VALIDATION", "A Short can be at most 3 minutes long.");
  const text = words
    .slice(first, last + 1)
    .map((word) => word.text)
    .join(" ");
  return { startMs: finalStart, endMs: finalEnd, text: text.slice(0, 4000) };
}
