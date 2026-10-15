import { Clapperboard } from "lucide-react";
import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { VideoStatusBadge } from "@/components/videos/video-status-badge";
import { formatDuration } from "@/lib/uploads";
import type { JobSummary } from "@/server/services/jobs";
import type { ClipWithVideo } from "@/server/services/clips";
import type { VideoSummary } from "@/server/services/videos";
import { originLabel } from "@/lib/clips";
import { formatTimecode } from "@/lib/time";

/** DASH-02: active jobs with progress, linking to their video. */
export function ActiveJobsList({ jobs }: { jobs: JobSummary[] }) {
  return (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.id} className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            {job.entityType === "video" && job.entityId ? (
              <Link href={`/videos/${job.entityId}`} className="truncate font-medium hover:underline">
                {job.entityTitle ?? job.label}
              </Link>
            ) : (
              <span className="truncate font-medium">{job.label}</span>
            )}
            <span className="shrink-0 text-xs text-muted-foreground">
              {job.status === "running" ? `${job.progress}%` : "Waiting"}
            </span>
          </div>
          <Progress value={job.status === "running" ? job.progress : 0} aria-label={`${job.label} progress`} />
          <p className="text-xs text-muted-foreground">{job.progressMessage ?? job.label}</p>
        </li>
      ))}
    </ul>
  );
}

/** DASH-03: the latest library videos. */
export function RecentVideosList({ videos }: { videos: VideoSummary[] }) {
  return (
    <ul className="space-y-2">
      {videos.map((video) => (
        <li key={video.id}>
          <Link href={`/videos/${video.id}`} className="flex items-center gap-3 rounded-lg p-1 hover:bg-muted/50">
            <span className="flex aspect-video w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
              {video.hasPoster ? (
                // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                <img src={`/api/media/videos/${video.id}/poster`} alt="" className="size-full object-cover" />
              ) : (
                <Clapperboard className="size-4 text-muted-foreground" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{video.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <VideoStatusBadge status={video.status} />
                {video.durationMs !== null ? formatDuration(video.durationMs) : null}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** DASH-03: the best clip suggestions still waiting for review. */
export function ClipsToReviewList({ clips }: { clips: ClipWithVideo[] }) {
  return (
    <ul className="space-y-2">
      {clips.map((clip) => (
        <li key={clip.id}>
          <Link href={`/videos/${clip.videoId}?tab=clips`} className="block rounded-lg p-1 hover:bg-muted/50">
            <span className="flex items-start justify-between gap-2">
              <span className="truncate text-sm font-medium">{clip.title}</span>
              {clip.score !== null ? <span className="text-sm font-semibold tabular-nums">{clip.score}</span> : null}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {clip.videoTitle} · {formatTimecode(clip.startMs)} · {originLabel(clip)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
