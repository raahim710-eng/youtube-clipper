import { Clapperboard, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { CreateShortButton } from "@/components/shorts/create-short-button";
import { ShortStatusBadge } from "@/components/shorts/short-status-badge";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { originLabel } from "@/lib/clips";
import type { ClipOrigin } from "@/lib/constants";
import { findNavItem } from "@/lib/navigation";
import { formatTimecode } from "@/lib/time";
import { requireUser } from "@/server/session";
import { listClipsWithoutShort, listShorts } from "@/server/services/shorts";

const item = findNavItem("/shorts");

export const metadata: Metadata = { title: item.title };

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

/** Shorts Editor home: your Shorts, and accepted clips waiting to become one (D-037). */
export default async function ShortsPage() {
  const user = await requireUser();
  const [shorts, queue] = await Promise.all([listShorts(user.id), listClipsWithoutShort(user.id)]);

  return (
    <div className="space-y-6">
      <PageHeader title={item.title} description={item.description} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clips ready for editing ({queue.length})</CardTitle>
          <CardDescription>
            Clips you accepted in the AI Clip Finder. Create a Short to add captions, choose the framing and export it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {queue.length === 0 ? (
            <EmptyState
              icon={Smartphone}
              title="No clips waiting"
              description="Accept suggestions in the AI Clip Finder (or make your own clip from a transcript) and they'll appear here."
              action={
                <Button variant="outline" asChild>
                  <Link href="/clip-finder">Open the AI Clip Finder</Link>
                </Button>
              }
              className="border-dashed"
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" aria-label="Clips ready for editing">
              {queue.map((clip) => (
                <li key={clip.id} className="flex gap-3 rounded-lg border p-3">
                  <span className="flex aspect-video w-24 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                    {clip.video.posterPath ? (
                      // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                      <img src={`/api/media/videos/${clip.videoId}/poster`} alt="" className="size-full object-cover" />
                    ) : (
                      <Clapperboard className="size-4 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium">{clip.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {clip.video.title} · {formatTimecode(clip.startMs)}–{formatTimecode(clip.endMs)} (
                      {Math.round((clip.endMs - clip.startMs) / 1000)} s)
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {originLabel({ origin: clip.origin as ClipOrigin, provider: clip.provider, model: clip.model })}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <CreateShortButton clipId={clip.id} />
                      <Link href={`/videos/${clip.videoId}?tab=clips`} className="text-xs underline underline-offset-2">
                        Review in the video
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Shorts ({shorts.length})</CardTitle>
          <CardDescription>Open a Short to edit it, export it or download the finished MP4.</CardDescription>
        </CardHeader>
        <CardContent>
          {shorts.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No Shorts yet. Create one from a clip above.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5" aria-label="Your Shorts">
              {shorts.map((short) => (
                <li key={short.id}>
                  <Link
                    href={`/shorts/${short.id}`}
                    className="group block space-y-2 rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="relative flex aspect-9/16 items-center justify-center overflow-hidden rounded-lg bg-muted">
                      {short.hasPoster ? (
                        // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                        <img
                          src={`/api/media/videos/${short.videoId}/poster`}
                          alt=""
                          className="size-full object-cover transition-transform group-hover:scale-[1.02]"
                          style={{
                            objectPosition: `${Math.round((short.reframeMode === "manual" ? short.manualX : 0.5) * 100)}% 50%`,
                          }}
                        />
                      ) : (
                        <Smartphone className="size-5 text-muted-foreground" aria-hidden />
                      )}
                      <span className="absolute top-2 left-2">
                        <ShortStatusBadge status={short.status} stale={short.stale} />
                      </span>
                    </span>
                    <span className="block truncate text-sm font-medium">{short.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {Math.round((short.endMs - short.startMs) / 1000)} s · {short.videoTitle} ·{" "}
                      {dateFormat.format(new Date(short.updatedAt))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
