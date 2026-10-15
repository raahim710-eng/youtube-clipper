"use client";

import {
  ArrowLeft,
  Check,
  CloudOff,
  Download,
  MoreHorizontal,
  Pause,
  PenLine,
  Play,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  cancelShortJobAction,
  deleteShortAction,
  exportShortAction,
  getShortStatusAction,
  saveShortAction,
} from "@/app/(app)/shorts/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { mergeCaptionsForRange } from "@/lib/shorts/captions";
import { framingKeyframes, needsHorizontalFraming } from "@/lib/shorts/framing";
import { commitTrim, type Range } from "@/lib/shorts/range";
import { formatTimecode, parseTimecode } from "@/lib/time";
import type { ShortDoc, ShortEditorData, ShortStatusView } from "@/server/services/shorts";
import { CaptionsPanel } from "./captions-panel";
import { ExportPanel } from "./export-panel";
import { FramingPanel } from "./framing-panel";
import { ShortPreview } from "./short-preview";
import { ShortTimeline } from "./short-timeline";

type SaveState = { state: "saved" | "pending" | "saving" | "error"; error?: string };
type Tab = "captions" | "framing" | "export";

/**
 * The Shorts editor (UI_UX.md §4): 9:16 preview, timeline with trim handles, captions, framing and
 * export. Changes autosave one second after the last edit; face tracking and exports are polled.
 */
