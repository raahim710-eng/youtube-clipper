"use client";

import { AlertCircle, Check, Film, Library, Mic, RotateCcw, Search, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SceneView } from "@/server/services/generator";

export type LibraryVideo = {
  id: string;
  title: string;
  durationMs: number;
  width: number | null;
  height: number | null;
  hasPoster: boolean;
  generated: boolean;
};

const CLIP_ACCEPT = ".mp4,.mov,.m4v,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska";

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${Math.round(ms / 100) / 10} s`;
}

function StatusLine({ status, labels }: { status: string; labels: Record<string, [string, string]> }) {
  const [label, tone] = labels[status] ?? ["", ""];
  return (
    <Badge variant="outline" className={cn("font-normal", tone)}>
      {status === "processing" || status === "searching" ? <Spinner data-icon="inline-start" /> : null}
      {label}
    </Badge>
  );
}

const NARRATION_LABELS: Record<string, [string, string]> = {
  none: ["No narration", "text-muted-foreground"],
  processing: ["Recording", "text-muted-foreground"],
  ready: ["Narrated", "border-success text-success"],
  failed: ["Narration failed", "border-destructive text-destructive"],
};
const FOOTAGE_LABELS: Record<string, [string, string]> = {
  none: ["No footage", "text-muted-foreground"],
  searching: ["Searching", "text-muted-foreground"],
  ready: ["Footage chosen", "border-success text-success"],
  failed: ["No footage found", "border-destructive text-destructive"],
};

/**
 * One scene in the Scenes step: its narration (play, record again) and its footage (stock candidates,
 * a library video or an uploaded clip — always real moving video, GEN-04).
 */
export function SceneCard({
  scene,
  number,
  library,
  stockAvailable,
  locked,
  busy,
  onNarrate,
  onSearch,
  onChooseStock,
  onChooseLibrary,
  onUpload,
  onStartChange,
}: {
  scene: SceneView;
  number: number;
  library: LibraryVideo[];
  stockAvailable: boolean;
  locked: boolean;
  busy: boolean;
  onNarrate: () => void;
  onSearch: () => void;
  onChooseStock: (providerAssetId: string) => void;
  onChooseLibrary: (videoId: string, startMs: number) => void;
  onUpload: (file: File) => void;
  onStartChange: (startMs: number) => void;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryVideo, setLibraryVideo] = useState<string | null>(null);
  const [libraryStart, setLibraryStart] = useState("0");
  const [start, setStart] = useState(String(Math.round(scene.footage.startMs / 100) / 10));
  const fileInput = useRef<HTMLInputElement>(null);
  const narration = scene.narration_;
  const footage = scene.footage;
  const chosen = footage.chosen;
  const neededMs = narration.durationMs ?? scene.estimatedMs;
  const previewSrc =
    chosen?.previewUrl && footage.source === "library"
      ? `${chosen.previewUrl}#t=${footage.startMs / 1000}`
      : (chosen?.previewUrl ?? null);

  return (
    <li className="space-y-4 rounded-lg border p-4" data-testid="scene-card">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Scene {number}</p>
        <StatusLine status={narration.status} labels={NARRATION_LABELS} />
        <StatusLine status={footage.status} labels={FOOTAGE_LABELS} />
        <span className="ml-auto text-xs text-muted-foreground">
          {narration.durationMs
            ? `${seconds(narration.durationMs)} narration`
            : `~${seconds(scene.estimatedMs)} (estimate)`}
        </span>
      </div>
      <p className="text-sm">{scene.narration}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Narration */}
        <section className="space-y-2" aria-label={`Scene ${number} narration`}>
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Mic className="size-3.5" aria-hidden /> Narration
          </p>
          {narration.url ? (
            <audio key={narration.url} src={narration.url} controls preload="none" className="w-full" />
          ) : null}
          {narration.stale ? (
            <p className="text-xs text-warning">The text changed after this was recorded. Record it again.</p>
          ) : null}
          {narration.timing === "estimated" ? (
            <p className="text-xs text-muted-foreground">
              This voice doesn&apos;t report word timings, so captions are spread evenly over the audio.
            </p>
          ) : null}
          {narration.error ? (
            <p className="flex gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {narration.error}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked || busy || narration.status === "processing"}
            onClick={onNarrate}
          >
            <RotateCcw data-icon="inline-start" />
            {narration.url ? "Record again" : "Record narration"}
          </Button>
        </section>

        {/* Footage */}
        <section className="space-y-2" aria-label={`Scene ${number} footage`}>
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <Film className="size-3.5" aria-hidden /> Footage · “{scene.visualQuery}”
          </p>
          {chosen ? (
            <div className="space-y-1.5">
              {previewSrc ? (
                <video
                  key={previewSrc}
                  src={previewSrc}
                  muted
                  controls
                  playsInline
                  preload="metadata"
                  className="aspect-video w-full max-w-sm rounded-md bg-black object-contain"
                  aria-label={`Scene ${number} footage preview`}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Downloaded when the video is rendered.</p>
              )}
              <p className="text-xs" data-testid="scene-footage-label">
                {chosen.label}
                {chosen.durationMs ? ` · ${seconds(chosen.durationMs)}` : ""}
                {chosen.pageUrl ? (
                  <>
                    {" · "}
                    <a href={chosen.pageUrl} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  </>
                ) : null}
              </p>
              {chosen.durationMs !== null && chosen.durationMs - footage.startMs < neededMs ? (
                <p className="text-xs text-muted-foreground">Shorter than the narration, so it will loop.</p>
              ) : null}
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = Number(start);
                  if (Number.isFinite(value) && value >= 0) onStartChange(Math.round(value * 1000));
                }}
              >
                <div className="space-y-1">
                  <Label htmlFor={`start-${scene.id}`} className="text-xs">
                    Start the clip at (seconds)
                  </Label>
                  <Input
                    id={`start-${scene.id}`}
                    value={start}
                    inputMode="decimal"
                    className="h-7 w-24"
                    disabled={locked}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </div>
                <Button type="submit" variant="ghost" size="sm" disabled={locked || busy}>
                  Set
                </Button>
              </form>
            </div>
          ) : null}
          {footage.error ? (
            <p className="flex gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {footage.error}
            </p>
          ) : null}

          {footage.candidates.length > 0 ? (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={`Stock suggestions for scene ${number}`}>
              {footage.candidates.map((candidate) => (
                <li key={`${candidate.provider}-${candidate.providerAssetId}`} className="space-y-1">
                  <span className="relative flex aspect-video items-center justify-center overflow-hidden rounded bg-muted">
                    {candidate.previewImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- Pexels' own image host (CSP allows it)
                      <img src={candidate.previewImageUrl} alt="" className="size-full object-cover" loading="lazy" />
                    ) : (
                      <Film className="size-4 text-muted-foreground" aria-hidden />
                    )}
                    {candidate.chosen ? (
                      <span className="absolute top-1 right-1 rounded-full bg-success p-0.5 text-white">
                        <Check className="size-3" aria-label="Chosen" />
                      </span>
                    ) : null}
                  </span>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {candidate.creatorName} · {seconds(candidate.durationMs)} · {candidate.width}×{candidate.height}
                  </p>
                  <Button
                    type="button"
                    variant={candidate.chosen ? "secondary" : "outline"}
                    size="xs"
                    disabled={locked || busy || candidate.chosen}
                    onClick={() => onChooseStock(candidate.providerAssetId)}
                  >
                    {candidate.chosen ? "In use" : "Use this"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {stockAvailable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked || busy || footage.status === "searching"}
                onClick={onSearch}
              >
                <Search data-icon="inline-start" />
                {footage.candidates.length > 0 ? "Search again" : "Search stock footage"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked || busy || library.length === 0}
              onClick={() => setLibraryOpen(true)}
              title={library.length === 0 ? "No ready videos in your library yet" : undefined}
            >
              <Library data-icon="inline-start" />
              Use a library video
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked || busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload data-icon="inline-start" />
              Upload a clip
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept={CLIP_ACCEPT}
              className="sr-only"
              aria-label={`Upload a clip for scene ${number}`}
              data-testid="scene-clip-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }}
            />
          </div>
        </section>
      </div>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Use a library video for scene {number}</DialogTitle>
            <DialogDescription>
              Your own footage: the scene shows {seconds(neededMs)} of it from the start time you choose, without its
              sound. Avoid shots of someone talking to the camera — with the new narration it can look as if they are
              saying it.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label="Library videos">
            {library.map((video) => (
              <li key={video.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border p-2 text-left text-sm hover:bg-muted/50",
                    libraryVideo === video.id && "border-primary bg-muted",
                  )}
                  onClick={() => setLibraryVideo(video.id)}
                  aria-pressed={libraryVideo === video.id}
                >
                  <span className="flex aspect-video w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                    {video.hasPoster ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                      <img src={`/api/media/videos/${video.id}/poster`} alt="" className="size-full object-cover" />
                    ) : (
                      <Film className="size-4 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{video.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatTimecode(video.durationMs)}
                      {video.generated ? " · generated" : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="space-y-1">
            <Label htmlFor={`library-start-${scene.id}`}>Start at (seconds)</Label>
            <Input
              id={`library-start-${scene.id}`}
              value={libraryStart}
              inputMode="decimal"
              className="w-28"
              onChange={(event) => setLibraryStart(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={!libraryVideo || busy}
              data-testid="use-library-video"
              onClick={() => {
                const value = Number(libraryStart);
                if (!libraryVideo || !Number.isFinite(value) || value < 0) return;
                onChooseLibrary(libraryVideo, Math.round(value * 1000));
                setLibraryOpen(false);
              }}
            >
              Use this video
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
