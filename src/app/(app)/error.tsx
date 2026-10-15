"use client";

import { ErrorState } from "@/components/states/error-state";

/** Shown when a signed-in page fails to render. The sidebar and header stay usable. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="This page couldn't load"
      description="Something went wrong while loading this page. Try again, or check Settings › System status if it keeps happening."
      reference={error.digest}
      onRetry={reset}
    />
  );
}
