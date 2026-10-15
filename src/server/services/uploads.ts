import "server-only";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  countChunks,
  expectedChunkLength,
  getExtension,
  isSupportedExtension,
  titleFromFilename,
  UPLOAD_CHUNK_SIZE,
  validateUploadFile,
} from "@/lib/uploads";
import { db } from "../db";
import { getUploadLimits } from "../env";
import { AppError } from "../errors";
import { enqueueJob } from "../jobs/queue";
import { logger } from "../logger";
import { contentMatchesExtension, readHeader } from "../media/sniff";
import { getStorageRoot, removeStorageDir, resolveStoragePath, storagePaths } from "../storage";

/**
 * Chunked, resumable uploads (LIB-01/02, TECHNICAL_SPEC.md §7.1).
 *
 * Each chunk is written straight to its offset in uploads/tmp/{id}/data.bin, then a
 * `{index}.ok` marker is written. The markers on disk are the source of truth for
 * which chunks arrived, so an interrupted upload can resume from where it stopped.
 * Completing moves data.bin into videos/{videoId}/ (a rename, no copy).
 */

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type UploadSummary = {
  id: string;
  originalFilename: string;
  totalBytes: number;
  chunkSize: number;
  totalChunks: number;
  status: string;
  receivedChunks: number[];
  createdAt: string;
};

async function getOwnedUpload(userId: string, uploadId: string) {
  const upload = await db.upload.findFirst({ where: { id: uploadId, userId } });
  if (!upload) throw new AppError("NOT_FOUND", "Upload not found.");
  return upload;
}

function assertInProgress(upload: { status: string; expiresAt: Date }) {
  if (upload.status !== "in_progress") {
    throw new AppError("CONFLICT", `This upload is ${upload.status.replace("_", " ")} and can't receive more data.`);
  }
  if (upload.expiresAt.getTime() < Date.now()) {
    throw new AppError("CONFLICT", "This upload expired. Please start it again.");
  }
}

async function listReceivedChunks(uploadId: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(resolveStoragePath(storagePaths.uploadTempDir(uploadId)));
    return entries
      .filter((name) => /^\d+\.ok$/.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function toSummary(upload: Awaited<ReturnType<typeof getOwnedUpload>>, receivedChunks: number[]): UploadSummary {
  return {
    id: upload.id,
    originalFilename: upload.originalFilename,
    totalBytes: Number(upload.totalBytes),
    chunkSize: upload.chunkSize,
    totalChunks: upload.totalChunks,
    status: upload.status,
    receivedChunks,
    createdAt: upload.createdAt.toISOString(),
  };
}

/** Starts an upload after checking the name, format and size limits. */
export async function createUpload(userId: string, input: { filename: string; size: number }): Promise<UploadSummary> {
  const limits = getUploadLimits();
  const problem = validateUploadFile({ name: input.filename, size: input.size }, limits);
  if (problem) {
    throw new AppError(input.size > limits.maxUploadBytes ? "PAYLOAD_TOO_LARGE" : "VALIDATION", problem);
  }
  const extension = getExtension(input.filename);
  if (!isSupportedExtension(extension)) throw new AppError("VALIDATION", "Unsupported format.");

  await sweepStaleUploads();

  const upload = await db.upload.create({
    data: {
      userId,
      originalFilename: path.basename(input.filename).slice(0, 255),
      extension,
      totalBytes: BigInt(input.size),
      chunkSize: UPLOAD_CHUNK_SIZE,
      totalChunks: countChunks(input.size),
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    },
  });
  const dir = resolveStoragePath(storagePaths.uploadTempDir(upload.id));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolveStoragePath(storagePaths.uploadData(upload.id)), "");
  return toSummary(upload, []);
}

export async function getUploadStatus(userId: string, uploadId: string): Promise<UploadSummary> {
  const upload = await getOwnedUpload(userId, uploadId);
  return toSummary(upload, upload.status === "in_progress" ? await listReceivedChunks(upload.id) : []);
}

/** Uploads that were started but not finished — the UI offers to resume or discard them. */
export async function listIncompleteUploads(userId: string): Promise<UploadSummary[]> {
  const uploads = await db.upload.findMany({
    where: { userId, status: "in_progress", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  return Promise.all(uploads.map(async (upload) => toSummary(upload, await listReceivedChunks(upload.id))));
}

/** Throws once more than `limit` bytes pass through. */
function byteLimiter(limit: number, counter: { bytes: number }) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      counter.bytes += chunk.length;
      if (counter.bytes > limit) callback(new AppError("PAYLOAD_TOO_LARGE", "This chunk is larger than expected."));
      else callback(null, chunk);
    },
  });
}

/** Streams one chunk to its offset. Re-sending a chunk simply overwrites it. */
export async function writeChunk(
  userId: string,
  uploadId: string,
  index: number,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ receivedChunks: number }> {
  const upload = await getOwnedUpload(userId, uploadId);
  assertInProgress(upload);
  if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) {
    throw new AppError("VALIDATION", "Chunk number is out of range.");
  }
  if (!body) throw new AppError("VALIDATION", "The chunk is empty.");

  const totalBytes = Number(upload.totalBytes);
  const expected = expectedChunkLength(index, totalBytes, upload.chunkSize);
  const marker = resolveStoragePath(storagePaths.uploadChunkMarker(upload.id, index));
  await fs.rm(marker, { force: true });

  const counter = { bytes: 0 };
  await pipeline(
    Readable.fromWeb(body as WebReadableStream<Uint8Array>),
    byteLimiter(expected, counter),
    createWriteStream(resolveStoragePath(storagePaths.uploadData(upload.id)), {
      flags: "r+",
      start: index * upload.chunkSize,
    }),
  );
  if (counter.bytes !== expected) {
    throw new AppError("VALIDATION", `Chunk ${index} was incomplete (${counter.bytes} of ${expected} bytes).`);
  }
  await fs.writeFile(marker, String(expected));
  await db.upload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) } });
  return { receivedChunks: (await listReceivedChunks(upload.id)).length };
}

