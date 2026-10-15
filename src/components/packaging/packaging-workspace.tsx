"use client";

import { AlertCircle, ArrowLeft, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  cancelPackagingJobAction,
  generatePackagingAction,
  getPackagingStateAction,
} from "@/app/(app)/packaging/actions";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { TextWithCode } from "@/components/text-with-code";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { PackagingSetView, PackagingTarget, ThumbnailView } from "@/server/services/packaging";
import { SetEditor } from "./set-editor";
import { ThumbnailsPanel } from "./thumbnails-panel";

type ProviderInfo = {
  label: string;
  model: string | null;
  local: boolean;
  ready: boolean;
  problem: string | null;
  fix: string | null;
  privacy: string;
} | null;

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** AI Packaging workspace for one video or Short (UI_UX.md, PKG-01…07). */
export function PackagingWorkspace({
  target,
  initialSets,
  initialThumbnails,
  provider,
  channelStyleSet,
}: {
  target: PackagingTarget;
  initialSets: PackagingSetView[];
  initialThumbnails: ThumbnailView[];
  provider: ProviderInfo;
  channelStyleSet: boolean;
}) {
  const [sets, setSets] = useState(initialSets);
  const [thumbnails, setThumbnails] = useState(initialThumbnails);
  const [currentId, setCurrentId] = useState<string | null>(
    (initialSets.find((s) => s.preferred) ?? initialSets.find((s) => s.status === "ready") ?? initialSets[0])?.id ??
      null,
  );
  const [notes, setNotes] = useState("");
  const [frameRequest, setFrameRequest] = useState<{ frameMs: number | null; nonce: number } | null>(null);
  const [headline, setHeadline] = useState("");
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const result = await getPackagingStateAction(target.kind, target.id);
    if (!result.ok) return;
    setSets(result.data.sets);
    setThumbnails(result.data.thumbnails);
  }, [target.kind, target.id]);

  const processing = sets.find((s) => s.status === "processing") ?? null;
  const busy = Boolean(processing) || thumbnails.some((t) => t.status === "processing");
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  // When a generation finishes, show it.
  const wasProcessing = useRef(processing?.id ?? null);
  useEffect(() => {
    const before = wasProcessing.current;
    if (before && !processing) {
      const finished = sets.find((s) => s.id === before);
      if (finished?.status === "ready") {
        setCurrentId(finished.id);
        toast.success("New packaging is ready.");
      } else if (finished?.status === "failed") {
        toast.error("Writing packaging failed. See the message below.");
      }
    }
    wasProcessing.current = processing?.id ?? null;
  }, [processing, sets]);

  function generate() {
    startTransition(async () => {
      const result = await generatePackagingAction(target.kind, target.id, { notes });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setSets((current) => [result.data, ...current]);
      setCurrentId(result.data.id);
    });
  }

  const current = sets.find((s) => s.id === currentId) ?? null;
  const generateBlocked = target.blockedReason ?? (provider?.ready ? null : "no-provider");

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild className="-ml-2">
        <Link href="/packaging">
          <ArrowLeft data-icon="inline-start" />
          AI Packaging
        </Link>
      </Button>
      <PageHeader
        title={target.title}
        description={
          target.kind === "short"
            ? `Short from “${target.videoTitle}” (${formatTimecode(target.durationMs)})`
            : `Video · ${formatTimecode(target.durationMs)}`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link href={target.editHref}>{target.kind === "short" ? "Open in Shorts Editor" : "Open video"}</Link>
            </Button>
            <Button asChild>
              <Link href={`/youtube/publish/${target.kind}/${target.id}`}>Publish to YouTube</Link>
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Write packaging</CardTitle>
          <CardDescription>
            Titles, a description{target.kind === "video" ? " (with chapters for longer videos)" : ""}, hashtags,
            opening hooks and thumbnail ideas — written from{" "}
            {target.kind === "short" ? "the Short's captions" : "the video's transcript"}. Nothing is invented on
            purpose: suggestions that mention numbers not in the transcript or sound sensational are flagged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {provider ? (
            <p className="text-sm text-muted-foreground" data-testid="packaging-provider">
              AI: {provider.label}
              {provider.model ? ` · ${provider.model}` : ""}. {provider.privacy}{" "}
              <Link href="/settings/ai" className="underline underline-offset-2">
                Change
              </Link>
              {channelStyleSet ? " · Uses your channel style notes." : ""}
            </p>
          ) : null}
          {target.blockedReason ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>Not ready yet</AlertTitle>
              <AlertDescription>{target.blockedReason}</AlertDescription>
            </Alert>
          ) : provider && !provider.ready ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>
                {provider.label} isn&apos;t ready{provider.problem ? `: ${provider.problem}` : ""}
              </AlertTitle>
              <AlertDescription>
                {provider.fix ? <TextWithCode text={provider.fix} /> : null}
                <p>
                  Packaging needs a working AI model.{" "}
                  <Link href="/settings/ai" className="underline underline-offset-2">
                    Settings › AI & processing
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="packaging-notes">Notes for this version (optional)</Label>
            <Textarea
              id="packaging-notes"
              value={notes}
              maxLength={1000}
              rows={2}
              placeholder="e.g. Audience: beginners. Tone: calm and practical. Mention “transcripts”."
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          {processing ? (
            <div className="space-y-2 rounded-lg border p-3" role="status" data-testid="packaging-progress">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {processing.job?.status === "queued" ? "Waiting for the media worker…" : "Writing packaging…"}
                </p>
                {processing.job ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const result = await cancelPackagingJobAction(processing.job?.id);
                      if (!result.ok) toast.error(result.error);
                      await refresh();
                    }}
                  >
                    <X data-icon="inline-start" />
                    Cancel
                  </Button>
                ) : null}
              </div>
              <Progress value={processing.job?.progress ?? 0} aria-label="Packaging progress" />
              <p className="text-xs text-muted-foreground">
                {processing.job?.message ?? "Starting"} · small local models can take a few minutes.
              </p>
            </div>
          ) : (
            <Button type="button" onClick={generate} disabled={pending || Boolean(generateBlocked)}>
              {pending ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" />}
              {sets.some((s) => s.status === "ready") ? "Write a new version" : "Write packaging"}
            </Button>
          )}
          {sets.some((s) => s.status === "ready") ? (
            <p className="text-xs text-muted-foreground">Earlier versions are kept — switch between them below.</p>
          ) : null}
        </CardContent>
      </Card>

      {sets.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Versions</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Packaging versions">
            {sets.map((set, index) => (
              <button
                key={set.id}
                type="button"
                role="tab"
                aria-selected={set.id === currentId}
                onClick={() => setCurrentId(set.id)}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-left text-xs transition-colors",
                  set.id === currentId ? "border-primary bg-primary/5" : "hover:bg-muted",
                )}
              >
                <span className="block font-medium">
                  Version {sets.length - index}
                  {set.preferred ? " · yours" : ""}
                </span>
                <span className="block text-muted-foreground">
                  {set.status === "ready"
                    ? dateFormat.format(new Date(set.createdAt))
                    : set.status === "processing"
                      ? "Writing…"
                      : "Failed"}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {current?.status === "failed" ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>This version failed</AlertTitle>
          <AlertDescription>
            <p>{current.error}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {current?.status === "ready" ? (
        <SetEditor
          key={current.id}
          set={current}
          onChanged={(updated) => {
            if (!updated) return;
            setSets((list) =>
              list.map((s) => (s.id === updated.id ? updated : updated.preferred ? { ...s, preferred: false } : s)),
            );
          }}
          onDeleted={() => {
            setSets((list) => list.filter((s) => s.id !== current.id));
            setCurrentId(null);
            toast.success("Version deleted.");
          }}
          onFrame={(ms) => setFrameRequest({ frameMs: ms, nonce: Date.now() })}
          onMockup={(text, frameMs) => {
            setHeadline(text);
            setFrameRequest({ frameMs, nonce: Date.now() });
          }}
        />
      ) : null}
      {sets.length > 0 && !current ? <p className="text-sm text-muted-foreground">Choose a version above.</p> : null}

      <ThumbnailsPanel
        target={target}
        thumbnails={thumbnails}
        setId={current?.id ?? null}
        request={frameRequest}
        headline={headline}
        onHeadlineChange={setHeadline}
        onChanged={() => void refresh()}
      />
    </div>
  );
}
