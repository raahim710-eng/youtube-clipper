import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { formatBytes, formatDuration } from "@/lib/uploads";
import type { VideoSummary } from "@/server/services/videos";
import { GeneratedBadge, VideoStatusBadge } from "./video-status-badge";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function VideoCard({ video }: { video: VideoSummary }) {
  return (
    <Link
      href={`/videos/${video.id}`}
      className="group block overflow-hidden rounded-xl border bg-card transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      data-testid="video-card"
    >
      <div className="relative aspect-video bg-muted">
        {video.hasPoster ? (
          // Served by our authenticated media route; next/image would need a custom loader for it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/media/videos/${video.id}/poster`} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Clapperboard className="size-8" aria-hidden />
          </div>
        )}
        {video.durationMs !== null ? (
          <span className="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-xs text-white">
            {formatDuration(video.durationMs)}
          </span>
        ) : null}
      </div>
      <div className="space-y-2 p-3">
        <p className="line-clamp-2 text-sm font-medium group-hover:underline">{video.title}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <VideoStatusBadge status={video.status} />
          {video.generated ? <GeneratedBadge /> : null}
          <span>{dateFormat.format(new Date(video.createdAt))}</span>
          <span aria-hidden>·</span>
          <span>{formatBytes(video.sizeBytes)}</span>
        </div>
        {video.status === "failed" && video.errorMessage ? (
          <p className="line-clamp-2 text-xs text-destructive">{video.errorMessage}</p>
        ) : null}
      </div>
    </Link>
  );
}
