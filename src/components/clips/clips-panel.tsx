"use client";

import { Bot, CircleAlert, Gauge, Info, RotateCcw, Scissors, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { findClipsAction } from "@/app/(app)/clip-finder/actions";
import { cancelJobAction, retryJobAction } from "@/app/(app)/videos/actions";
import { EmptyState } from "@/components/states/empty-state";
import { TextWithCode } from "@/components/text-with-code";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { ClipStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ProviderStatus } from "@/server/services/ai-providers";
import type { AnalysisState, ClipView } from "@/server/services/clips";
import { showTab } from "@/components/videos/detail-tabs";
import { ClipCard } from "./clip-card";

const FILTERS: { status: ClipStatus; label: string }[] = [
  { status: "suggested", label: "To review" },
  { status: "accepted", label: "Accepted" },
  { status: "rejected", label: "Rejected" },
];

/** CLIP-04…08: start analysis, follow its progress, and review the suggestions. */
export function ClipsPanel({
  videoId,
  clips,
  analysis,
  transcriptReady,
  provider,
}: {
  videoId: string;
  clips: ClipView[];
  analysis: AnalysisState;
  transcriptReady: boolean;
  /** The owner's chosen provider and whether it's usable now. */
  provider: ProviderStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<ClipStatus>("suggested");

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? "Something went wrong.");
      else toast.success(success);
      router.refresh();
    });
  }

  const job = analysis.job;
  const active = job?.status === "queued" || job?.status === "running";
  const failed = job?.status === "failed";
  const aiUsable = provider.isAi && provider.ready;
  const counts = Object.fromEntries(FILTERS.map((f) => [f.status, clips.filter((c) => c.status === f.status).length]));
  const visible = clips.filter((clip) => clip.status === filter);

  if (!transcriptReady) {
    return (
      <EmptyState
        icon={Scissors}
        title="Transcript needed first"
        description="Clips are found from what's said in the video. Open the Transcript tab to create one."
        action={
          <Button variant="outline" onClick={() => showTab("transcript")}>
            Go to Transcript
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={pending || active || !aiUsable}
            onClick={() =>
              run(() => findClipsAction(videoId, "ai"), "Finding clips with AI. This can take a few minutes.")
            }
          >
            {pending ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
            {clips.some((c) => c.origin !== "manual") ? "Find clips again with AI" : "Find clips with AI"}
          </Button>
          <Button
            variant="outline"
            disabled={pending || active}
            onClick={() => run(() => findClipsAction(videoId, "heuristic"), "Ranking by speech patterns.")}
          >
            <Gauge data-icon="inline-start" />
            Speech patterns only (no AI)
          </Button>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Bot className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {provider.isAi ? (
            <span>
              AI: {provider.label}
              {provider.model ? ` · ${provider.model}` : ""}. {provider.privacy}{" "}
              <Link href="/settings/ai" className="underline underline-offset-2">
                Change
              </Link>
            </span>
          ) : (
            <span>
              AI is turned off.{" "}
              <Link href="/settings/ai" className="underline underline-offset-2">
                Choose an AI provider
              </Link>{" "}
              for titles, reasons and AI judgement.
            </span>
          )}
        </p>
        {provider.isAi && !provider.ready ? (
          <Alert>
            <Info />
            <AlertTitle>
              {provider.label} isn&apos;t ready: {provider.problem}
            </AlertTitle>
            {provider.fix ? (
              <AlertDescription>
                <p>
                  <TextWithCode text={provider.fix} />
                </p>
              </AlertDescription>
            ) : null}
          </Alert>
        ) : null}

        {active ? (
          <div className="space-y-2" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>{job.status === "running" ? (job.progressMessage ?? "Finding clips…") : "Waiting to start…"}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => cancelJobAction(job.id), "Stopping…")}
              >
                Cancel
              </Button>
            </div>
            <Progress value={job.status === "running" ? job.progress : 0} aria-label="Clip analysis progress" />
          </div>
        ) : null}

        {failed ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Finding clips failed</AlertTitle>
            <AlertDescription>
              <p>
                <TextWithCode text={job.error ?? "Something went wrong."} />
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => retryJobAction(job.id), "Trying again.")}
                >
                  <RotateCcw data-icon="inline-start" />
                  Try again
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        {analysis.lastResult && !active ? (
          <p className="text-xs text-muted-foreground">
            {analysis.lastResult.mode === "ai"
              ? `Last suggestions were rated by AI (${analysis.lastResult.model}). AI judgement can be wrong — preview each clip before accepting it.`
              : "Last suggestions were ranked by speech patterns only — no AI was used, so titles are the first sentence."}
            {analysis.lastResult.warnings.map((warning) => ` ${warning}`).join("")}
          </p>
        ) : null}
      </div>

      <div className="flex gap-1" role="tablist" aria-label="Filter clips">
        {FILTERS.map((f) => (
          <button
            key={f.status}
            type="button"
            role="tab"
            aria-selected={filter === f.status}
            onClick={() => setFilter(f.status)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-muted",
              filter === f.status ? "bg-muted font-medium" : "text-muted-foreground",
            )}
          >
            {f.label} ({counts[f.status]})
          </button>
        ))}
      </div>

      {visible.length > 0 ? (
        <ul className="space-y-3">
          {visible.map((clip) => (
            <ClipCard key={`${clip.id}-${clip.startMs}-${clip.endMs}-${clip.title}`} clip={clip} />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Scissors}
          title={
            filter === "suggested"
              ? "Nothing to review"
              : filter === "accepted"
                ? "No accepted clips yet"
                : "No rejected clips"
          }
          description={
            filter === "suggested"
              ? clips.length === 0
                ? "Find clips with AI, rank by speech patterns, or pick a section yourself in the Transcript tab (Make a clip)."
                : "You've reviewed every suggestion."
              : "Accepted clips wait in the Shorts Editor queue; rejected ones are kept here in case you change your mind."
          }
        />
      )}
    </div>
  );
}
