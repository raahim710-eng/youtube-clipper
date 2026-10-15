import type { ClipOrigin } from "./constants";

/** Honest label for where a clip came from — AI output is always named with its model. */
export function originLabel(clip: { origin: ClipOrigin; provider: string | null; model: string | null }): string {
  if (clip.origin === "ai") return `AI · ${clip.model ?? clip.provider ?? "unknown model"}`;
  if (clip.origin === "heuristic") return "Speech patterns (no AI)";
  return "Chosen by you";
}
