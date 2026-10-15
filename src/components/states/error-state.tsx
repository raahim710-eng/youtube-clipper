"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Friendly error panel with an optional "Try again" button (used by error.tsx files and forms). */
export function ErrorState({
  title = "Something went wrong",
  description = "Please try again. If the problem continues, check Settings › System status.",
  onRetry,
  reference,
  className,
}: {
  title?: string;
  description?: React.ReactNode;
  onRetry?: () => void;
  /** Error digest from Next.js, so the matching server log line can be found. */
  reference?: string;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={cn("max-w-2xl", className)}>
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        {reference ? <p className="font-mono text-xs opacity-80">Reference: {reference}</p> : null}
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <RotateCcw data-icon="inline-start" />
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
