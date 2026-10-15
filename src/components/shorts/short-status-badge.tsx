import { Badge } from "@/components/ui/badge";
import type { ShortStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** Status of a Short's export, with text (never colour alone). */
export function ShortStatusBadge({ status, stale }: { status: ShortStatus; stale: boolean }) {
  const [label, tone] =
    status === "rendering"
      ? ["Exporting", "text-muted-foreground"]
      : status === "failed"
        ? ["Export failed", "border-destructive text-destructive"]
        : status === "ready" && stale
          ? ["Out of date", "border-warning text-warning"]
          : status === "ready"
            ? ["Ready", "border-success text-success"]
            : ["Draft", "text-muted-foreground"];
  return (
    <Badge variant="outline" className={cn("font-normal", tone)}>
      {label}
    </Badge>
  );
}
