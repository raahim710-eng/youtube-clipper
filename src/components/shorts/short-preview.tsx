"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReframeMode } from "@/lib/constants";
import { type Caption, captionAt } from "@/lib/shorts/captions";
import {
  type CaptionStyle,
  captionText,
  HOOK_DURATION_MS,
  hookStyle,
  previewTextStyle,
} from "@/lib/shorts/caption-style";
import { type CropKeyframe, centerAt, previewVideoLayout } from "@/lib/shorts/framing";

/**
 * The 9:16 preview (SHORT-02, SHORT-06). It shows the source video cropped exactly like the export:
 * same crop geometry (src/lib/shorts/framing.ts) and the same caption numbers (caption-style.ts).
 * Per-frame work (crop position, blur background, playback limit) runs in requestAnimationFrame
 * and touches the DOM directly, so the rest of the editor doesn't re-render on every frame.
 */
export function ShortPreview({
  videoRef,
  src,
  poster,
  sourceWidth,
  sourceHeight,
  mode,
  keyframes,
  captions,
  captionStyle,
  hookText,
  startMs,
  endMs,
  onTime,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  src: string;
  poster?: string;
  sourceWidth: number;
  sourceHeight: number;
  mode: ReframeMode;
  keyframes: CropKeyframe[];
  captions: Caption[] | null;
  captionStyle: CaptionStyle;
  hookText: string | null;
  startMs: number;
  endMs: number;
  onTime: (ms: number, playing: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [showHook, setShowHook] = useState(true);
  const latest = useRef({ mode, keyframes, captions, startMs, endMs, onTime, sourceWidth, sourceHeight });
  useLayoutEffect(() => {
    latest.current = { mode, keyframes, captions, startMs, endMs, onTime, sourceWidth, sourceHeight };
  });

  const layout = previewVideoLayout(sourceWidth, sourceHeight, centerAt(keyframes, startMs));
  const styles = useMemo(() => previewTextStyle(captionStyle), [captionStyle]);
  const hookStyles = useMemo(() => previewTextStyle(hookStyle(captionStyle)), [captionStyle]);

  useEffect(() => {
    let frame = 0;
    let lastCaption: Caption | null = null;
    let lastHook = true;
    let lastReport = 0;
    let lastPlaying = false;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const video = videoRef.current;
      if (!video) return;
      const current = latest.current;
      // Rounded: after a seek the browser may report a hair before the requested time.
      const ms = Math.round(video.currentTime * 1000);
      const playing = !video.paused && !video.ended;

      // Stop at the end of the Short, like the exported file.
      if (playing && ms >= current.endMs) {
        video.pause();
        video.currentTime = current.endMs / 1000;
      }
      if (current.mode !== "blur") {
        const { leftPct } = previewVideoLayout(
          current.sourceWidth,
          current.sourceHeight,
          centerAt(current.keyframes, ms),
        );
        video.style.left = `${leftPct}%`;
      } else if (canvasRef.current && video.readyState >= 2) {
        drawCover(canvasRef.current, video);
      }

      const nextCaption = current.captions ? captionAt(current.captions, ms) : null;
      if (nextCaption !== lastCaption) {
        lastCaption = nextCaption;
        setCaption(nextCaption);
      }
      const hook = ms - current.startMs < HOOK_DURATION_MS;
      if (hook !== lastHook) {
        lastHook = hook;
        setShowHook(hook);
      }
      const now = performance.now();
      if (playing !== lastPlaying || now - lastReport > 100) {
        lastReport = now;
        lastPlaying = playing;
        current.onTime(Math.round(ms), playing);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [videoRef]);

  return (
    <div
      className="@container relative mx-auto aspect-9/16 w-full overflow-hidden rounded-lg bg-black"
      data-testid="short-preview"
    >
      {mode === "blur" ? (
        <canvas
          ref={canvasRef}
          width={54}
          height={96}
          aria-hidden
          className="absolute inset-0 size-full scale-110 blur-md brightness-90"
        />
      ) : null}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        preload="auto"
        playsInline
        className={mode === "blur" ? "absolute inset-0 size-full object-contain" : "absolute h-auto max-w-none"}
        style={
          mode === "blur"
            ? undefined
            : { width: `${layout.widthPct}%`, top: `${layout.topPct}%`, left: `${layout.leftPct}%` }
        }
        onLoadedMetadata={(event) => {
          if (event.currentTarget.currentTime * 1000 < startMs) event.currentTarget.currentTime = startMs / 1000;
        }}
      />
      {caption ? (
        <div style={styles.wrapper} data-testid="preview-caption">
          <span style={styles.text}>{captionText(caption.text, captionStyle)}</span>
        </div>
      ) : null}
      {hookText && showHook ? (
        <div style={hookStyles.wrapper} data-testid="preview-hook">
          <span style={hookStyles.text}>{hookText}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Draws the current frame scaled to cover the (tiny) canvas; CSS blurs and stretches it. */
function drawCover(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const context = canvas.getContext("2d");
  if (!context || !video.videoWidth) return;
  const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}
