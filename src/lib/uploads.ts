/**
 * Upload rules shared by the browser (instant feedback) and the server (enforcement).
 * The server additionally checks the file's content (magic bytes) and the media
 * worker checks it with ffprobe — the extension alone is never trusted.
 */

export const SUPPORTED_FORMATS = [
  { extension: "mp4", label: "MP4" },
  { extension: "m4v", label: "M4V" },
  { extension: "mov", label: "MOV" },
  { extension: "mkv", label: "MKV" },
  { extension: "webm", label: "WebM" },
  { extension: "avi", label: "AVI" },
] as const;

export type VideoExtension = (typeof SUPPORTED_FORMATS)[number]["extension"];

export const SUPPORTED_EXTENSIONS: readonly string[] = SUPPORTED_FORMATS.map((format) => format.extension);

/** Value for <input accept="…">. */
export const ACCEPT_ATTRIBUTE = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export const SUPPORTED_FORMATS_LABEL = SUPPORTED_FORMATS.map((format) => format.label).join(", ");

/** 10 MB chunks (TECHNICAL_SPEC.md §7.1). */
export const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;

export const MAX_FILENAME_LENGTH = 255;

export type UploadLimits = {
  maxUploadBytes: number;
  maxDurationMinutes: number;
};

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isSupportedExtension(extension: string): extension is VideoExtension {
  return SUPPORTED_EXTENSIONS.includes(extension);
}

/** Returns a user-facing reason the file can't be uploaded, or null if it looks fine. */
export function validateUploadFile(
  file: { name: string; size: number },
  limits: Pick<UploadLimits, "maxUploadBytes">,
): string | null {
  if (!file.name || file.name.length > MAX_FILENAME_LENGTH) {
    return "The file name is missing or too long.";
  }
  const extension = getExtension(file.name);
  if (!isSupportedExtension(extension)) {
    return `“${file.name}” isn't a supported video format. Use ${SUPPORTED_FORMATS_LABEL}.`;
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return `“${file.name}” is empty.`;
  }
  if (file.size > limits.maxUploadBytes) {
    return `“${file.name}” is ${formatBytes(file.size)}. The limit is ${formatBytes(limits.maxUploadBytes)}.`;
  }
  return null;
}

export function countChunks(totalBytes: number, chunkSize = UPLOAD_CHUNK_SIZE): number {
  return Math.ceil(totalBytes / chunkSize);
}

/** Exact byte length chunk `index` must have (the last one may be shorter). */
export function expectedChunkLength(index: number, totalBytes: number, chunkSize = UPLOAD_CHUNK_SIZE): number {
  const start = index * chunkSize;
  return Math.max(0, Math.min(chunkSize, totalBytes - start));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** m:ss below an hour, h:mm:ss above (UI_UX.md §6 "Timecodes"). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** Title shown for a new video: the file name without its extension. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const base = (dot >= 0 ? filename.slice(0, dot) : filename).replace(/[_]+/g, " ").trim();
  return (base || "Untitled video").slice(0, 200);
}
