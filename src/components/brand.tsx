import { Sparkles } from "lucide-react";
import { APP_NAME } from "@/lib/app-config";
import { cn } from "@/lib/utils";

/** App logo mark + name. Deliberately not YouTube-branded (DECISIONS.md D-021). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground",
        className,
      )}
      aria-hidden
    >
      <Sparkles className="size-4" />
    </span>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <BrandMark />
      <span className="truncate font-semibold tracking-tight">{APP_NAME}</span>
    </span>
  );
}
