import { z } from "zod";
import type { AspectRatio } from "@/lib/constants";
import { type Caption, type CaptionWord, buildCaptions } from "@/lib/shorts/captions";
import {
  type CaptionStyle,
  captionText,
  FRAME_WIDTH,
  type RenderTextStyle,
  renderStyle,
} from "@/lib/shorts/caption-style";

/**
 * Pure helpers for generated videos (GEN-05, TECHNICAL_SPEC.md §7.7), shared by the server and the workspace UI.
 * Scene k's narration starts at the sum of the narration lengths before it; the crossfade into the next scene
 * happens during the extra `TRANSITION_MS` each segment carries, so captions stay in sync with the voice.
 */

export const TRANSITION_MS = 400;
export const WORDS_PER_MINUTE = 150;

export function frameSize(aspectRatio: AspectRatio, resolution: number): { width: number; height: number } {
  const long = Math.round((resolution * 16) / 9 / 2) * 2;
  return aspectRatio === "9:16" ? { width: resolution, height: long } : { width: long, height: resolution };
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** How long the narration of `text` is expected to take at ~150 words per minute. */
export function estimateMs(text: string): number {
  return Math.round((wordCount(text) / WORDS_PER_MINUTE) * 60_000);
}

/** Word timings stored per scene: [startMs, endMs, word], relative to the scene's audio. */
export const wordTimingsSchema = z.array(z.tuple([z.number().int(), z.number().int(), z.string().max(200)])).max(3000);
export type WordTiming = z.infer<typeof wordTimingsSchema>[number];

export type TimelineScene = { durationMs: number; words: WordTiming[] };

/** Where each scene starts in the finished video. */
export function sceneOffsets(scenes: { durationMs: number }[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const scene of scenes) {
    offsets.push(at);
    at += scene.durationMs;
  }
  return offsets;
}

/** Narration plus the final transition (the last frame holds while the audio ends). */
export function totalDurationMs(scenes: { durationMs: number }[]): number {
  const narration = scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
  return narration + (scenes.length > 1 ? TRANSITION_MS : 0);
}

/** Captions over the whole video, built from every scene's word timings and never crossing a scene boundary. */
export function timelineCaptions(scenes: TimelineScene[], style: CaptionStyle): Caption[] {
  const offsets = sceneOffsets(scenes);
  return scenes.flatMap((scene, index) => {
    const offset = offsets[index];
    const words: CaptionWord[] = scene.words
      .map(([startMs, endMs, text]) => ({
        startMs: offset + Math.max(0, Math.min(startMs, scene.durationMs)),
        endMs: offset + Math.max(0, Math.min(endMs, scene.durationMs)),
        text,
      }))
      .filter((word) => word.endMs > word.startMs);
    return buildCaptions(words, offset, offset + scene.durationMs).map((caption) => ({
      ...caption,
      text: captionText(caption.text, style),
    }));
  });
}

/**
 * Caption styles are designed on the 1080×1920 Shorts frame. For other frames the sizes scale with the
 * short side and the position keeps its percentage, so captions look the same in 720p and in 16:9.
 */
export function frameCaptionStyle(style: CaptionStyle, width: number, height: number): RenderTextStyle {
  const base = renderStyle(style);
  const scale = Math.min(width, height) / FRAME_WIDTH;
  return {
    ...base,
    fontSize: Math.max(20, Math.round(base.fontSize * scale)),
    outline: Math.round(base.outline * scale),
    marginX: Math.round(base.marginX * scale),
    centerY: Math.round((height * style.positionY) / 100),
  };
}

export type CreditSource =
  | { kind: "stock"; provider: string; creatorName: string; pageUrl: string; licenseName: string }
  | { kind: "library" | "upload" };

const PROVIDER_NAMES: Record<string, string> = { pexels: "Pexels", pixabay: "Pixabay" };

/**
 * Credits for the description (GEN-06): every stock clip with its creator and licence page, and how the
 * narration was made. Attribution isn't required by the Pexels or Pixabay licences, but it is good practice.
 */
export function creditsText(sources: CreditSource[], voice: { provider: string; name: string | null }): string {
  const stock = new Map<string, Extract<CreditSource, { kind: "stock" }>>();
  for (const source of sources) {
    if (source.kind === "stock") stock.set(source.pageUrl, source);
  }
  const own = sources.some((source) => source.kind !== "stock");
  const lines: string[] = ["Credits"];
  for (const clip of stock.values()) {
    lines.push(`Video by ${clip.creatorName} on ${PROVIDER_NAMES[clip.provider] ?? clip.provider}: ${clip.pageUrl}`);
  }
  const licences = [...new Set([...stock.values()].map((clip) => clip.licenseName))];
  if (licences.length > 0) lines.push(`Stock footage used under the ${licences.join(" and ")}.`);
  if (own) lines.push("Some footage is the creator's own.");
  const voiceName =
    voice.provider === "sapi" ? "a Windows text-to-speech voice" : `the ${voice.provider} text-to-speech model`;
  lines.push(`Narration: synthetic voice (${voice.name ? `${voice.name}, ` : ""}${voiceName}).`);
  return lines.join("\n");
}
