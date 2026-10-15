"use client";

import { Check, Download, ImagePlus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteThumbnailAction, requestThumbnailAction, selectThumbnailAction } from "@/app/(app)/packaging/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { THUMBNAIL_ORIGIN_LABELS } from "@/lib/constants";
import { cleanHeadline, HEADLINE_MAX_WORDS } from "@/lib/packaging/limits";
import { formatTimecode } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { PackagingTarget, ThumbnailView } from "@/server/services/packaging";

/**
 * Thumbnails (PKG-06, D-016): a frame from the video, a mock-up (frame + headline drawn by this app) or the
 * creator's own image. Nothing here is an AI-generated picture, and the labels say so.
 */
export function ThumbnailsPanel({
  target,
  thumbnails,
  setId,
  request,
  headline,
  onHeadlineChange,
  onChanged,
}: {
  target: PackagingTarget;
  thumbnails: ThumbnailView[];
  setId: string | null;
  /** Show a frame suggested by a concept card. */
  request: { frameMs: number | null; nonce: number } | null;
  headline: string;
  onHeadlineChange: (headline: string) => void;
  onChanged: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [currentMs, setCurrentMs] = useState(target.startMs);
  const [pending, startTransition] = useTransition();
  const vertical = target.kind === "short";

  useEffect(() => {
    if (!request) return;
    if (request.frameMs !== null && videoRef.current) videoRef.current.currentTime = request.frameMs / 1000;
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [request]);

  function make(mode: "frame" | "mockup") {
    startTransition(async () => {
      const result = await requestThumbnailAction(target.kind, target.id, {
        mode,
        frameMs: Math.round(currentMs),
        headline: mode === "mockup" ? headline : null,
        packagingSetId: setId,
      });
      if (!result.ok) toast.error(result.error);
      else toast.success(mode === "mockup" ? "Making the mock-up…" : "Saving the frame…");
      onChanged();
    });
  }

  function upload(file: File) {
    startTransition(async () => {
      if (!["image/jpeg", "image/png"].includes(file.type)) {
        toast.error("Choose a JPEG or PNG image.");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error("Images can be up to 10 MB.");
        return;
      }
      const response = await fetch(`/api/packaging/${target.kind}/${target.id}/thumbnails`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? "The image couldn't be uploaded.");
      } else {
        toast.success("Image uploaded — checking and resizing it…");
      }
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
    });
  }

  const words = cleanHeadline(headline).split(" ").filter(Boolean).length;

  return (
    <Card ref={panelRef}>
      <CardHeader>
        <CardTitle className="text-base">Thumbnails</CardTitle>
        <CardDescription>
          Pick a frame from your video and add a headline, or upload your own image. Mock-ups are your real video frame
          with text drawn by this app — no AI image generation. Saved as{" "}
          {vertical ? "720 × 1280 (vertical, for the Short)" : "1280 × 720"} JPEG under 2 MB.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
          <div className="space-y-2">
            <video
              ref={videoRef}
              src={`/api/media/videos/${target.videoId}/playback`}
              controls
              preload="metadata"
              playsInline
              muted
              className="aspect-video w-full rounded-md bg-black"
              aria-label="Choose a frame"
              onLoadedMetadata={(event) => {
                if (target.kind === "short") event.currentTarget.currentTime = target.startMs / 1000;
              }}
              onTimeUpdate={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
              onSeeked={(event) => setCurrentMs(event.currentTarget.currentTime * 1000)}
              data-testid="frame-picker"
            />
            <p className="text-xs text-muted-foreground">
              Frame at {formatTimecode(currentMs)}
              {target.kind === "short"
                ? ` · the Short runs ${formatTimecode(target.startMs)}–${formatTimecode(target.endMs)}`
                : ""}
            </p>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="thumbnail-headline">Headline (up to {HEADLINE_MAX_WORDS} words)</Label>
              <Input
                id="thumbnail-headline"
                value={headline}
                maxLength={80}
                onChange={(event) => onHeadlineChange(event.target.value)}
                placeholder="e.g. Edit twice as fast"
              />
              <p className={cn("text-xs", words > HEADLINE_MAX_WORDS ? "text-warning" : "text-muted-foreground")}>
                {words > HEADLINE_MAX_WORDS
                  ? `Only the first ${HEADLINE_MAX_WORDS} words will be used.`
                  : "Short and bold reads best on a phone."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => make("mockup")} disabled={pending || !headline.trim()}>
                {pending ? <Spinner data-icon="inline-start" /> : <ImagePlus data-icon="inline-start" />}
                Make mock-up
              </Button>
              <Button type="button" variant="outline" onClick={() => make("frame")} disabled={pending}>
                Save frame only
              </Button>
            </div>
            <div className="border-t pt-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png"
                className="sr-only"
                id="thumbnail-upload"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                }}
                data-testid="thumbnail-upload"
              />
              <Button type="button" variant="outline" disabled={pending} onClick={() => fileRef.current?.click()}>
                <Upload data-icon="inline-start" />
                Upload your own image
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                JPEG or PNG up to 10 MB. It&apos;s cropped to the thumbnail shape and saved again as JPEG (hidden
                metadata such as location is removed).
              </p>
            </div>
          </div>
        </div>

        {thumbnails.length > 0 ? (
          <ul
            className={cn(
              "grid gap-3",
              vertical ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-6" : "sm:grid-cols-2 lg:grid-cols-3",
            )}
            aria-label="Your thumbnails"
          >
            {thumbnails.map((thumbnail) => (
              <ThumbnailCard key={thumbnail.id} thumbnail={thumbnail} vertical={vertical} onChanged={onChanged} />
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No thumbnails yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ThumbnailCard({
  thumbnail,
  vertical,
  onChanged,
}: {
  thumbnail: ThumbnailView;
  vertical: boolean;
  onChanged: () => void;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <li
      className={cn("space-y-2 rounded-lg border p-2", thumbnail.selected && "border-primary ring-2 ring-primary/30")}
      data-testid="thumbnail-card"
    >
      <div
        className={cn(
          "flex items-center justify-center overflow-hidden rounded bg-muted",
          vertical ? "aspect-9/16" : "aspect-video",
        )}
      >
        {thumbnail.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
          <img src={thumbnail.url} alt={thumbnail.headline ?? "Thumbnail"} className="size-full object-cover" />
        ) : thumbnail.status === "failed" ? (
          <p className="p-2 text-center text-xs text-destructive">{thumbnail.error}</p>
        ) : (
          <Spinner />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="outline" className="font-normal">
          {THUMBNAIL_ORIGIN_LABELS[thumbnail.origin]}
        </Badge>
        {thumbnail.selected ? (
          <Badge variant="outline" className="border-success font-normal text-success">
            Chosen
          </Badge>
        ) : null}
        {thumbnail.sourceFrameMs !== null ? (
          <span className="text-muted-foreground">at {formatTimecode(thumbnail.sourceFrameMs)}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant={thumbnail.selected ? "secondary" : "outline"}
          disabled={pending || thumbnail.status !== "ready" || thumbnail.selected}
          onClick={() =>
            startTransition(async () => {
              const result = await selectThumbnailAction(thumbnail.id);
              if (!result.ok) toast.error(result.error);
              onChanged();
            })
          }
        >
          <Check data-icon="inline-start" />
          {thumbnail.selected ? "Chosen" : "Use this"}
        </Button>
        {thumbnail.downloadUrl ? (
          <Button type="button" size="icon-sm" variant="ghost" asChild>
            <a href={thumbnail.downloadUrl} download aria-label="Download thumbnail">
              <Download />
            </a>
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Delete thumbnail"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteThumbnailAction(thumbnail.id);
              if (!result.ok) toast.error(result.error);
              onChanged();
            })
          }
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}
