import { CircleAlert, CircleCheck, Loader } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { VideoStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";

const STYLES: Record<VideoStatus, { label: string; icon: typeof Loader; className: string }> = {
  processing: { label: "Processing", icon: Loader, className: "border-info/30 bg-info/10 text-info" },
  ready: { label: "Ready", icon: CircleCheck, className: "border-success/30 bg-success/10 text-success" },
  failed: { label: "Failed", icon: CircleAlert, className: "border-destructive/30 bg-destructive/10 text-destructive" },
};

/** Status chip with text + icon (never colour alone — UI_UX.md §6). */
export function VideoStatusBadge({ status, className }: { status: VideoStatus; className?: string }) {
  const style = STYLES[status];
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", style.className, className)}>
      <Icon className={cn("size-3", status === "processing" && "animate-spin")} aria-hidden />
      {style.label}
    </Badge>
  );
}

/** Marks videos made by the Original Video Generator (GEN-06). */
export function GeneratedBadge() {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground" data-testid="generated-badge">
      Generated
    </Badge>
  );
}
