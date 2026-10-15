"use client";

import { CircleAlert, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { cancelJobAction, retryVideoProcessingAction } from "@/app/(app)/videos/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { VideoStatus } from "@/lib/constants";

type JobInfo = { id: string; status: string; progress: number; progressMessage: string | null } | null;

/** Shows processing progress with Cancel, or the failure reason with Retry (JOB-02/03/05). */
export function ProcessingPanel({
  videoId,
  status,
  errorMessage,
  job,
  workerOnline,
}: {
  videoId: string;
  status: VideoStatus;
  errorMessage: string | null;
  job: JobInfo;
  workerOnline: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? "Something went wrong.");
      else toast.success(success);
      router.refresh();
    });
  }

  if (status === "processing") {
    const waiting = !job || job.status === "queued";
    return (
      <div className="space-y-3 rounded-xl border p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">
            {waiting
              ? workerOnline
                ? "Waiting to be processed…"
                : "Waiting for the media worker to start…"
              : (job.progressMessage ?? "Processing…")}
          </p>
          {job ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => cancelJobAction(job.id), "Processing will stop shortly.")}
            >
              Cancel processing
            </Button>
          ) : null}
        </div>
        <Progress value={job?.status === "running" ? job.progress : 0} aria-label="Processing progress" />
      </div>
    );
  }

  if (status === "failed") {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Processing failed</AlertTitle>
        <AlertDescription>
          <p>{errorMessage ?? "Something went wrong while processing this video."}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={pending}
            onClick={() => run(() => retryVideoProcessingAction(videoId), "Processing restarted.")}
          >
            {pending ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
            Retry processing
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
