import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";

/**
 * The only way to turn a stored relative path into a real file path.
 * Shared with the Node worker (Phase 3), so it must not import Next.js APIs.
 * See SECURITY.md §4 — never pass user input directly to the file system.
 */

export function getStorageRoot(storageDir = process.env.STORAGE_DIR || "./storage"): string {
  // turbopackIgnore: the folder is chosen at runtime and must not be traced into the build.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), storageDir);
}

export class UnsafePathError extends Error {
  constructor(relativePath: string) {
    super(`Refusing to access a path outside storage: ${JSON.stringify(relativePath)}`);
    this.name = "UnsafePathError";
  }
}

/**
 * Resolves `relativePath` inside the storage root.
 * Rejects absolute paths, `..` segments, drive letters, null bytes and anything
 * that would end up outside the root after normalisation.
 */
export function resolveStoragePath(relativePath: string, root = getStorageRoot()): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new UnsafePathError(relativePath);
  }

  const resolved = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new UnsafePathError(relativePath);
  }
  return resolved;
}

/**
 * Like `resolveStoragePath`, but also follows symlinks for files that already
 * exist and verifies the real location is still inside the root.
 */
export async function resolveExistingStoragePath(relativePath: string, root = getStorageRoot()): Promise<string> {
  const resolved = resolveStoragePath(relativePath, root);
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(resolved)]);
  const relativeToRoot = path.relative(realRoot, realFile);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new UnsafePathError(relativePath);
  }
  return realFile;
}

/** Creates the storage root if needed and checks that we can write to it. */
export async function checkStorageWritable(root = getStorageRoot()): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const probe = path.join(root, `.write-test-${process.pid}-${Date.now()}`);
  await fs.writeFile(probe, "ok");
  await fs.rm(probe, { force: true });
}

/**
 * Relative locations inside STORAGE_DIR (TECHNICAL_SPEC.md §5). IDs come from the
 * database, never from user input, but every path still goes through resolveStoragePath.
 */
export const storagePaths = {
  uploadTempRoot: () => "uploads/tmp",
  uploadTempDir: (uploadId: string) => `uploads/tmp/${uploadId}`,
  uploadData: (uploadId: string) => `uploads/tmp/${uploadId}/data.bin`,
  uploadChunkMarker: (uploadId: string, index: number) => `uploads/tmp/${uploadId}/${index}.ok`,
  videoDir: (videoId: string) => `videos/${videoId}`,
  videoSource: (videoId: string, extension: string) => `videos/${videoId}/source.${extension}`,
  shortDir: (shortId: string) => `shorts/${shortId}`,
  shortRender: (shortId: string, name: string) => `shorts/${shortId}/${name}.mp4`,
  thumbnail: (thumbnailId: string) => `thumbnails/${thumbnailId}.jpg`,
  thumbnailUpload: (thumbnailId: string) => `thumbnails/uploads/${thumbnailId}.upload`,
};

/**
 * Deletes a folder inside storage (no error if it's already gone). Windows can keep a file locked for a
 * moment after FFmpeg exits, so it retries; if the folder still can't be removed it is left for the
 * housekeeping task (src/server/maintenance.ts), which removes folders whose record is gone.
 */
export async function removeStorageDir(relativePath: string, root = getStorageRoot()): Promise<void> {
  const target = resolveStoragePath(relativePath, root);
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (error) {
    logger.warn("Couldn't delete a folder now; housekeeping will retry", { relativePath, error });
  }
}

/** Size in bytes, or null when the file doesn't exist. */
export async function storageFileSize(relativePath: string, root = getStorageRoot()): Promise<number | null> {
  try {
    const stat = await fs.stat(resolveStoragePath(relativePath, root));
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
