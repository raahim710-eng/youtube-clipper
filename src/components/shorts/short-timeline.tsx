"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CaptionWord } from "@/lib/shorts/captions";
import { clampRange, type Range } from "@/lib/shorts/range";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";

type Loudness = { windowMs: number; startMs: number; db: number[] } | null;

/**
 * Timeline (SHORT-02): loudness of the audio, the selected range with trim handles, the playhead and
 * the transcript words underneath. It zooms itself to the Short plus some context; handles snap out
 * of words when released. Handles are sliders for keyboard users (←/→ 0.1 s, Shift 1 s).
 */
export function ShortTimeline({
  bounds,
  range,
  currentMs,
  words,
  loudness,
  onSeek,
  onCommit,
}: {
  bounds: Range;
  range: Range;
  currentMs: number;
  words: CaptionWord[];
  loudness: Loudness;
  onSeek: (ms: number) => void;
  onCommit: (range: Range, moving: "start" | "end") => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ side: "start" | "end"; range: Range } | null>(null);
  const [trackWidth, setTrackWidth] = useState(800);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => setTrackWidth(entry.contentRect.width || 800));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);
  const shown = drag?.range ?? range;

  // The view only changes when nothing is being dragged, so the scale stays still under the pointer.
  const view = useMemo(() => {
    const pad = Math.max(3_000, (range.endMs - range.startMs) * 0.25);
    return { startMs: Math.max(bounds.startMs, range.startMs - pad), endMs: Math.min(bounds.endMs, range.endMs + pad) };
  }, [bounds.startMs, bounds.endMs, range.startMs, range.endMs]);
  const span = Math.max(1, view.endMs - view.startMs);
  const pct = (ms: number) => ((ms - view.startMs) / span) * 100;

  function msAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return view.startMs;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(view.startMs + fraction * span);
  }

  function startDrag(side: "start" | "end", event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ side, range });
  }

  function moveDrag(event: React.PointerEvent) {
    if (!drag) return;
    const ms = msAt(event.clientX);
    const next = drag.side === "start" ? { ...drag.range, startMs: ms } : { ...drag.range, endMs: ms };
    setDrag({ side: drag.side, range: clampRange(next, bounds, drag.side) });
  }

  function endDrag() {
    if (!drag) return;
    onCommit(drag.range, drag.side);
    setDrag(null);
  }

  function nudge(side: "start" | "end", event: React.KeyboardEvent) {
    const step = event.shiftKey ? 1_000 : 100;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      side === "start" ? { ...range, startMs: range.startMs + delta } : { ...range, endMs: range.endMs + delta };
    onCommit(clampRange(next, bounds, side), side);
  }

  const bars = useMemo(() => {
    if (!loudness) return [];
    return loudness.db
      .map((db, index) => ({
        ms: loudness.startMs + index * loudness.windowMs,
        level: Math.min(1, Math.max(0, (db + 60) / 60)),
      }))
      .filter((bar) => bar.ms + loudness.windowMs > view.startMs && bar.ms < view.endMs);
  }, [loudness, view.startMs, view.endMs]);

  // Word labels that fit without overlapping (roughly 6 px per character at this size).
  const labels = useMemo(() => {
    const width = trackWidth;
    const placed: { word: CaptionWord; left: number }[] = [];
    let nextFree = -Infinity;
    for (const word of words) {
      if (word.endMs < view.startMs || word.startMs > view.endMs) continue;
      const left = ((word.startMs - view.startMs) / span) * width;
      if (left < nextFree) continue;
      placed.push({ word, left: (left / width) * 100 });
      nextFree = left + word.text.trim().length * 6 + 6;
    }
    return placed;
  }, [words, view.startMs, view.endMs, span, trackWidth]);

  return (
    <div className="space-y-1.5 select-none">
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{formatTimecode(view.startMs)}</span>
        <span>
          {drag
            ? `${drag.side === "start" ? "Start" : "End"} ${formatTimecode(drag.side === "start" ? shown.startMs : shown.endMs)}`
            : null}
        </span>
        <span>{formatTimecode(view.endMs)}</span>
      </div>
      <div
        ref={trackRef}
        className="relative h-20 cursor-pointer overflow-hidden rounded-md border bg-muted/40"
        onPointerDown={(event) => {
          if (event.button === 0) onSeek(msAt(event.clientX));
        }}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid="short-timeline"
      >
        {bars.length > 0 ? (
          <svg className="absolute inset-0 size-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
            {bars.map((bar) => (
              <rect
                key={bar.ms}
                x={pct(bar.ms)}
                width={Math.max(0.1, ((loudness?.windowMs ?? 500) / span) * 100 * 0.8)}
                y={50 - bar.level * 40}
                height={Math.max(1, bar.level * 80)}
                className="fill-muted-foreground/40"
              />
            ))}
          </svg>
        ) : null}
        <div
          className="absolute inset-y-0 border-y-2 border-primary bg-primary/15"
          style={{ left: `${pct(shown.startMs)}%`, width: `${pct(shown.endMs) - pct(shown.startMs)}%` }}
          aria-hidden
        />
        {(["start", "end"] as const).map((side) => {
          const ms = side === "start" ? shown.startMs : shown.endMs;
          return (
            <div
              key={side}
              role="slider"
              tabIndex={0}
              aria-label={side === "start" ? "Start of the Short" : "End of the Short"}
              aria-valuemin={bounds.startMs}
              aria-valuemax={bounds.endMs}
              aria-valuenow={ms}
              aria-valuetext={formatTimecode(ms)}
              className={cn(
                "absolute inset-y-0 z-10 flex w-3 cursor-ew-resize items-center justify-center bg-primary focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                side === "start" ? "-translate-x-full rounded-l-md" : "rounded-r-md",
              )}
              style={{ left: `${pct(ms)}%` }}
              onPointerDown={(event) => startDrag(side, event)}
              onKeyDown={(event) => nudge(side, event)}
              data-testid={`trim-${side}`}
            >
              <span className="h-6 w-0.5 rounded bg-primary-foreground/80" aria-hidden />
            </div>
          );
        })}
        <div
          className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-destructive"
          style={{ left: `${pct(currentMs)}%` }}
          aria-hidden
        />
      </div>
      <div className="relative h-5 overflow-hidden text-[11px] text-muted-foreground" aria-label="Transcript words">
        {labels.map(({ word, left }) => (
          <button
            key={`${word.startMs}-${word.text}`}
            type="button"
            className={cn(
              "absolute top-0 whitespace-nowrap hover:text-foreground",
              word.startMs >= shown.startMs && word.endMs <= shown.endMs && "text-foreground",
            )}
            style={{ left: `${left}%` }}
            onClick={() => onSeek(word.startMs)}
            tabIndex={-1}
          >
            {word.text.trim()}
          </button>
        ))}
      </div>
    </div>
  );
}
