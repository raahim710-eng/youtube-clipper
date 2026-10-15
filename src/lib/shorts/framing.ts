import type { ReframeMode } from "@/lib/constants";

/**
 * 9:16 framing geometry. Mirrors media-worker/src/media_worker/shorts/framing.py, which renders it with
 * FFmpeg; the editor previews the same crop with CSS (SHORT-03, SHORT-06).
 */

export const TARGET_ASPECT = 9 / 16;

export type CropKeyframe = { tMs: number; x: number };

export type CropBox = { width: number; height: number; y: number; horizontal: boolean };

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function cropBox(sourceWidth: number, sourceHeight: number): CropBox {
  if (sourceWidth / sourceHeight > TARGET_ASPECT) {
    return { width: even(sourceHeight * TARGET_ASPECT), height: even(sourceHeight), y: 0, horizontal: true };
  }
  const height = even(sourceWidth / TARGET_ASPECT);
  return {
    width: even(sourceWidth),
    height,
    y: sourceHeight > height ? even((sourceHeight - height) / 2) : 0,
    horizontal: false,
  };
}

/** Whether side-to-side framing matters (false for sources that are already vertical). */
export function needsHorizontalFraming(sourceWidth: number, sourceHeight: number): boolean {
  return sourceWidth / sourceHeight > TARGET_ASPECT + 0.01;
}

/** Crop centre (0–1 of the source width) at a time, interpolated between keyframes. */
export function centerAt(keyframes: CropKeyframe[], ms: number): number {
  if (keyframes.length === 0) return 0.5;
  if (ms <= keyframes[0].tMs) return keyframes[0].x;
  for (let i = 1; i < keyframes.length; i += 1) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (ms < b.tMs) {
      const span = b.tMs - a.tMs;
      return span > 0 ? a.x + ((b.x - a.x) * (ms - a.tMs)) / span : b.x;
    }
  }
  return keyframes[keyframes.length - 1].x;
}

/** Keyframes for the export, relative to the Short's start (what the worker's crop expression uses). */
export function relativeKeyframes(keyframes: CropKeyframe[], startMs: number, endMs: number): CropKeyframe[] {
  const inside = keyframes.filter((k) => k.tMs > startMs && k.tMs < endMs);
  const points = [
    { tMs: startMs, x: centerAt(keyframes, startMs) },
    ...inside,
    { tMs: endMs, x: centerAt(keyframes, endMs) },
  ];
  return points.map((k) => ({ tMs: k.tMs - startMs, x: Math.round(k.x * 10_000) / 10_000 }));
}

/** Keyframes describing the crop for a mode at the current settings (blur has none). */
export function framingKeyframes(
  mode: ReframeMode,
  options: { manualX: number; autoKeyframes: CropKeyframe[] | null },
): CropKeyframe[] {
  if (mode === "manual") return [{ tMs: 0, x: options.manualX }];
  if (mode === "auto") return options.autoKeyframes ?? [{ tMs: 0, x: 0.5 }];
  return [{ tMs: 0, x: 0.5 }];
}

/**
 * CSS for the source video inside a 9:16 preview box so it shows exactly the cropped area:
 * the video is scaled so the crop fills the box and shifted left by the crop's offset.
 */
export function previewVideoLayout(
  sourceWidth: number,
  sourceHeight: number,
  center: number,
): { widthPct: number; leftPct: number; topPct: number } {
  const box = cropBox(sourceWidth, sourceHeight);
  const left = box.horizontal
    ? Math.min(Math.max(center * sourceWidth - box.width / 2, 0), sourceWidth - box.width)
    : 0;
  return {
    widthPct: (sourceWidth / box.width) * 100,
    leftPct: -(left / box.width) * 100,
    topPct: -(box.y / box.height) * 100,
  };
}
