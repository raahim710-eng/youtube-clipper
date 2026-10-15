"use client";

import { CircleAlert, FileText, RotateCcw, Scissors, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { createManualClipAction, transcribeVideoAction } from "@/app/(app)/clip-finder/actions";
import { cancelJobAction } from "@/app/(app)/videos/actions";
import { EmptyState } from "@/components/states/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { showTab } from "@/components/videos/detail-tabs";
import { usePlayer } from "@/components/videos/player-context";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { TranscriptView } from "@/server/services/transcripts";

/** CLIP-01/02/06: transcript synced with the player, searchable, and a source for manual clips. */
export function TranscriptPanel({
  videoId,
  transcript,
  blockedReason,
}: {
  videoId: string;
  transcript: TranscriptView;
  /** Why transcription can't start (e.g. video still processing), or null. */
  blockedReason: string | null;
}) {
  const router = useRouter();
  const { currentMs, seek, hasVideo } = usePlayer();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? transcript.segments.map((s, i) => (s.text.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0)
      : null;
  }, [query, transcript.segments]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "Something went wrong.");
        return;
      }
      toast.success(success);
      after?.();
      router.refresh();
    });
  }

  if (transcript.status === "none" || (transcript.status === "failed" && !transcript.job)) {
    return (
      <EmptyState
        icon={FileText}
        title="No transcript yet"
        description={
          blockedReason ??
          "Transcription runs on this computer and turns speech into searchable, timestamped text. Clips are found from it."
        }
        action={
          blockedReason ? undefined : (
            <Button
              disabled={pending}
              onClick={() => run(() => transcribeVideoAction(videoId), "Transcription started.")}
            >
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Transcribe video
            </Button>
          )
        }
      />
    );
  }

  if (transcript.status === "processing") {
    const running = transcript.job?.status === "running";
    return (
      <div className="space-y-3 rounded-xl border p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {running ? (transcript.job?.progressMessage ?? "Transcribing…") : "Waiting to be transcribed…"}
          </p>
          {transcript.job ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => cancelJobAction(transcript.job!.id), "Transcription will stop shortly.")}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <Progress value={running ? (transcript.job?.progress ?? 0) : 0} aria-label="Transcription progress" />
        <p className="text-xs text-muted-foreground">
          Runs locally with {transcript.provider} ({transcript.model}). On a slow computer this can take about half as
          long as the video.
        </p>
      </div>
    );
  }

  if (transcript.status === "failed") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Transcription failed</AlertTitle>
        <AlertDescription>
          <p>{transcript.errorMessage ?? "Something went wrong."}</p>
          {blockedReason ? null : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={pending}
              onClick={() => run(() => transcribeVideoAction(videoId), "Transcription restarted.")}
            >
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  const segments = transcript.segments;
  const activeIndex = segments.findIndex((s) => currentMs >= s.startMs && currentMs < s.endMs);
  const selected = (i: number) => selection !== null && i >= selection.from && i <= selection.to;

  function onSegmentClick(index: number) {
    if (!selecting) {
      seek(segments[index].startMs);
      return;
    }
    setSelection((current) =>
      current === null || current.from !== current.to
        ? { from: index, to: index }
        : { from: Math.min(current.from, index), to: Math.max(current.from, index) },
    );
  }

  function createClip() {
    if (!selection) return;
    const range = { startMs: segments[selection.from].startMs, endMs: segments[selection.to].endMs };
    run(
      () => createManualClipAction(videoId, range),
      "Clip added. Review it in the Clips tab.",
      () => {
        setSelecting(false);
        setSelection(null);
        showTab("clips");
      },
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the transcript"
            aria-label="Search the transcript"
            className="pl-8"
          />
        </div>
        <Button
          variant={selecting ? "secondary" : "outline"}
          size="sm"
          onClick={() => {
            setSelecting(!selecting);
            setSelection(null);
          }}
        >
          {selecting ? <X data-icon="inline-start" /> : <Scissors data-icon="inline-start" />}
          {selecting ? "Stop selecting" : "Make a clip"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {transcript.wordCount} words · {transcript.language ? `language: ${transcript.language} · ` : ""}
        transcribed locally with {transcript.provider} ({transcript.model})
        {matches ? ` · ${matches.length} matching ${matches.length === 1 ? "line" : "lines"}` : ""}
      </p>
      {selecting ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-2 text-sm">
          <span className="flex-1">
            {selection
              ? `Selected ${formatTimecode(segments[selection.from].startMs)} – ${formatTimecode(segments[selection.to].endMs)}. Click another line to extend.`
              : "Click the first line of your clip, then the last one."}
          </span>
          <Button size="sm" disabled={!selection || pending} onClick={createClip}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            Create clip
          </Button>
        </div>
      ) : null}
      {segments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No speech was found in this video.</p>
      ) : (
        <ol className="max-h-[60vh] space-y-1 overflow-y-auto pr-1" aria-label="Transcript">
          {segments.map((segment, index) => {
            if (matches && !matches.includes(index)) return null;
            return (
              <li key={`${segment.startMs}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSegmentClick(index)}
                  disabled={!hasVideo && !selecting}
                  className={cn(
                    "flex w-full gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                    index === activeIndex && "bg-primary/10",
                    selected(index) && "bg-primary/20 ring-1 ring-primary/40",
                  )}
                  aria-current={index === activeIndex ? "true" : undefined}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {formatTimecode(segment.startMs)}
                  </span>
                  <span>{segment.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
