"use client";

import { AlertCircle, Download, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { type ExportQuality, REFRAME_MODE_LABELS, type ReframeMode } from "@/lib/constants";
import { formatBytes } from "@/lib/uploads";
import type { ShortStatusView } from "@/server/services/shorts";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function seconds(ms: number): string {
  return ms >= 60_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
    : `${Math.round(ms / 100) / 10} s`;
}

/** Export tab (SHORT-05, SHORT-07): what the file will be, progress, errors and the finished MP4. */
export function ExportPanel({
  render,
  quality,
  lengthMs,
  fps,
  hasAudio,
  captionsOn,
  mode,
  blockedReason,
  busy,
  packagingHref,
  publishHref,
  onQualityChange,
  onExport,
  onCancel,
}: {
  render: ShortStatusView["render"];
  quality: ExportQuality;
  lengthMs: number;
  fps: number | null;
  hasAudio: boolean;
  captionsOn: boolean;
  mode: ReframeMode;
  blockedReason: string | null;
  busy: boolean;
  packagingHref: string;
  publishHref: string;
  onQualityChange: (quality: ExportQuality) => void;
  onExport: () => void;
  onCancel: (jobId: string) => void;
}) {
  const job = render.job;
  const settings: [string, string][] = [
    ["Format", "MP4 — H.264 video" + (hasAudio ? ", AAC audio (48 kHz, stereo)" : ", no audio track")],
    ["Size", "1080 × 1920 (vertical 9:16)"],
    [
      "Frame rate",
      fps ? `${Math.min(Math.round(fps * 100) / 100, 60)} fps (same as the video, at most 60)` : "Same as the video",
    ],
    ["Length", seconds(lengthMs)],
    ["Framing", REFRAME_MODE_LABELS[mode]],
    ["Captions", captionsOn ? "Burned into the picture" : "Off"],
  ];

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {settings.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2">
        <Label>Quality</Label>
        <RadioGroup
          value={quality}
          onValueChange={(value) => onQualityChange(value as ExportQuality)}
          className="gap-2"
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem value="standard" id="quality-standard" className="mt-0.5" />
            <Label htmlFor="quality-standard" className="block font-normal">
              <span className="font-medium">Standard</span> — quickest; good for uploading.
            </Label>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem value="high" id="quality-high" className="mt-0.5" />
            <Label htmlFor="quality-high" className="block font-normal">
              <span className="font-medium">High</span> — a little sharper, takes about 2–3× longer.
            </Label>
          </div>
        </RadioGroup>
      </div>

      {job ? (
        <div className="space-y-2 rounded-lg border p-3" role="status" data-testid="export-progress">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {job.status === "queued" ? "Waiting for the media worker…" : "Exporting…"}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => onCancel(job.id)}>
              <X data-icon="inline-start" />
              Cancel
            </Button>
          </div>
          <Progress value={job.progress} aria-label="Export progress" />
          <p className="text-xs text-muted-foreground">
            {job.progress}% {job.message ? `· ${job.message}` : ""}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Button
            type="button"
            onClick={onExport}
            disabled={Boolean(blockedReason) || busy}
            data-testid="export-button"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {render.output ? "Export again" : "Export MP4"}
          </Button>
          {blockedReason ? <p className="text-xs text-muted-foreground">{blockedReason}</p> : null}
        </div>
      )}

      {render.status === "failed" && render.error && !job ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>The export failed</AlertTitle>
          <AlertDescription>
            <p>{render.error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onExport}
              disabled={Boolean(blockedReason)}
            >
              <RotateCcw data-icon="inline-start" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {render.output ? (
        <div className="space-y-3 border-t pt-4" data-testid="export-result">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">Finished Short</p>
            {render.stale ? (
              <Badge variant="outline" className="border-warning text-warning" data-testid="export-stale">
                Out of date — changed since this export
              </Badge>
            ) : (
              <Badge variant="outline" className="border-success text-success">
                Up to date
              </Badge>
            )}
          </div>
          <video
            key={render.output.url}
            src={render.output.url}
            controls
            preload="metadata"
            playsInline
            className="aspect-9/16 w-full max-w-56 rounded-md bg-black"
            aria-label="Exported Short"
          />
          <p className="text-xs text-muted-foreground">
            {formatBytes(render.output.sizeBytes)}
            {render.output.durationMs ? ` · ${seconds(render.output.durationMs)}` : ""} · exported{" "}
            {dateFormat.format(new Date(render.output.renderedAt))}
            {render.output.elapsedMs ? ` in ${seconds(render.output.elapsedMs)}` : ""}
          </p>
          <Button asChild variant="outline">
            <a href={render.output.downloadUrl} download data-testid="download-short">
              <Download data-icon="inline-start" />
              Download MP4
            </a>
          </Button>
          <Button asChild variant="ghost">
            <Link href={packagingHref}>Package this Short</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href={publishHref}>Publish to YouTube</Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