export function ShortEditor({ data }: { data: ShortEditorData }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [doc, setDoc] = useState<ShortDoc>(data.doc);
  const [status, setStatus] = useState<ShortStatusView>(data.status);
  const [save, setSave] = useState<SaveState>({ state: "saved" });
  const [currentMs, setCurrentMs] = useState(data.doc.startMs);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>("captions");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, startExport] = useTransition();
  const [deleting, startDelete] = useTransition();

  const bounds = data.window;
  const range: Range = { startMs: doc.startMs, endMs: doc.endMs };
  const horizontal = needsHorizontalFraming(data.sourceWidth, data.sourceHeight);

  // ---- Autosave (debounced 1 s, saves run one after another) ----
  const docRef = useRef(doc);
  const savedDocRef = useRef(data.doc);
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));

  const flush = useCallback((): Promise<boolean> => {
    chainRef.current = chainRef.current.then(async () => {
      const snapshot = docRef.current;
      if (snapshot === savedDocRef.current) return true;
      setSave({ state: "saving" });
      const result = await saveShortAction(data.id, snapshot);
      if (!result.ok) {
        setSave({ state: "error", error: result.error });
        return false;
      }
      savedDocRef.current = snapshot;
      setStatus(result.data);
      setSave({ state: docRef.current === snapshot ? "saved" : "pending" });
      return true;
    });
    return chainRef.current;
  }, [data.id]);

  useEffect(() => {
    docRef.current = doc;
    if (doc === savedDocRef.current) return;
    setSave({ state: "pending" });
    const timer = setTimeout(() => void flush(), 1_000);
    return () => clearTimeout(timer);
  }, [doc, flush]);

  useEffect(() => {
    if (save.state === "saved") return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [save.state]);

  const update = useCallback((patch: Partial<ShortDoc>) => setDoc((previous) => ({ ...previous, ...patch })), []);

  // ---- Status polling while face tracking or an export runs ----
  const active =
    Boolean(status.reframe.job || status.render.job) ||
    status.reframe.status === "processing" ||
    status.render.status === "rendering";
  const previousRender = useRef(status.render);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(async () => {
      const result = await getShortStatusAction(data.id);
      if (result.ok) setStatus(result.data);
    }, 2_000);
    return () => clearInterval(timer);
  }, [active, data.id]);
  useEffect(() => {
    const before = previousRender.current;
    if (before.job && !status.render.job) {
      if (status.render.status === "ready") toast.success("Your Short is ready to download.");
      else if (status.render.status === "failed") toast.error("The export failed. See the Export tab.");
    }
    previousRender.current = status.render;
  }, [status.render]);

  // ---- Playback ----
  const seek = useCallback((ms: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = ms / 1000;
    setCurrentMs(ms);
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    const ms = video.currentTime * 1000;
    if (ms < doc.startMs || ms >= doc.endMs - 50) video.currentTime = doc.startMs / 1000;
    void video.play().catch(() => toast.error("The video couldn't be played."));
  }, [doc.startMs, doc.endMs]);

  const commitRange = useCallback(
    (next: Range, moving: "start" | "end") => {
      const snapped = commitTrim(data.words, next, bounds, moving);
      setDoc((previous) => ({
        ...previous,
        startMs: snapped.startMs,
        endMs: snapped.endMs,
        captions: mergeCaptionsForRange(previous.captions, data.words, previous, snapped),
      }));
      const video = videoRef.current;
      if (video && (video.currentTime * 1000 < snapped.startMs || video.currentTime * 1000 > snapped.endMs)) {
        seek(moving === "end" ? Math.max(snapped.startMs, snapped.endMs - 2_000) : snapped.startMs);
      }
    },
    [bounds, data.words, seek],
  );

  // ---- Keyboard shortcuts: Space, ←/→, [ and ] ----
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, button, a, [contenteditable='true'], [role='slider'], [role='radio'], [role='menuitem'], [role='tab']",
        )
      ) {
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = event.key === "ArrowLeft" ? -1_000 : 1_000;
        seek(Math.min(bounds.endMs, Math.max(bounds.startMs, currentMs + delta)));
      } else if (event.key === "[") {
        commitRange({ ...range, startMs: currentMs }, "start");
      } else if (event.key === "]") {
        commitRange({ ...range, endMs: currentMs }, "end");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Export ----
  const blockedReason =
    save.state === "error"
      ? "Your latest changes couldn't be saved. Fix the problem shown at the top first."
      : doc.reframeMode === "auto" && horizontal && !status.reframe.covers
        ? status.reframe.status === "failed"
          ? "Face tracking failed. Try it again on the Framing tab, or choose another framing."
          : "Waiting for face tracking to finish (see the Framing tab)."
        : null;

  function exportNow() {
    setTab("export");
    startExport(async () => {
      if (!(await flush())) {
        toast.error("Your changes couldn't be saved, so the Short wasn't exported.");
        return;
      }
      const result = await exportShortAction(data.id);
      if (result.ok) setStatus(result.data);
      else toast.error(result.error);
    });
  }

  const autoKeyframes = status.reframe.covers ? status.reframe.keyframes : null;
  const keyframes = framingKeyframes(doc.reframeMode, { manualX: doc.manualX, autoKeyframes });
  const lengthMs = doc.endMs - doc.startMs;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/shorts">
            <ArrowLeft data-icon="inline-start" />
            Shorts
          </Link>
        </Button>
        <Input
          value={doc.title}
          maxLength={120}
          onChange={(event) => update({ title: event.target.value })}
          aria-label="Short title"
          className="h-9 max-w-md flex-1 text-base font-semibold"
        />
        <SaveIndicator save={save} onRetry={() => void flush()} />
        <div className="ml-auto flex items-center gap-2">
          {status.render.output && !status.render.stale ? (
            <Button variant="outline" asChild>
              <a href={status.render.output.downloadUrl} download>
                <Download data-icon="inline-start" />
                Download
              </a>
            </Button>
          ) : null}
          <Button onClick={exportNow} disabled={Boolean(blockedReason) || exporting || Boolean(status.render.job)}>
            {exporting || status.render.job ? <Spinner data-icon="inline-start" /> : null}
            {status.render.job ? `Exporting ${status.render.job.progress}%` : "Export MP4"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/packaging/short/${data.id}`}>
                  <PenLine />
                  Write packaging
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/youtube/publish/short/${data.id}`}>
                  <Upload />
                  Publish to YouTube
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/videos/${data.videoId}`}>
                  <Video />
                  Open the source video
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete Short
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        From{" "}
        <Link href={`/videos/${data.videoId}`} className="underline underline-offset-2">
          {data.videoTitle}
        </Link>
      </p>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-3 self-start lg:sticky lg:top-4">
          <div className="mx-auto w-full max-w-[min(22rem,39vh)]">
            <ShortPreview
              videoRef={videoRef}
              src={`/api/media/videos/${data.videoId}/playback`}
              poster={data.hasPoster ? `/api/media/videos/${data.videoId}/poster` : undefined}
              sourceWidth={data.sourceWidth}
              sourceHeight={data.sourceHeight}
              mode={horizontal ? doc.reframeMode : "center"}
              keyframes={keyframes}
              captions={doc.captionsEnabled ? doc.captions : null}
              captionStyle={doc.captionStyle}
              hookText={doc.hookText}
              startMs={doc.startMs}
              endMs={doc.endMs}
              onTime={(ms, isPlaying) => {
                setCurrentMs(ms);
                setPlaying(isPlaying);
              }}
            />
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" size="icon" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause /> : <Play />}
            </Button>
            <span className="min-w-28 text-center text-sm tabular-nums" aria-live="off">
              {formatTimecode(Math.max(0, currentMs - doc.startMs))} / {formatTimecode(lengthMs)}
            </span>
          </div>
          {doc.reframeMode === "auto" && horizontal && !status.reframe.covers ? (
            <p className="text-center text-xs text-muted-foreground">Centred until face tracking finishes.</p>
          ) : null}
          <p className="text-center text-xs text-muted-foreground">
            Keys: Space play/pause · ←/→ 1 s · [ / ] set start/end at the playhead
          </p>
        </div>

        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4">
          <TabsList>
            <TabsTrigger value="captions">Captions</TabsTrigger>
            <TabsTrigger value="framing">Framing</TabsTrigger>
            <TabsTrigger value="export">Export</TabsTrigger>
          </TabsList>
          <TabsContent value="captions">
            <CaptionsPanel
              enabled={doc.captionsEnabled}
              captions={doc.captions}
              style={doc.captionStyle}
              hookText={doc.hookText}
              startMs={doc.startMs}
              endMs={doc.endMs}
              currentMs={currentMs}
              playing={playing}
              words={data.words}
              transcriptReady={data.transcriptReady}
              onChange={update}
              onSeek={seek}
            />
          </TabsContent>
          <TabsContent value="framing">
            <FramingPanel
              shortId={data.id}
              mode={doc.reframeMode}
              manualX={doc.manualX}
              sourceWidth={data.sourceWidth}
              sourceHeight={data.sourceHeight}
              reframe={status.reframe}
              videoRef={videoRef}
              currentMs={currentMs}
              onChange={update}
              onStatusChange={async () => {
                const result = await getShortStatusAction(data.id);
                if (result.ok) setStatus(result.data);
              }}
            />
          </TabsContent>
          <TabsContent value="export">
            <ExportPanel
              render={status.render}
              quality={doc.exportQuality}
              lengthMs={lengthMs}
              fps={data.fps}
              hasAudio={data.hasAudio}
              captionsOn={doc.captionsEnabled && doc.captions.length > 0}
              mode={horizontal ? doc.reframeMode : "center"}
              blockedReason={blockedReason}
              busy={exporting}
              packagingHref={`/packaging/short/${data.id}`}
              publishHref={`/youtube/publish/short/${data.id}`}
              onQualityChange={(exportQuality) => update({ exportQuality })}
              onExport={exportNow}
              onCancel={async (jobId) => {
                const result = await cancelShortJobAction(jobId);
                if (!result.ok) toast.error(result.error);
                const fresh = await getShortStatusAction(data.id);
                if (fresh.ok) setStatus(fresh.data);
              }}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <RangeFields range={range} lengthMs={lengthMs} onCommit={commitRange} />
          <ShortTimeline
            bounds={bounds}
            range={range}
            currentMs={currentMs}
            words={data.words}
            loudness={data.loudness}
            onSeek={seek}
            onCommit={commitRange}
          />
        </CardContent>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this Short?</AlertDialogTitle>
            <AlertDialogDescription>
              The Short and its exported file are removed. The source video and its clips stay in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                startDelete(async () => {
                  const result = await deleteShortAction(data.id);
                  if (result && !result.ok) toast.error(result.error);
                });
              }}
            >
              Delete Short
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveIndicator({ save, onRetry }: { save: SaveState; onRetry: () => void }) {
  if (save.state === "error") {
    return (
      <span className="flex items-center gap-2 text-sm text-destructive" role="alert">
        <CloudOff className="size-4" aria-hidden />
        {save.error ?? "Not saved."}
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
      aria-live="polite"
      data-testid="save-state"
    >
      {save.state === "saved" ? <Check className="size-4" aria-hidden /> : <Spinner className="size-3.5" />}
      {save.state === "saved" ? "Saved" : "Saving…"}
    </span>
  );
}

/** Exact start/end entry (absolute video time) next to the timeline. */
function RangeFields({
  range,
  lengthMs,
  onCommit,
}: {
  range: Range;
  lengthMs: number;
  onCommit: (range: Range, moving: "start" | "end") => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <TimeField label="Start" ms={range.startMs} onCommit={(startMs) => onCommit({ ...range, startMs }, "start")} />
      <TimeField label="End" ms={range.endMs} onCommit={(endMs) => onCommit({ ...range, endMs }, "end")} />
      <p className="pb-2 text-muted-foreground">
        Length {formatTimecode(lengthMs)} · trims snap out of words · up to 3 minutes
      </p>
    </div>
  );
}

function TimeField({ label, ms, onCommit }: { label: string; ms: number; onCommit: (ms: number) => void }) {
  const [text, setText] = useState(formatTimecode(ms));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : formatTimecode(ms);

  function commit() {
    setEditing(false);
    const value = parseTimecode(text);
    if (value === null) {
      toast.error("Use times like 1:05.5 or 65.5.");
      return;
    }
    if (value !== ms) onCommit(value);
  }

  return (
    <label className="space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input
        value={shown}
        className="h-8 w-28 tabular-nums"
        onFocus={() => {
          setText(formatTimecode(ms));
          setEditing(true);
        }}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        aria-label={`${label} time`}
      />
    </label>
  );
}
