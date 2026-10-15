import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SystemStatus } from "@/server/services/system-status";
import { TextWithCode } from "@/components/text-with-code";

/** DASH-06: warns when something the app needs right now is broken. */
export function SystemStatusBanner({ status }: { status: SystemStatus }) {
  const failing = status.groups.flatMap((group) => group.checks).filter((check) => check.status === "error");
  if (failing.length === 0) return null;

  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Something needs your attention</AlertTitle>
      <AlertDescription>
        <ul>
          {failing.map((check) => (
            <li key={check.id}>
              {check.label}: <TextWithCode text={check.summary} />
            </li>
          ))}
        </ul>
        <Link href="/settings/system" className="font-medium underline underline-offset-4">
          Open system status
        </Link>
      </AlertDescription>
    </Alert>
  );
}
