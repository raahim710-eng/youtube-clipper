"use client";

import { ListTodo, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelJobAction, retryJobAction } from "@/app/(app)/videos/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import type { JobSummary } from "@/server/services/jobs";

const ACTIVE = new Set(["queued", "running"]);
const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Activity drawer (UI_UX.md §2, JOB-02/03). Polls /api/jobs — quickly while jobs are active,
 * slowly otherwise — and shows a toast when a job finishes.
 */
export function JobsDrawer() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [pending, startTransition] = useTransition();
  const previous = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs", { cache: "no-store" });
      if (!response.ok) return;
      const { jobs: latest } = (await response.json()) as { jobs: JobSummary[] };
      let finished = false;
      for (const job of latest) {
        const before = previous.current.get(job.id);
        if (before && ACTIVE.has(before) && !ACTIVE.has(job.status)) {
          finished = true;
          const name = job.entityTitle ? `“${job.entityTitle}”` : job.label;
          if (job.status === "succeeded") toast.success(`${name} is ready.`);
          else if (job.status === "failed") toast.error(`${name}: ${job.error ?? "processing failed."}`);
        }
      }
      previous.current = new Map(latest.map((job) => [job.id, job.status]));
      setJobs(latest);
      if (finished) router.refresh();
    } catch {
      // Network hiccup — try again on the next tick.
    }
  }, [router]);

  const activeCount = jobs.filter((job) => ACTIVE.has(job.status)).length;

  // Poll the server (an external system): first tick right away, then on an interval.
  useEffect(() => {
    const tick = () => void refresh();
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, open || activeCount > 0 ? 2000 : 10000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, open, activeCount]);

  function act(action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.error ?? "Something went wrong.");
      await refresh();
      router.refresh();
    });
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Background jobs (${activeCount} active)`}>
          <ListTodo data-icon="inline-start" />
          <span className="hidden sm:inline">Jobs</span>
          {activeCount > 0 ? <Badge className="h-5 min-w-5 px-1 text-[11px]">{activeCount}</Badge> : null}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Background jobs</SheetTitle>
          <SheetDescription>Processing runs on this computer. You can keep working while it does.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {jobs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No jobs yet. Upload a video to start one.</p>
          ) : (
            <ul className="space-y-3">
              {jobs.map((job) => (
                <li key={job.id} className="space-y-2 rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{job.label}</p>
                      {job.entityHref && job.entityTitle ? (
                        <Link
                          href={job.entityHref}
                          className="block truncate text-xs text-muted-foreground hover:underline"
                          onClick={() => setOpen(false)}
                        >
                          {job.entityTitle}
                        </Link>
                      ) : null}
                    </div>
                    <Badge variant="outline" className="shrink-0 font-normal">
                      {STATUS_LABEL[job.status] ?? job.status}
                    </Badge>
                  </div>
                  {job.status === "running" ? <Progress value={job.progress} aria-label="Job progress" /> : null}
                  {job.status === "running" || job.status === "queued" ? (
                    <p className="text-xs text-muted-foreground">{job.progressMessage ?? "Waiting for the worker…"}</p>
                  ) : null}
                  {job.status === "failed" && job.error ? (
                    <p className="text-xs text-destructive">{job.error}</p>
                  ) : null}
                  <div className="flex gap-2">
                    {ACTIVE.has(job.status) ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => act(() => cancelJobAction(job.id))}
                      >
                        <X data-icon="inline-start" />
                        Cancel
                      </Button>
                    ) : null}
                    {job.status === "failed" || job.status === "cancelled" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={pending}
                        onClick={() => act(() => retryJobAction(job.id))}
                      >
                        <RotateCcw data-icon="inline-start" />
                        Retry
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
