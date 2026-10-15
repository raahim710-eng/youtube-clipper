import { ArrowLeft, Clapperboard, Download, PenLine, Upload } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ClipsPanel } from "@/components/clips/clips-panel";
import { TranscriptPanel } from "@/components/clips/transcript-panel";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AutoRefresh } from "@/components/videos/auto-refresh";
import { DeleteVideoButton } from "@/components/videos/delete-video-button";
import { DetailTabs } from "@/components/videos/detail-tabs";
import { PlayerProvider, SharedVideo } from "@/components/videos/player-context";
import { ProcessingPanel } from "@/components/videos/processing-panel";
import { VideoDetailsForm } from "@/components/videos/video-details-form";
import { GeneratedBadge, VideoStatusBadge } from "@/components/videos/video-status-badge";
import { formatBytes, formatDuration } from "@/lib/uploads";
import { requireUser } from "@/server/session";
import { getAiSettings, getProviderStatuses } from "@/server/services/ai-providers";
import { getAnalysisState, listClipsForVideo } from "@/server/services/clips";
import { getMediaWorkerState } from "@/server/services/jobs";
import { getTranscriptView } from "@/server/services/transcripts";
import { getVideo } from "@/server/services/videos";

export const metadata: Metadata = { title: "Video" };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export default async function VideoDetailPage({ params }: PageProps<"/videos/[id]">) {
  const user = await requireUser();
  const { id } = await params;
  // getVideo filters by owner: someone else's video ID looks exactly like a missing one.
  const [video, worker] = await Promise.all([getVideo(user.id, id), getMediaWorkerState()]);
  if (!video) notFound();

  const [transcript, clips, analysis, aiSettings, providers] = await Promise.all([
    getTranscriptView(user.id, video.id),
    listClipsForVideo(user.id, video.id),
    getAnalysisState(user.id, video.id),
    getAiSettings(user.id),
    getProviderStatuses(),
  ]);
  const provider = providers.find((p) => p.id === aiSettings.llmProvider) ?? providers[providers.length - 1];

  const transcribeBlocked =
    video.status !== "ready"
      ? "The video needs to finish processing first."
      : video.audioCodec === null
        ? "This video has no audio track, so there's nothing to transcribe."
        : null;
  const busy =
    video.status === "processing" ||
    transcript.status === "processing" ||
    analysis.job?.status === "queued" ||
    analysis.job?.status === "running";

  const details: [string, string][] = [
    ["Duration", formatDuration(video.durationMs)],
    ["Resolution", video.width && video.height ? `${video.width} × ${video.height}` : "–"],
    ["Frame rate", video.fps ? `${video.fps} fps` : "–"],
    ["Video codec", video.videoCodec ?? "–"],
    ["Audio codec", video.audioCodec ?? (video.status === "ready" ? "No audio" : "–")],
    ["Format", video.container.toUpperCase()],
    ["File size", formatBytes(video.sizeBytes)],
    ["Original file", video.originalFilename],
    ["Uploaded", dateFormat.format(new Date(video.createdAt))],
    ["Browser preview", video.hasPreview ? "Created (original isn't browser-friendly)" : "Not needed"],
  ];

  return (
    <PlayerProvider>
      <div className="space-y-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/videos">
            <ArrowLeft data-icon="inline-start" />
            All videos
          </Link>
        </Button>

        <PageHeader
          title={video.title}
          actions={
            <div className="flex items-center gap-2">
              <VideoStatusBadge status={video.status} />
              {video.generated ? <GeneratedBadge /> : null}
              {video.status === "ready" ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/packaging/video/${video.id}`}>
                    <PenLine data-icon="inline-start" />
                    Packaging
                  </Link>
                </Button>
              ) : null}
              {video.status === "ready" ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/youtube/publish/video/${video.id}`}>
                    <Upload data-icon="inline-start" />
                    Publish
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-4 xl:sticky xl:top-20">
            <div className="overflow-hidden rounded-xl border bg-black">
              {video.status === "ready" ? (
                <SharedVideo
                  controls
                  preload="metadata"
                  poster={video.hasPoster ? `/api/media/videos/${video.id}/poster` : undefined}
                  className="aspect-video w-full"
                  src={`/api/media/videos/${video.id}/playback`}
                >
                  Your browser can&apos;t play this video.
                </SharedVideo>
              ) : (
                <div className="flex aspect-video w-full items-center justify-center text-muted-foreground">
                  <Clapperboard className="size-10" aria-hidden />
                </div>
              )}
            </div>

            <ProcessingPanel
              videoId={video.id}
              status={video.status}
              errorMessage={video.errorMessage}
              job={video.job}
              workerOnline={worker.online}
            />
          </div>

          <DetailTabs
            counts={{ toReview: clips.filter((clip) => clip.status === "suggested").length }}
            clips={
              <ClipsPanel
                videoId={video.id}
                clips={clips}
                analysis={analysis}
                transcriptReady={transcript.status === "ready"}
                provider={provider}
              />
            }
            transcript={
              <TranscriptPanel videoId={video.id} transcript={transcript} blockedReason={transcribeBlocked} />
            }
            details={
              <div className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Title and notes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <VideoDetailsForm videoId={video.id} title={video.title} notes={video.notes} />
                  </CardContent>
                </Card>
                {video.creditsText ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Credits</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <pre className="font-sans text-xs whitespace-pre-wrap" data-testid="video-credits">
                        {video.creditsText}
                      </pre>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Made with the Original Video Generator. These credits are added to the description when you
                        publish from the app.
                      </p>
                    </CardContent>
                  </Card>
                ) : null}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Video file</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[140px_1fr]">
                      {details.map(([label, value]) => (
                        <div key={label} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      {video.sourceAvailable ? (
                        <Button variant="outline" asChild>
                          <a href={`/api/media/videos/${video.id}/source?download=1`}>
                            <Download data-icon="inline-start" />
                            Download original
                          </a>
                        </Button>
                      ) : null}
                      <DeleteVideoButton videoId={video.id} title={video.title} />
                    </div>
                  </CardContent>
                </Card>
              </div>
            }
          />
        </div>

        <AutoRefresh active={busy} intervalMs={2500} />
      </div>
    </PlayerProvider>
  );
}