/**
 * Verifies all chunks arrived and the content looks like the claimed format, then turns
 * the upload into a library video and queues processing.
 */
export async function completeUpload(userId: string, uploadId: string): Promise<{ videoId: string }> {
  const upload = await getOwnedUpload(userId, uploadId);
  assertInProgress(upload);

  const received = await listReceivedChunks(upload.id);
  if (received.length !== upload.totalChunks) {
    throw new AppError(
      "CONFLICT",
      `Upload incomplete: ${received.length} of ${upload.totalChunks} parts received. Resume to send the rest.`,
    );
  }
  const dataPath = resolveStoragePath(storagePaths.uploadData(upload.id));
  // A second "complete" for the same upload (double click, retried request) finds the file already moved.
  const stat = await fs.stat(dataPath).catch(() => null);
  if (!stat) throw new AppError("CONFLICT", "This upload is already being finished.");
  if (stat.size !== Number(upload.totalBytes)) {
    throw new AppError("CONFLICT", "The uploaded file has the wrong size. Please upload it again.");
  }

  if (!contentMatchesExtension(await readHeader(dataPath), upload.extension)) {
    await failUpload(upload.id, "The file's content doesn't match a supported video format.");
    throw new AppError(
      "VALIDATION",
      `“${upload.originalFilename}” doesn't look like a real ${upload.extension.toUpperCase()} video. It may be damaged or renamed.`,
    );
  }

  const videoId = randomUUID();
  const sourcePath = storagePaths.videoSource(videoId, upload.extension);
  const absoluteSource = resolveStoragePath(sourcePath);
  await fs.mkdir(path.dirname(absoluteSource), { recursive: true });
  try {
    await fs.rename(dataPath, absoluteSource);
  } catch (error) {
    await removeStorageDir(storagePaths.videoDir(videoId));
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("CONFLICT", "This upload is already being finished.");
    }
    throw error;
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.video.create({
        data: {
          id: videoId,
          userId,
          title: titleFromFilename(upload.originalFilename),
          originalFilename: upload.originalFilename,
          sourcePath,
          sizeBytes: upload.totalBytes,
          container: upload.extension,
          status: "processing",
        },
      });
      await enqueueJob(
        {
          userId,
          type: "media.ingest",
          entityType: "video",
          entityId: videoId,
          payload: {
            videoId,
            sourcePath,
            outputDir: storagePaths.videoDir(videoId),
            maxDurationMinutes: getUploadLimits().maxDurationMinutes,
          },
        },
        tx,
      );
      await tx.upload.update({ where: { id: upload.id }, data: { status: "completed", videoId } });
    });
  } catch (error) {
    // Put things back so the user can try completing again.
    await fs.rename(absoluteSource, dataPath).catch(() => undefined);
    await removeStorageDir(storagePaths.videoDir(videoId)).catch(() => undefined);
    throw error;
  }

  await removeStorageDir(storagePaths.uploadTempDir(upload.id)).catch((error: unknown) =>
    logger.warn("Couldn't remove upload temp folder", { uploadId: upload.id, error }),
  );
  return { videoId };
}

async function failUpload(uploadId: string, reason: string) {
  await db.upload.update({ where: { id: uploadId }, data: { status: "failed", error: reason } });
  await removeStorageDir(storagePaths.uploadTempDir(uploadId)).catch(() => undefined);
}

/** User abandons an upload: its partial data is deleted immediately. */
export async function cancelUpload(userId: string, uploadId: string): Promise<void> {
  const upload = await getOwnedUpload(userId, uploadId);
  if (upload.status === "in_progress") {
    await db.upload.update({ where: { id: upload.id }, data: { status: "cancelled" } });
  }
  await removeStorageDir(storagePaths.uploadTempDir(upload.id));
}

/**
 * Safe cleanup of incomplete uploads: expires uploads idle for 24 h and deletes temp
 * folders that no active upload owns (e.g. left behind by a crash). Runs whenever a
 * new upload starts and when the library loads.
 */
export async function sweepStaleUploads(now = new Date()): Promise<{ expired: number; orphans: number }> {
  const stale = await db.upload.findMany({
    where: { status: "in_progress", expiresAt: { lt: now } },
    select: { id: true },
  });
  for (const upload of stale) {
    await db.upload.update({ where: { id: upload.id }, data: { status: "expired" } });
    await removeStorageDir(storagePaths.uploadTempDir(upload.id)).catch(() => undefined);
  }

  let orphans = 0;
  const tempRoot = resolveStoragePath(storagePaths.uploadTempRoot(), getStorageRoot());
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tempRoot);
  } catch {
    return { expired: stale.length, orphans };
  }
  if (entries.length > 0) {
    const active = new Set(
      (await db.upload.findMany({ where: { status: "in_progress" }, select: { id: true } })).map((u) => u.id),
    );
    for (const entry of entries) {
      if (active.has(entry)) continue;
      const stat = await fs.stat(path.join(tempRoot, entry)).catch(() => null);
      // Grace period so an upload created a moment ago is never touched.
      if (stat && now.getTime() - stat.mtimeMs > 60 * 60 * 1000) {
        await removeStorageDir(storagePaths.uploadTempDir(entry)).catch(() => undefined);
        orphans += 1;
      }
    }
  }
  return { expired: stale.length, orphans };
}
