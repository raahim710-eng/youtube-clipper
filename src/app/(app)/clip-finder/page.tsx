import { Bot, Clapperboard, Scissors } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states/empty-state";
import { TextWithCode } from "@/components/text-with-code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AutoRefresh } from "@/components/videos/auto-refresh";
import { originLabel } from "@/lib/clips";
import { formatTimecode } from "@/lib/time";
import { formatDuration } from "@/lib/uploads";
import { requireUser } from "@/server/session";
import { getAiSettings, getProviderStatuses } from "@/server/services/ai-providers";
import { listClipFinderOverview, listClips } from "@/server/services/clips";

export const metadata: Metadata = { title: "AI Clip Finder" };

const TRANSCRIPT_LABEL = {
  none: "Not transcribed",
  processing: "Transcribing…",
  ready: "Transcribed",
  failed: "Transcription failed",
} as const;

export default async function ClipFinderPage() {
  const user = await requireUser();
  const [videos, toReview, settings, providers] = await Promise.all([
    listClipFinderOverview(user.id),
    listClips(user.id, { status: "suggested", limit: 8 }),
    getAiSettings(user.id),
    getProviderStatuses(),
  ]);
  const provider = providers.find((p) => p.id === settings.llmProvider) ?? providers[providers.length - 1];
  const busy = videos.some((video) => video.transcriptStatus === "processing" || video.analysing);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Clip Finder"
        description="Transcribe your videos and find moments that could work as Shorts. You review every suggestion."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4" aria-hidden />
            {provider.isAi
              ? `AI: ${provider.label}${provider.model ? ` · ${provider.model}` : ""}`
              : "AI is turned off"}
            {provider.ready ? (
              <Badge variant="outline" className="font-normal text-success">
                Ready
              </Badge>
            ) : (
              <Badge variant="outline" className="font-normal text-warning">
                Needs setup
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {provider.ready ? (
              `${provider.privacy} ${provider.cost}`
            ) : (
              <>
                {provider.problem} <TextWithCode text={provider.fix ?? ""} />
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/ai">AI & processing settings</Link>
          </Button>
        </CardContent>
      </Card>

      {videos.length === 0 ? (
        <EmptyState
          icon={Clapperboard}
          title="No videos yet"
          description="Upload a video first. It's transcribed automatically, then you can find clips in it."
          action={
            <Button asChild>
              <Link href="/videos">Go to Videos</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your videos</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y">
                {videos.map((video) => (
                  <li key={video.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{video.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDuration(video.durationMs)} ·{" "}
                        {video.status !== "ready" ? "Video still processing" : TRANSCRIPT_LABEL[video.transcriptStatus]}
                        {video.analysing ? " · finding clips…" : ""}
                        {video.toReview > 0 ? ` · ${video.toReview} to review` : ""}
                        {video.accepted > 0 ? ` · ${video.accepted} accepted` : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        href={`/videos/${video.id}?tab=${video.transcriptStatus === "ready" ? "clips" : "transcript"}`}
                      >
                        {video.transcriptStatus === "ready" ? "Open clips" : "Open"}
                      </Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Waiting for your review</CardTitle>
              <CardDescription>Highest-scoring suggestions across all videos.</CardDescription>
            </CardHeader>
            <CardContent>
              {toReview.length === 0 ? (
                <EmptyState
                  icon={Scissors}
                  title="Nothing to review"
                  description="Open a transcribed video and choose Find clips."
                  className="border-dashed p-4"
                />
              ) : (
                <ul className="space-y-3">
                  {toReview.map((clip) => (
                    <li key={clip.id}>
                      <Link
                        href={`/videos/${clip.videoId}?tab=clips`}
                        className="block rounded-lg border p-3 transition-colors hover:bg-muted/50"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium">{clip.title}</p>
                          {clip.score !== null ? (
                            <span className="text-sm font-semibold tabular-nums">{clip.score}</span>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {clip.videoTitle} · {formatTimecode(clip.startMs)}–{formatTimecode(clip.endMs)} ·{" "}
                          {originLabel(clip)}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <AutoRefresh active={busy} intervalMs={4000} />
    </div>
  );
}
