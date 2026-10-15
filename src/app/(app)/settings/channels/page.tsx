import { AlertCircle, CheckCircle2, MonitorPlay } from "lucide-react";
import type { Metadata } from "next";
import { ChannelList } from "@/components/youtube/channel-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/server/session";
import { getYouTubeSetup, listChannels } from "@/server/services/youtube";

export const metadata: Metadata = { title: "Channels" };

/** Settings › Channels (YT-01…03): connect with Google's own sign-in, see status, reconnect, disconnect. */
export default async function ChannelSettingsPage({ searchParams }: PageProps<"/settings/channels">) {
  const user = await requireUser();
  const params = await searchParams;
  const setup = getYouTubeSetup();
  const channels = await listChannels(user.id);
  const connected = typeof params.connected === "string" ? Number(params.connected) : 0;
  const error = typeof params.error === "string" ? params.error.slice(0, 300) : null;

  return (
    <div className="space-y-6">
      {connected > 0 ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>{connected === 1 ? "Channel connected" : `${connected} channels connected`}</AlertTitle>
          <AlertDescription>You can now upload videos and Shorts to it from the app.</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>The channel wasn&apos;t connected</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">YouTube channels</CardTitle>
          <CardDescription>
            Connect with Google&apos;s own sign-in page. The app never sees your Google password; it asks only to see
            your channel and upload videos. Access tokens are stored encrypted on this computer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!setup.configured ? (
            <Alert>
              <MonitorPlay />
              <AlertTitle>Google sign-in isn&apos;t set up yet</AlertTitle>
              <AlertDescription>
                <p>
                  Create a free Google Cloud project and OAuth client (README › Google Cloud setup), put the values in{" "}
                  <code>.env</code> and restart the app. Missing:
                </p>
                <ul className="list-disc pl-5">
                  {setup.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {setup.usingTestServer ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Test mode</AlertTitle>
              <AlertDescription>
                GOOGLE_API_TEST_BASE_URL is set, so Google requests go to a local test stand-in. Remove it from .env for
                real channels.
              </AlertDescription>
            </Alert>
          ) : null}

          <ChannelList channels={channels} canConnect={setup.configured} />

          {setup.configured ? (
            <Button asChild>
              {/* A full navigation: Google's sign-in page can't be shown inside the app. */}
              <a href="/api/youtube/oauth/start">
                <MonitorPlay data-icon="inline-start" />
                {channels.length > 0 ? "Connect another channel" : "Connect a YouTube channel"}
              </a>
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {setup.audited
              ? "Your Google Cloud project is marked as audited, so public uploads and scheduling are available."
              : "Uploads are private until your Google Cloud project passes YouTube's free API audit (README). While the Google project is in Testing mode, Google asks you to reconnect about every 7 days."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
