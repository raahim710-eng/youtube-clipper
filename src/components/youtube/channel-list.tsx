"use client";

import { MonitorPlay, RefreshCw, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { disconnectChannelAction } from "@/app/(app)/youtube/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ChannelView } from "@/server/services/youtube";

const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/youtube.readonly": "See your channel",
  "https://www.googleapis.com/auth/youtube.upload": "Upload videos",
};

/** Connected channels with status, reconnect and a confirmed disconnect (YT-01…03). */
export function ChannelList({ channels, canConnect }: { channels: ChannelView[]; canConnect: boolean }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<ChannelView | null>(null);
  const [pending, startTransition] = useTransition();

  if (channels.length === 0) {
    return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No channels connected.</p>;
  }
  return (
    <>
      <ul className="divide-y rounded-lg border" aria-label="Connected channels">
        {channels.map((channel) => (
          <li key={channel.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="channel-row">
            <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
              {channel.thumbnailUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- YouTube's own image host, allowed by the CSP
                <img
                  src={channel.thumbnailUrl}
                  alt=""
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <MonitorPlay className="size-4 text-muted-foreground" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{channel.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {channel.handle ? `${channel.handle} · ` : ""}connected{" "}
                {dateFormat.format(new Date(channel.connectedAt))} ·{" "}
                {channel.scopes
                  .map((scope) => SCOPE_LABELS[scope])
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
            {channel.status === "active" ? (
              <Badge variant="outline" className="border-success font-normal text-success">
                Connected
              </Badge>
            ) : (
              <Badge variant="outline" className="border-warning font-normal text-warning">
                Needs reconnecting
              </Badge>
            )}
            {channel.status !== "active" && canConnect ? (
              <Button size="sm" asChild>
                <a href="/api/youtube/oauth/start">
                  <RefreshCw data-icon="inline-start" />
                  Reconnect
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setConfirm(channel)}>
              <Unplug data-icon="inline-start" />
              Disconnect
            </Button>
          </li>
        ))}
      </ul>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {confirm?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              The app&apos;s access is revoked at Google and its stored sign-in is deleted. Videos already on YouTube
              stay there. Waiting uploads to this channel are cancelled. You can connect it again any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                if (!confirm) return;
                startTransition(async () => {
                  const result = await disconnectChannelAction(confirm.id);
                  setConfirm(null);
                  if (!result.ok) {
                    toast.error(result.error);
                    return;
                  }
                  toast.success(
                    result.data.revoked
                      ? "Disconnected. Access was revoked at Google."
                      : "Disconnected here. Google couldn't be reached to revoke access — remove it at myaccount.google.com/permissions.",
                  );
                  router.refresh();
                });
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
