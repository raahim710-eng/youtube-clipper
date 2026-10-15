import { Clapperboard, SearchX } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states/empty-state";
import { AutoRefresh } from "@/components/videos/auto-refresh";
import { LibraryToolbar } from "@/components/videos/library-toolbar";
import { UploadPanel } from "@/components/videos/upload-panel";
import { VideoCard } from "@/components/videos/video-card";
import { WorkerOfflineNotice } from "@/components/videos/worker-offline-notice";
import { formatBytes } from "@/lib/uploads";
import { getUploadLimits } from "@/server/env";
import { requireUser } from "@/server/session";
import { getMediaWorkerState } from "@/server/services/jobs";
import { listIncompleteUploads, sweepStaleUploads } from "@/server/services/uploads";
import { getLibraryStats, libraryQuerySchema, listVideos } from "@/server/services/videos";

export const metadata: Metadata = { title: "Videos" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function VideosPage({ searchParams }: PageProps<"/videos">) {
  const user = await requireUser();
  const raw = await searchParams;
  const query = libraryQuerySchema.parse({ q: first(raw.q), sort: first(raw.sort), status: first(raw.status) });

  await sweepStaleUploads();
  const [videos, stats, incomplete, worker] = await Promise.all([
    listVideos(user.id, query),
    getLibraryStats(user.id),
    listIncompleteUploads(user.id),
    getMediaWorkerState(),
  ]);
  const filtered = Boolean(query.q) || query.status !== "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Videos"
        description={
          stats.count > 0
            ? `${stats.count} ${stats.count === 1 ? "video" : "videos"} · ${formatBytes(stats.totalBytes)} of original files on this computer`
            : "Upload the videos you want to turn into Shorts, package and publish."
        }
      />

      {stats.processing > 0 && !worker.online ? <WorkerOfflineNotice /> : null}

      <UploadPanel
        limits={getUploadLimits()}
        incomplete={incomplete.map((upload) => ({
          id: upload.id,
          originalFilename: upload.originalFilename,
          totalBytes: upload.totalBytes,
          receivedChunks: upload.receivedChunks.length,
          totalChunks: upload.totalChunks,
        }))}
      />

      {stats.count > 0 ? <LibraryToolbar /> : null}

      {videos.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Video library">
          {videos.map((video) => (
            <li key={video.id}>
              <VideoCard video={video} />
            </li>
          ))}
        </ul>
      ) : filtered ? (
        <EmptyState icon={SearchX} title="No matching videos" description="Try a different search or filter." />
      ) : (
        <EmptyState
          icon={Clapperboard}
          title="Your library is empty"
          description="Upload a video above. It will be checked and prepared automatically."
        />
      )}

      <AutoRefresh active={stats.processing > 0} />
    </div>
  );
}
