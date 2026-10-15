import { AlertCircle, Clapperboard, MonitorPlay, Smartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PublicationList } from "@/components/youtube/publication-list";
import { QuotaSummary } from "@/components/youtube/quota-summary";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findNavItem } from "@/lib/navigation";
import { requireUser } from "@/server/session";
import { getYouTubeSetup, listChannels, listPublications } from "@/server/services/youtube";
import { quotaStatus } from "@/server/youtube/quota";

const item = findNavItem("/youtube");

export const metadata: Metadata = { title: item.title };

/** YouTube: connected channels at a glance, today's quota, and every upload with its status (YT-04…07). */
export default async function YouTubePage() {
  const user = await requireUser();
  const setup = getYouTubeSetup();
  const [channels, publications, quota] = await Promise.all([
    listChannels(user.id),
    listPublications(user.id),
    quotaStatus(),
  ]);
  const active = channels.filter((c) => c.status === "active");
  const needsReconnect = channels.filter((c) => c.status === "reauth_required");

  return (
    <div className="space-y-6">
      <PageHeader
        title={item.title}
        description={item.description}
        actions={
          <Button variant="outline" asChild>
            <Link href="/settings/channels">
              <MonitorPlay data-icon="inline-start" />
              Channels
            </Link>
          </Button>
        }
      />

      {!setup.configured ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>Connect YouTube to publish</AlertTitle>
          <AlertDescription>
            Google sign-in isn&apos;t set up yet. Follow README › Google Cloud setup (free), then connect your channel
            in{" "}
            <Link href="/settings/channels" className="underline underline-offset-2">
              Settings › Channels
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : active.length === 0 ? (
        <Alert>
          <AlertCircle />
          <AlertTitle>No channel connected</AlertTitle>
          <AlertDescription>
            <Link href="/settings/channels" className="underline underline-offset-2">
              Connect a YouTube channel
            </Link>{" "}
            to upload videos and Shorts.
          </AlertDescription>
        </Alert>
      ) : null}
      {needsReconnect.length > 0 ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>{needsReconnect.map((c) => c.title).join(", ")} needs reconnecting</AlertTitle>
          <AlertDescription>
            Google stopped accepting the saved sign-in (expected about weekly while your Google project is in Testing
            mode).{" "}
            <Link href="/settings/channels" className="underline underline-offset-2">
              Reconnect
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Uploads</CardTitle>
            <CardDescription>
              Publish from a finished Short (Shorts Editor › Export › Publish) or a library video (its page › Publish).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {publications.length === 0 ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" asChild>
                  <Link href="/shorts">
                    <Smartphone data-icon="inline-start" />
                    Choose a Short
                  </Link>
                </Button>
                <Button variant="outline" asChild>
                  <Link href="/videos">
                    <Clapperboard data-icon="inline-start" />
                    Choose a video
                  </Link>
                </Button>
              </div>
            ) : (
              <PublicationList initial={publications} />
            )}
          </CardContent>
        </Card>
        <QuotaSummary quota={quota} audited={setup.audited} />
      </div>
    </div>
  );
}
