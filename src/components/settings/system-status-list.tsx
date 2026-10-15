import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { PhaseBadge } from "@/components/phase-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CheckStatus, SystemStatus } from "@/server/services/system-status";
import { TextWithCode } from "@/components/text-with-code";

const STATUS_STYLE: Record<CheckStatus, { icon: typeof Info; className: string; label: string }> = {
  ok: { icon: CircleCheck, className: "text-success", label: "OK" },
  warning: { icon: TriangleAlert, className: "text-warning", label: "Needs attention soon" },
  error: { icon: CircleAlert, className: "text-destructive", label: "Problem" },
  info: { icon: Info, className: "text-muted-foreground", label: "Not needed yet" },
};

/** FND-06: every dependency with its state and how to fix it. Text labels, not colour alone. */
export function SystemStatusList({ status }: { status: SystemStatus }) {
  return (
    <div className="space-y-4">
      {status.groups.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle className="text-base">{group.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {group.checks.map((check) => {
                const style = STATUS_STYLE[check.status];
                const Icon = style.icon;
                return (
                  <li key={check.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <Icon className={cn("mt-0.5 size-4 shrink-0", style.className)} aria-hidden />
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{check.label}</span>
                        <span className={cn("text-xs", style.className)}>{style.label}</span>
                        {check.status !== "ok" && check.neededFromPhase && check.neededFromPhase > 2 ? (
                          <PhaseBadge phase={check.neededFromPhase} />
                        ) : null}
                      </div>
                      <p className="text-muted-foreground">
                        <TextWithCode text={check.summary} />
                      </p>
                      {check.hint && check.status !== "ok" ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          <TextWithCode text={check.hint} />
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
