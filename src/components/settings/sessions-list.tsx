"use client";

import { Laptop } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { revokeSessionAction } from "@/app/(app)/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type SessionRow = {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  isCurrent: boolean;
};

/** Very small user-agent summary, e.g. "Chrome on Windows". Good enough to recognise a device. */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown browser";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /Linux/.test(userAgent)
          ? "Linux"
          : /iPhone|iPad/.test(userAgent)
            ? "iOS"
            : "unknown system";
  return `${browser} on ${os}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function SessionsList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [revoking, setRevoking] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevoking(id);
    const result = await revokeSessionAction(id);
    setRevoking(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Session signed out.");
    router.refresh();
  }

  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No active sessions.</p>;
  }

  return (
    <ul className="divide-y rounded-lg border">
      {sessions.map((session) => (
        <li key={session.id} className="flex flex-wrap items-center gap-3 p-3">
          <Laptop className="size-5 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex items-center gap-2 font-medium">
              {describeAgent(session.userAgent)}
              {session.isCurrent ? <Badge variant="secondary">This browser</Badge> : null}
            </div>
            <div className="text-xs text-muted-foreground">
              Signed in {dateFormat.format(new Date(session.createdAt))} · expires{" "}
              {dateFormat.format(new Date(session.expiresAt))}
            </div>
          </div>
          {!session.isCurrent ? (
            <Button variant="outline" size="sm" onClick={() => revoke(session.id)} disabled={revoking !== null}>
              {revoking === session.id ? <Spinner data-icon="inline-start" /> : null}
              Sign out
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
