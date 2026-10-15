"use client";

import { Check, Pause, Pencil, Play, RotateCcw, SlidersHorizontal, Smartphone, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setClipStatusAction, updateClipRangeAction, updateClipTitleAction } from "@/app/(app)/clip-finder/actions";
import { CreateShortButton } from "@/components/shorts/create-short-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { usePlayer } from "@/components/videos/player-context";
import { originLabel } from "@/lib/clips";
import { CLIP_CATEGORY_LABELS } from "@/lib/constants";
import { formatTimecode, parseTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ClipView } from "@/server/services/clips";

/** One suggestion: preview, adjust (snapped to words on save), accept or reject (CLIP-06). */
export function ClipCard({ clip }: { clip: ClipView }) {
  const router = useRouter();
  const { playRange, previewRange, stop, currentMs, hasVideo } = usePlayer();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [start, setStart] = useState(formatTimecode(clip.startMs));
  const [end, setEnd] = useState(formatTimecode(clip.endMs));
  const [title, setTitle] = useState(clip.title);
  const [expanded, setExpanded] = useState(false);

  const previewing = previewRange?.startMs === clip.startMs && previewRange.endMs === clip.endMs;
  const seconds = Math.round((clip.endMs - clip.startMs) / 100) / 10;

  function act(action: () => Promise<{ ok: boolean; error?: string }>, success?: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong.");
        return;
      }
      if (success) toast.success(success);
      after?.();
      router.refresh();
    });
  }

  function saveRange() {
    const startMs = parseTimecode(start);
    const endMs = parseTimecode(end);
    if (startMs === null || endMs === null) {
      toast.error("Use times like 1:05.5 or 65.5.");
      return;
    }
    act(
      () => updateClipRangeAction(clip.id, { startMs, endMs }),
      "Saved — adjusted to whole words.",
      () => setEditing(false),
    );
  }

  function nudge(which: "start" | "end", deltaMs: number) {
    const [value, set] = which === "start" ? [start, setStart] : [end, setEnd];
    const ms = parseTimecode(value);
    if (ms !== null) set(formatTimecode(Math.max(0, ms + deltaMs)));
  }

  return (
    <li
      className={cn(
        "space-y-3 rounded-xl border bg-card p-4",
        clip.status === "accepted" && "border-success/40",
        previewing && "ring-2 ring-primary/40",
      )}
      data-testid="clip-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          {renaming ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                act(
                  () => updateClipTitleAction(clip.id, title),
                  undefined,
                  () => setRenaming(false),
                );
              }}
            >
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} aria-label="Clip title" />
              <Button size="sm" type="submit" disabled={pending}>
                Save
              </Button>
            </form>
          ) : (
            <p className="flex items-start gap-1 font-medium">
              <span>{clip.title}</span>
              <button
                type="button"
                className="mt-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Rename clip"
                onClick={() => setRenaming(true)}
              >
                <Pencil className="size-3.5" />
              </button>
            </p>
          )}
          <p className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatTimecode(clip.startMs)} – {formatTimecode(clip.endMs)} · {seconds} s
          </p>
        </div>
        {clip.score !== null ? (
          <div className="text-right">
            <span className="text-2xl font-semibold tabular-nums">{clip.score}</span>
            <span className="text-xs text-muted-foreground">/100</span>
            <p className="text-[11px] text-muted-foreground">
              {clip.aiScore !== null ? `AI ${clip.aiScore} · ` : ""}speech {clip.heuristicScore ?? "–"}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Badge
          variant="outline"
          className={cn("font-normal", clip.origin === "ai" && "border-primary/40 text-primary")}
        >
          {originLabel(clip)}
        </Badge>
        {clip.category ? (
          <Badge variant="secondary" className="font-normal">
            {CLIP_CATEGORY_LABELS[clip.category]}
          </Badge>
        ) : null}
        {clip.status !== "suggested" ? (
          <Badge
            variant="outline"
            className={cn("font-normal", clip.status === "accepted" ? "text-success" : "text-muted-foreground")}
          >
            {clip.status === "accepted"
              ? clip.shortId
                ? "Accepted · Short created"
                : "Accepted · in the Shorts Editor queue"
              : "Rejected"}
          </Badge>
        ) : null}
      </div>

      {clip.hook ? <p className="text-sm italic">“{clip.hook}”</p> : null}
      {clip.reason ? (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Why: </span>
          {clip.reason}
        </p>
      ) : null}
      <button
        type="button"
        className={cn("block text-left text-sm text-muted-foreground", !expanded && "line-clamp-3")}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {clip.transcriptText}
      </button>

      {editing ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["start", "end"] as const).map((which) => (
              <div key={which} className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`${clip.id}-${which}`}>
                  {which === "start" ? "Start" : "End"}
                </label>
                <div className="flex gap-1">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={`${which} 0.5 s earlier`}
                    onClick={() => nudge(which, -500)}
                  >
                    −
                  </Button>
                  <Input
                    id={`${clip.id}-${which}`}
                    value={which === "start" ? start : end}
                    onChange={(e) => (which === "start" ? setStart : setEnd)(e.target.value)}
                    className="font-mono"
                    inputMode="decimal"
                  />
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label={`${which} 0.5 s later`}
                    onClick={() => nudge(which, 500)}
                  >
                    +
                  </Button>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!hasVideo}
                  onClick={() => (which === "start" ? setStart : setEnd)(formatTimecode(currentMs))}
                >
                  Use player time ({formatTimecode(currentMs)})
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving moves the edges to whole words so nothing is cut mid-word.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveRange} disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Save timing
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!hasVideo}
              onClick={() => {
                const s = parseTimecode(start);
                const e = parseTimecode(end);
                if (s !== null && e !== null && e > s) playRange(s, e);
              }}
            >
              <Play data-icon="inline-start" />
              Preview new timing
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!hasVideo}
          onClick={() => (previewing ? stop() : playRange(clip.startMs, clip.endMs))}
        >
          {previewing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {previewing ? "Stop preview" : "Preview"}
        </Button>
        {!editing ? (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <SlidersHorizontal data-icon="inline-start" />
            Adjust timing
          </Button>
        ) : null}
        {clip.status !== "accepted" ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              act(() => setClipStatusAction(clip.id, "accepted"), "Accepted — sent to the Shorts Editor queue.")
            }
          >
            <Check data-icon="inline-start" />
            Accept
          </Button>
        ) : null}
        {clip.shortId ? (
          <Button size="sm" asChild>
            <Link href={`/shorts/${clip.shortId}`}>
              <Smartphone data-icon="inline-start" />
              Open Short
            </Link>
          </Button>
        ) : clip.status === "accepted" ? (
          <CreateShortButton clipId={clip.id} />
        ) : null}
        {clip.status !== "rejected" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => act(() => setClipStatusAction(clip.id, "rejected"))}
          >
            <X data-icon="inline-start" />
            Reject
          </Button>
        ) : null}
        {clip.status !== "suggested" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => act(() => setClipStatusAction(clip.id, "suggested"))}
          >
            <RotateCcw data-icon="inline-start" />
            Move back to review
          </Button>
        ) : null}
      </div>
    </li>
  );
}
