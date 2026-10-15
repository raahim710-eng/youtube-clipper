import type { Metadata } from "next";
import { RecheckButton } from "@/components/settings/recheck-button";
import { SystemStatusList } from "@/components/settings/system-status-list";
import { requireUser } from "@/server/session";
import { getSystemStatus } from "@/server/services/system-status";

export const metadata: Metadata = { title: "System status" };

const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "medium" });

export default async function SystemStatusPage() {
  await requireUser();
  const status = await getSystemStatus();

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          <p>
            {status.counts.ok} OK · {status.counts.warning} need attention soon · {status.counts.error} problems
          </p>
          <p className="text-xs">Last checked at {timeFormat.format(new Date(status.checkedAt))} (server time).</p>
        </div>
        <RecheckButton />
      </div>
      <SystemStatusList status={status} />
    </>
  );
}
