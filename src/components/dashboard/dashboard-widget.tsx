import type { LucideIcon } from "lucide-react";
import { PhaseBadge } from "@/components/phase-badge";
import { EmptyState } from "@/components/states/empty-state";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A dashboard card. Until its feature exists it shows an empty state and the phase
 * that will fill it (DASH-07). Later phases pass real content as children.
 */
export function DashboardWidget({
  title,
  icon,
  emptyTitle,
  emptyDescription,
  phase,
  children,
}: {
  title: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  /** Phase that delivers this widget's data; omit once it's live. */
  phase?: number;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {phase ? (
          <CardAction>
            <PhaseBadge phase={phase} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {children ?? (
          <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} className="border-dashed p-4" />
        )}
      </CardContent>
    </Card>
  );
}
