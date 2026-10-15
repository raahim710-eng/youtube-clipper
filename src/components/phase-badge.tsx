import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Small "Phase N" label for features that aren't built yet. */
export function PhaseBadge({ phase, className }: { phase: number; className?: string }) {
  return (
    <Badge variant="outline" className={cn("font-normal text-muted-foreground", className)}>
      Phase {phase}
    </Badge>
  );
}
