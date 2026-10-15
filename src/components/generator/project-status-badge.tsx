import { Badge } from "@/components/ui/badge";
import type { GeneratorStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";

const LABELS: Record<GeneratorStatus, [string, string]> = {
  draft: ["Brief", "text-muted-foreground"],
  scripting: ["Writing script", "text-muted-foreground"],
  editing: ["In progress", "border-warning text-warning"],
  rendering: ["Rendering", "text-muted-foreground"],
  ready: ["Video ready", "border-success text-success"],
};

/** A generator project's stage, with text (never colour alone). */
export function ProjectStatusBadge({ status }: { status: GeneratorStatus }) {
  const [label, tone] = LABELS[status] ?? LABELS.draft;
  return (
    <Badge variant="outline" className={cn("font-normal", tone)}>
      {label}
    </Badge>
  );
}
