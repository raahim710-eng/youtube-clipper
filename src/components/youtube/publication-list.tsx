"use client";

import { ExternalLink, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelPublicationAction, listPublicationsAction, retryPublicationAction } from "@/app/(app)/youtube/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PRIVACY_LABELS, PUBLICATION_STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { PublicationView } from "@/server/services/youtube";

/** What to do after a failure, by error code (YT-06). */
function guidance(publication: PublicationView): { text: string; href?: string; link?: string } {
  switch (publication.errorCode) {
    case "QUOTA_EXCEEDED":
      return { text: "Wait until the daily quota resets (midnight Pacific time), then try again." };
    case "YOUTUBE_REAUTH":
      return {
        text: "Reconnect the channel, then try again.",
        href: "/settings/channels",
        link: "Settings › Channels",
      };
    case "SOURCE_MISSING":
      return { text: "The file is gone — export the Short (or re-upload the video) and publish again." };
    case "NETWORK":
    case "WORKER_LOST":
    case "WORKER_STOPPED":
      return { text: "Try again — the upload continues from where it stopped." };
    default:
      return {
        text: "Check the message above and try again. Uploads that stopped part-way resume where they left off.",
      };
  }
}

const dateFormat: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

export function PublicationList({ initial }: { initial: PublicationView[] }) {
  const [items, setItems] = useState(initial);
  const [pending, startTransition] = useTransition();
  const busy = items.some((p) => p.status === "queued" || p.status === "uploading");

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(async () => {
      const result = await listPublicationsAction();
      if (result.ok) setItems(result.data);
    }, 2_000);
    return () => clearInterval(timer);
  }, [busy]);

  function act(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? "Something went wrong.");
      else toast.success(success);
      const fresh = await listPublicationsAction();
      if (fresh.ok) setItems(fresh.data);
    });
  }

  return (
    <ul className="divide-y" aria-label="Uploads">
      {items.map((publication) => {
        const help = publication.status === "failed" ? guidance(publication) : null;
        return (
          <li key={publication.id} className="space-y-2 py-3" data-testid="publication-row">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{publication.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {publication.kind === "short" ? "Short" : "Video"} “{publication.sourceTitle}” →{" "}
                  {publication.channelTitle} · {PRIVACY_LABELS[publication.privacyStatus]}
                  {publication.publishAt
                    ? ` · publishes ${new Date(publication.publishAt).toLocaleString(undefined, dateFormat)}`
                    : ""}
                </p>
              </div>
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  publication.status === "failed" && "border-destructive text-destructive",
                  (publication.status === "uploaded" || publication.status === "scheduled") &&
                    "border-success text-success",
                )}
              >
                {PUBLICATION_STATUS_LABELS[publication.status]}
              </Badge>
            </div>

            {publication.status === "queued" || publication.status === "uploading" ? (
              <div className="space-y-1">
                <Progress value={publication.progress} aria-label="Upload progress" />
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {publication.status === "queued" && !publication.progressMessage
                      ? "Waiting for the YouTube worker…"
                      : `${publication.progress}% · ${publication.progressMessage ?? "Uploading"}`}
                  </span>
                  {publication.canCancel ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => act(() => cancelPublicationAction(publication.id), "Upload cancelled.")}
                    >
                      <X data-icon="inline-start" />
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {publication.youtubeUrl ? (
              <div className="flex flex-wrap gap-3 text-sm">
                <a
                  href={publication.youtubeUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  Open on YouTube <ExternalLink className="size-3" aria-hidden />
                </a>
                {publication.studioUrl ? (
                  <a
                    href={publication.studioUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-2"
                  >
                    YouTube Studio <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : null}
                {publication.actualPrivacyStatus ? (
                  <span className="text-xs text-muted-foreground">
                    YouTube reports it as {publication.actualPrivacyStatus}.
                  </span>
                ) : null}
              </div>
            ) : null}
            {publication.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warning">
                {warning}
              </p>
            ))}

            {publication.status === "failed" ? (
              <div className="space-y-1 rounded-md border border-destructive/40 p-2 text-sm">
                <p className="text-destructive">{publication.error}</p>
                {help ? (
                  <p className="text-xs text-muted-foreground">
                    {help.text}{" "}
                    {help.href ? (
                      <Link href={help.href} className="underline underline-offset-2">
                        {help.link}
                      </Link>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : null}
            {publication.canRetry ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => act(() => retryPublicationAction(publication.id), "Upload restarted.")}
              >
                <RotateCcw data-icon="inline-start" />
                Try again
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
