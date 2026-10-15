"use client";

import { Download, Music, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { CopyButton } from "@/components/packaging/copy-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { frameSize } from "@/lib/generator/timeline";
import { formatBytes } from "@/lib/uploads";
import type { ProjectView } from "@/server/services/generator";

const MUSIC_ACCEPT = ".mp3,.wav,.m4a,.ogg,audio/mpeg,audio/wav,audio/mp4,audio/ogg";
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

function seconds(ms: number): string {
  return ms >= 60_000
    ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
    : `${Math.round(ms / 100) / 10} s`;
}

/** Render step (GEN-05, GEN-06): what the file will be, optional music, the render and the finished video. */
export function RenderPanel({
  project,
  busy,
  onRender,
  onUploadMusic,
  onRemoveMusic,
  onMusicVolume,
}: {
  project: ProjectView;
  busy: boolean;
  onRender: () => void;
  onUploadMusic: (file: File) => void;
  onRemoveMusic: () => void;
  onMusicVolume: (volumeDb: number) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { settings } = project;
  const size = frameSize(settings.aspectRatio, settings.resolution);
  const rendering = project.jobs.some((job) => job.type === "gen.render");
  const output = project.output;
  const facts: [string, string][] = [
    ["Format", "MP4 — H.264 video, AAC audio (48 kHz stereo), 30 fps"],
    ["Size", `${size.width} × ${size.height} (${settings.aspectRatio === "9:16" ? "vertical" : "landscape"})`],
    ["Length", `about ${seconds(project.estimatedDurationMs)} (the narration plus a short fade at the end)`],
    ["Scenes", `${project.scenes.length}, joined with 0.4 s crossfades`],
    ["Captions", settings.captionsEnabled ? "Burned in, timed to the narration" : "Off"],
    ["Quality", settings.quality === "high" ? "High" : "Standard"],
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section className="space-y-2 rounded-lg border p-3" aria-label="Background music">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Music className="size-4" aria-hidden /> Background music (optional)
        </p>
        <p className="text-xs text-muted-foreground">
          Only use music you have the rights to — for example from the YouTube Audio Library. It loops under the
          narration and is turned down automatically while the voice speaks.
        </p>
        {project.music ? (
          <div className="space-y-2">
            <audio src={project.music.url} controls preload="none" className="w-full" />
            <Label htmlFor="music-volume" className="text-xs">
              Music volume: {project.music.volumeDb} dB
            </Label>
            <Slider
              id="music-volume"
              min={-40}
              max={0}
              step={1}
              defaultValue={[project.music.volumeDb]}
              onValueCommit={([value]) => onMusicVolume(value ?? -18)}
              disabled={busy || rendering}
              aria-label="Music volume"
            />
            <Button type="button" variant="ghost" size="sm" disabled={busy || rendering} onClick={onRemoveMusic}>
              <Trash2 data-icon="inline-start" />
              Remove music
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || rendering}
            onClick={() => fileInput.current?.click()}
          >
            Add music
          </Button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={MUSIC_ACCEPT}
          className="sr-only"
          aria-label="Upload background music"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUploadMusic(file);
            event.target.value = "";
          }}
        />
      </section>

      {!rendering ? (
        <div className="space-y-2">
          <Button
            type="button"
            onClick={onRender}
            disabled={busy || Boolean(project.renderBlocked)}
            data-testid="render-button"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {output ? "Render again" : "Render the video"}
          </Button>
          {project.renderBlocked ? (
            <p className="text-xs text-muted-foreground" data-testid="render-blocked">
              {project.renderBlocked}
            </p>
          ) : output ? (
            <p className="text-xs text-muted-foreground">Rendering again adds a new video to your library.</p>
          ) : null}
        </div>
      ) : null}

      {output ? (
        <section className="space-y-3 border-t pt-4" aria-label="Finished video" data-testid="render-result">
          <p className="text-sm font-medium">Finished video</p>
          <video
            key={output.url}
            src={output.url}
            controls
            preload="metadata"
            playsInline
            className={
              settings.aspectRatio === "9:16"
                ? "aspect-9/16 w-full max-w-64 rounded-md bg-black"
                : "aspect-video w-full max-w-xl rounded-md bg-black"
            }
            aria-label="Generated video"
          />
          <p className="text-xs text-muted-foreground">
            {formatBytes(output.sizeBytes)}
            {output.durationMs ? ` · ${seconds(output.durationMs)}` : ""}
            {output.renderedAt ? ` · rendered ${dateFormat.format(new Date(output.renderedAt))}` : ""}
            {output.elapsedMs ? ` in ${seconds(output.elapsedMs)}` : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href={output.downloadUrl} download data-testid="download-generated">
                <Download data-icon="inline-start" />
                Download MP4
              </a>
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/videos/${output.videoId}`}>Open in Videos</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/packaging/video/${output.videoId}`}>Package it</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/youtube/publish/video/${output.videoId}`}>Publish to YouTube</Link>
            </Button>
          </div>
          {output.status === "processing" ? (
            <p className="text-xs text-muted-foreground">The library is still preparing its preview and poster.</p>
          ) : null}
        </section>
      ) : null}

      {project.creditsText ? (
        <section className="space-y-2" aria-label="Credits">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Credits for the description</p>
            <CopyButton text={project.creditsText} label="Copy credits" what="Credits" />
          </div>
          <pre className="rounded-md bg-muted p-3 font-sans text-xs whitespace-pre-wrap" data-testid="credits-text">
            {project.creditsText}
          </pre>
          <p className="text-xs text-muted-foreground">
            Added to the description automatically when you publish this video from the app.
          </p>
        </section>
      ) : null}
    </div>
  );
}
