import { PauseCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** Explains why videos sit in "Processing" when no media worker is running. */
export function WorkerOfflineNotice() {
  return (
    <Alert>
      <PauseCircle />
      <AlertTitle>Processing is paused — the media worker isn&apos;t running</AlertTitle>
      <AlertDescription>
        <p>
          Your uploads are saved and will be processed as soon as the worker starts. Stop the app and start it with{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">npm run dev:all</code> instead of{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">npm run dev</code>.
        </p>
      </AlertDescription>
    </Alert>
  );
}
