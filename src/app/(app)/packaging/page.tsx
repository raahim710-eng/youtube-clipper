import { Clapperboard, PenLine, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findNavItem } from "@/lib/navigation";
import { formatTimecode } from "@/lib/time";
import { requireUser } from "@/server/session";
import { listPackagingTargets, type PackagingTargetSummary } from "@/server/services/packaging";

const item = findNavItem("/packaging");

export const metadata: Metadata = { title: item.title };

const STATUS: Record<NonNullable<PackagingTargetSummary["lastStatus"]>, string> = {
  processing: "Writing…",
  ready: "Ready",
  failed: "Failed",
};

/** AI Packaging home: every Short and library video, with its packaging status (PKG-01). */
export default async function PackagingPage() {
  const user = await requireUser();
  const targets = await listPackagingTargets(user.id);
  const shorts = targets.filter((t) => t.kind === "short");
  const videos = targets.filter((t) => t.kind === "video");

  return (
    <div className="space-y-6">
      <PageHeader title={item.title} description={item.description} />
      {targets.length === 0 ? (
        <EmptyState
          icon={PenLine}
          title="Nothing to package yet"
          description="Upload a video (it's transcribed automatically) or make a Short, then write titles, descriptions and thumbnails for it here."
          action={
            <Button asChild>
              <Link href="/videos">Go to Videos</Link>
            </Button>
          }
        />
      ) : null}
      {shorts.length > 0 ? <TargetList title="Shorts" icon={Smartphone} targets={shorts} /> : null}
      {videos.length > 0 ? <TargetList title="Videos" icon={Clapperboard} targets={videos} /> : null}
    </div>
  );
}

function TargetList({
  title,
  icon: Icon,
  targets,
}: {
  title: string;
  icon: typeof Smartphone;
  targets: PackagingTargetSummary[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {title} ({targets.length})
        </CardTitle>
        <CardDescription>
          {title === "Shorts"
            ? "Written from each Short's own captions."
            : "Written from the full transcript; long videos also get chapters."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y" aria-label={title}>
          {targets.map((target) => (
            <li key={`${target.kind}:${target.id}`} className="flex items-center gap-3 py-3">
              <span className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                {target.hasPoster ? (
                  // eslint-disable-next-line @next/next/no-img-element -- authenticated media route
                  <img src={`/api/media/videos/${target.videoId}/poster`} alt="" className="size-full object-cover" />
                ) : (
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{target.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {target.kind === "short" ? `From ${target.videoTitle} · ` : ""}
                  {formatTimecode(target.durationMs)}
                  {target.preferredTitle ? ` · Chosen title: “${target.preferredTitle}”` : ""}
                </p>
              </div>
              {target.lastStatus ? (
                <Badge variant="outline" className="font-normal">
                  {STATUS[target.lastStatus]} · {target.sets} {target.sets === 1 ? "version" : "versions"}
                </Badge>
              ) : null}
              <Button size="sm" variant={target.sets > 0 ? "outline" : "default"} asChild>
                <Link href={target.packagingHref}>{target.sets > 0 ? "Open" : "Write packaging"}</Link>
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
