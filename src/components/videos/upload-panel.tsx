"use client";

import { CircleAlert, CircleCheck, FileVideo, RotateCcw, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { discardUpload, UploadFailedError, type UploadProgress, uploadVideoFile } from "@/lib/upload-client";
import {
  ACCEPT_ATTRIBUTE,
  formatBytes,
  SUPPORTED_FORMATS_LABEL,
  type UploadLimits,
  validateUploadFile,
} from "@/lib/uploads";
import { cn } from "@/lib/utils";

type ItemStatus = "queued" | "uploading" | "done" | "failed" | "cancelled";

type UploadItem = {
  key: string;
  file: File;
  status: ItemStatus;
  progress: UploadProgress | null;
  error: string | null;
  retryable: boolean;
  uploadId: string | null;
};

export type IncompleteUpload = {
  id: string;
  originalFilename: string;
  totalBytes: number;
  receivedChunks: number;
  totalChunks: number;
};

/** LIB-01/02: drag-and-drop uploads with progress, cancel, retry and resume. */
export function UploadPanel({ limits, incomplete }: { limits: UploadLimits; incomplete: IncompleteUpload[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const resumeTarget = useRef<IncompleteUpload | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  // Files wait here and are uploaded one at a time, in the order they were added.
  const queue = useRef<UploadItem[]>([]);
  const draining = useRef(false);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);

  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const busy = items.some((item) => item.status === "uploading" || item.status === "queued");

  // Warn before leaving the page while an upload is running (progress is kept, but the upload pauses).
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const runUpload = useCallback(
    async (item: UploadItem, resumeUploadId?: string) => {
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      update(item.key, { status: "uploading", error: null });
      try {
        await uploadVideoFile(item.file, {
          signal: controller.signal,
          resumeUploadId,
          onUploadId: (uploadId) => update(item.key, { uploadId }),
          onProgress: (progress) => update(item.key, { progress }),
        });
        update(item.key, { status: "done" });
        toast.success(`“${item.file.name}” uploaded. Processing has started.`);
        router.refresh();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          update(item.key, { status: "cancelled", error: null });
          return;
        }
        const failure =
          error instanceof UploadFailedError ? error : new UploadFailedError("The upload failed unexpectedly.", true);
        update(item.key, { status: "failed", error: failure.message, retryable: failure.retryable });
        router.refresh(); // an unfinished upload may now be listed for resuming
      } finally {
        controllers.current.delete(item.key);
      }
    },
    [router, update],
  );

  const drainQueue = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        await runUpload(next);
      }
    } finally {
      draining.current = false;
    }
  }, [runUpload]);

  function addFiles(files: FileList | File[]) {
    const added: UploadItem[] = Array.from(files).map((file) => {
      const problem = validateUploadFile(file, limits);
      return {
        key: crypto.randomUUID(),
        file,
        status: problem ? "failed" : "queued",
        progress: null,
        error: problem,
        retryable: false,
        uploadId: null,
      };
    });
    setItems((current) => [...current, ...added]);
    queue.current.push(...added.filter((item) => item.status === "queued"));
    void drainQueue();
  }

  async function cancel(item: UploadItem) {
    queue.current = queue.current.filter((queued) => queued.key !== item.key);
    controllers.current.get(item.key)?.abort();
    if (item.uploadId) await discardUpload(item.uploadId);
    update(item.key, { status: "cancelled", error: null });
    router.refresh();
  }

  function retry(item: UploadItem) {
    void runUpload(item, item.uploadId ?? undefined);
  }

  function remove(key: string) {
    setItems((current) => current.filter((item) => item.key !== key));
  }

  function startResume(upload: IncompleteUpload) {
    resumeTarget.current = upload;
    resumeInputRef.current?.click();
  }

  function onResumeFile(file: File | undefined) {
    const target = resumeTarget.current;
    resumeTarget.current = null;
    if (!file || !target) return;
    if (file.name !== target.originalFilename || file.size !== target.totalBytes) {
      toast.error(`That's a different file. Choose “${target.originalFilename}” to resume.`);
      return;
    }
    const item: UploadItem = {
      key: crypto.randomUUID(),
      file,
      status: "uploading",
      progress: null,
      error: null,
      retryable: true,
      uploadId: target.id,
    };
    setItems((current) => [...current, item]);
    void runUpload(item, target.id);
  }

  async function discard(upload: IncompleteUpload) {
    await discardUpload(upload.id);
    toast.success(`Discarded the unfinished upload of “${upload.originalFilename}”.`);
    router.refresh();
  }

  const resumingIds = new Set(items.filter((item) => item.status === "uploading").map((item) => item.uploadId));
  const visibleIncomplete = incomplete.filter((upload) => !resumingIds.has(upload.id));

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30",
        )}
      >
        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Upload className="size-5" aria-hidden />
        </span>
        <div className="space-y-1">
          <p className="font-medium">Drag videos here, or choose files</p>
          <p className="text-sm text-muted-foreground">
            {SUPPORTED_FORMATS_LABEL} · up to {formatBytes(limits.maxUploadBytes)} and {limits.maxDurationMinutes}{" "}
            minutes per video
          </p>
        </div>
        <Button type="button" onClick={() => inputRef.current?.click()}>
          Choose videos
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          hidden
          data-testid="video-file-input"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={resumeInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          hidden
          data-testid="resume-file-input"
          onChange={(event) => {
            onResumeFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      {visibleIncomplete.length > 0 ? (
        <ul className="space-y-2" aria-label="Unfinished uploads">
          {visibleIncomplete.map((upload) => (
            <li key={upload.id} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
              <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{upload.originalFilename}</p>
                <p className="text-xs text-muted-foreground">
                  Unfinished upload · {Math.round((upload.receivedChunks / upload.totalChunks) * 100)}% sent ·{" "}
                  {formatBytes(upload.totalBytes)}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => startResume(upload)}>
                Resume
              </Button>
              <Button size="sm" variant="ghost" onClick={() => discard(upload)}>
                Discard
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-2" aria-label="Uploads">
          {items.map((item) => (
            <UploadRow
              key={item.key}
              item={item}
              onCancel={() => cancel(item)}
              onRetry={() => retry(item)}
              onRemove={() => remove(item.key)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UploadRow({
  item,
  onCancel,
  onRetry,
  onRemove,
}: {
  item: UploadItem;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const percent = item.progress ? Math.floor((item.progress.uploadedBytes / item.progress.totalBytes) * 100) : 0;
  const statusText =
    item.status === "queued"
      ? "Waiting…"
      : item.status === "uploading"
        ? item.progress?.phase === "finishing"
          ? "Checking the file…"
          : item.progress?.phase === "starting"
            ? "Starting…"
            : `${percent}% · ${formatBytes(item.progress?.uploadedBytes ?? 0)} of ${formatBytes(item.file.size)}`
        : item.status === "done"
          ? "Uploaded — processing in the background"
          : item.status === "cancelled"
            ? "Cancelled"
            : item.error;

  return (
    <li className="flex items-center gap-3 rounded-lg border bg-card p-3" data-testid="upload-row">
      {item.status === "done" ? (
        <CircleCheck className="size-5 shrink-0 text-success" aria-hidden />
      ) : item.status === "failed" ? (
        <CircleAlert className="size-5 shrink-0 text-destructive" aria-hidden />
      ) : (
        <FileVideo className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{item.file.name}</p>
        {item.status === "uploading" ? <Progress value={percent} aria-label={`Upload progress ${percent}%`} /> : null}
        <p
          className={cn("text-xs", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}
          role={item.status === "failed" ? "alert" : undefined}
        >
          {statusText}
        </p>
      </div>
      {item.status === "uploading" || item.status === "queued" ? (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      {item.status === "failed" && item.retryable ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw data-icon="inline-start" />
          Retry
        </Button>
      ) : null}
      {item.status === "done" || item.status === "cancelled" || item.status === "failed" ? (
        <Button size="icon-sm" variant="ghost" aria-label="Remove from list" onClick={onRemove}>
          <X />
        </Button>
      ) : null}
    </li>
  );
}
