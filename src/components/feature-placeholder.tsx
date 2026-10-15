import { CircleDashed } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PhaseBadge } from "@/components/phase-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CURRENT_PHASE } from "@/lib/app-config";
import type { NavItem } from "@/lib/navigation";

/**
 * Clearly labelled page for a feature planned in a later phase.
 * Replace with the real page when the feature's phase is built.
 */
export function FeaturePlaceholder({ item }: { item: NavItem }) {
  const Icon = item.icon;
  const phasesAway = item.phase - CURRENT_PHASE;

  return (
    <div className="space-y-6">
      <PageHeader title={item.title} description={item.description} actions={<PhaseBadge phase={item.phase} />} />

      <Card className="max-w-3xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Icon className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle>Not built yet — planned for Phase {item.phase}</CardTitle>
              <CardDescription>
                {phasesAway === 1
                  ? "This is the next feature after the current phase."
                  : `This arrives ${phasesAway} phases from now. Nothing on this page works yet.`}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">What this page will do</p>
            <ul className="space-y-2">
              {item.planned.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CircleDashed className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
