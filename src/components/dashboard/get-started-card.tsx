import { CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import { PhaseBadge } from "@/components/phase-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SystemStatus } from "@/server/services/system-status";

type Step = { label: string; done: boolean; href?: string; phase?: number; hint?: string };

/** First-run checklist (UI_UX.md §5.1). Steps tick off automatically. */
export function GetStartedCard({
  status,
  videoCount,
  className,
}: {
  status: SystemStatus;
  videoCount: number;
  className?: string;
}) {
  const checks = status.groups.flatMap((group) => group.checks);
  const ffmpegReady = checks.find((check) => check.id === "ffmpeg")?.status === "ok";

  const steps: Step[] = [
    { label: "Create your owner account", done: true },
    {
      label: "Check system status",
      done: status.counts.error === 0,
      href: "/settings/system",
      hint: status.counts.error === 0 ? undefined : "Fix the items marked in red.",
    },
    {
      label: "Install FFmpeg",
      done: ffmpegReady,
      href: "/settings/system",
      hint: ffmpegReady ? undefined : "Needed before videos can be processed.",
    },
    { label: "Upload your first video", done: videoCount > 0, href: "/videos" },
    { label: "Connect a YouTube channel", done: false, phase: 7 },
  ];
  const completed = steps.filter((step) => step.done).length;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Get started</CardTitle>
        <CardDescription>
          {completed} of {steps.length} done
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((step) => {
            const Icon = step.done ? CircleCheck : CircleDashed;
            const label =
              step.href && !step.done ? (
                <Link href={step.href} className="underline-offset-4 hover:underline">
                  {step.label}
                </Link>
              ) : (
                step.label
              );
            return (
              <li key={step.label} className="flex items-start gap-3">
                <Icon
                  className={cn("mt-0.5 size-4 shrink-0", step.done ? "text-success" : "text-muted-foreground")}
                  aria-hidden
                />
                <div className="min-w-0 flex-1 text-sm">
                  <div
                    className={cn(
                      "flex flex-wrap items-center gap-2",
                      step.done && "text-muted-foreground line-through",
                    )}
                  >
                    {label}
                    {step.phase ? <PhaseBadge phase={step.phase} /> : null}
                    <span className="sr-only">{step.done ? "(done)" : "(not done)"}</span>
                  </div>
                  {step.hint ? <p className="text-xs text-muted-foreground">{step.hint}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
