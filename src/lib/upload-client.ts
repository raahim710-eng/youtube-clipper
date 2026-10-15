/**
 * Browser side of chunked, resumable uploads (LIB-01). Talks to /api/uploads/*.
 * Each chunk is retried with back-off on network errors, so a short connection drop
 * doesn't lose the upload; a failed upload can be resumed later with its upload ID.
 */

export type UploadPhase = "starting" | "uploading" | "finishing";

export type UploadProgress = {
  phase: UploadPhase;
  uploadedBytes: number;
  totalBytes: number;
};

export class UploadFailedError extends Error {
  constructor(
    message: string,
    /** True when trying again (resuming) may succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadFailedError";
  }
}

type UploadSummary = {
  id: string;
  originalFilename: string;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  status: string;
  receivedChunks: number[];
};

const MAX_ATTEMPTS = 4;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function errorMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

async function jsonRequest<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new UploadFailedError("Couldn't reach the app. Check that it's still running, then retry.", true);
  }
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new UploadFailedError(await errorMessageFrom(response, fallback), retryable);
  }
  return (await response.json()) as T;
}

/** PUT one chunk with XHR (fetch can't report upload progress). Resolves with the HTTP status. */
function putChunk(
  url: string,
  body: Blob,
  signal: AbortSignal | undefined,
  onBytes: (sent: number) => void,
): Promise<{ status: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onBytes(event.loaded);
    xhr.onload = () => {
      let error: string | undefined;
      try {
        error = (JSON.parse(xhr.responseText) as { error?: string }).error;
      } catch {
        error = undefined;
      }
      resolve({ status: xhr.status, error });
    };
    xhr.onerror = () => resolve({ status: 0 });
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    if (signal) {
      if (signal.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Upload cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function uploadVideoFile(
  file: File,
  options: {
    onProgress: (progress: UploadProgress) => void;
    /** Called as soon as the server assigned an upload ID (needed to resume or cancel). */
    onUploadId?: (uploadId: string) => void;
    signal?: AbortSignal;
    /** Continue an earlier, unfinished upload of the same file. */
    resumeUploadId?: string;
  },
): Promise<{ uploadId: string; videoId: string }> {
  const { onProgress, signal } = options;
  onProgress({ phase: "starting", uploadedBytes: 0, totalBytes: file.size });

  let upload: UploadSummary;
  if (options.resumeUploadId) {
    upload = await jsonRequest<UploadSummary>(
      `/api/uploads/${encodeURIComponent(options.resumeUploadId)}`,
      { method: "GET", signal },
      "Couldn't find the unfinished upload.",
    );
    if (upload.totalBytes !== file.size || upload.originalFilename !== file.name) {
      throw new UploadFailedError(
        `That's not the same file. Choose “${upload.originalFilename}” to resume this upload.`,
        false,
      );
    }
    if (upload.status !== "in_progress") {
      throw new UploadFailedError("This upload can no longer be resumed. Start a new upload instead.", false);
    }
  } else {
    upload = await jsonRequest<UploadSummary>(
      "/api/uploads",
      { method: "POST", body: JSON.stringify({ filename: file.name, size: file.size }), signal },
      "Couldn't start the upload.",
    );
  }
  options.onUploadId?.(upload.id);

  const received = new Set(upload.receivedChunks);
  let doneBytes = 0;
  for (const index of received) {
    doneBytes += Math.min(upload.chunkSize, file.size - index * upload.chunkSize);
  }

  for (let index = 0; index < upload.totalChunks; index += 1) {
    if (received.has(index)) continue;
    const start = index * upload.chunkSize;
    const blob = file.slice(start, Math.min(start + upload.chunkSize, file.size));

    for (let attempt = 1; ; attempt += 1) {
      const { status, error } = await putChunk(
        `/api/uploads/${encodeURIComponent(upload.id)}/chunks/${index}`,
        blob,
        signal,
        (sent) => onProgress({ phase: "uploading", uploadedBytes: doneBytes + sent, totalBytes: file.size }),
      );
      if (status >= 200 && status < 300) break;

      const retryable = status === 0 || status >= 500 || status === 408 || status === 429;
      if (!retryable) throw new UploadFailedError(error ?? "The server refused part of the file.", false);
      if (attempt >= MAX_ATTEMPTS) {
        throw new UploadFailedError(
          status === 0
            ? "The connection dropped. Your progress is saved — choose Retry to continue."
            : (error ?? "The server had a problem. Your progress is saved — choose Retry to continue."),
          true,
        );
      }
      await sleep(1000 * 2 ** (attempt - 1), signal);
    }
    doneBytes += blob.size;
    onProgress({ phase: "uploading", uploadedBytes: doneBytes, totalBytes: file.size });
  }

  onProgress({ phase: "finishing", uploadedBytes: file.size, totalBytes: file.size });
  const { videoId } = await jsonRequest<{ videoId: string }>(
    `/api/uploads/${encodeURIComponent(upload.id)}/complete`,
    { method: "POST", signal },
    "Couldn't finish the upload.",
  );
  return { uploadId: upload.id, videoId };
}

/** Deletes an unfinished upload's partial data on the server. */
export async function discardUpload(uploadId: string): Promise<void> {
  await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}
