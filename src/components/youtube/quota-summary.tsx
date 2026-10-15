"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import type { QuotaStatus } from "@/server/youtube/quota";

/** Today's YouTube API usage (YT-07), with the reset time in the viewer's own time zone. */
export function QuotaSummary({ quota, audited }: { quota: QuotaStatus; audited: boolean }) {
  const reset = new Date(quota.resetsAt).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Today&apos;s YouTube quota</CardTitle>
        <CardDescription>
          Free daily limits for your Google Cloud project. Resets {reset} (midnight Pacific time).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1.5">
          <p>
            Uploads: {quota.uploads.used} of {quota.uploads.limit}
          </p>
          <Progress value={(quota.uploads.used / quota.uploads.limit) * 100} aria-label="Uploads used today" />
        </div>
        <div className="space-y-1.5">
          <p>
            API units: {quota.units.used.toLocaleString("en")} of {quota.units.limit.toLocaleString("en")}
          </p>
          <Progress value={(quota.units.used / quota.units.limit) * 100} aria-label="API units used today" />
          <p className="text-xs text-muted-foreground">A thumbnail costs 50 units; finding a channel costs 1.</p>
        </div>
        <p className="text-xs text-muted-foreground">
          {audited
            ? "Public uploads and scheduling: available."
            : "Public uploads and scheduling: after the free YouTube API audit (README). Until then uploads are private."}
        </p>
      </CardContent>
    </Card>
  );
}
