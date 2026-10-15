import fs from "node:fs/promises";
import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { logger } from "../logger";
import { resolveStoragePath, storageFileSize, storagePaths } from "../storage";
import type { JobHandler } from "./handlers";
import { queueTranscription } from "./queue-transcription";

/**
 * media.ingest — the Python worker probes an uploaded video, makes a poster frame and,
 * when the browser can't play the original, a preview copy (TECHNICAL_SPEC.md §7.1).
 */

export const mediaIngestPayloadSchema = z.object({
  videoId: z.string().min(1),
  sourcePath: z.string().min(1),
  outputDir: z.string().min(1),
  maxDurationMinutes: z.number().int().positive(),
});
export type MediaIngestPayload = z.infer<typeof mediaIngestPayloadSchema>;

const storagePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => {
    try {
      resolveStoragePath(value);
      return true;
    } catch {
      return false;
    }
  }, "Path must stay inside storage");

export const mediaIngestResultSchema = z.object({
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  fps: z.number().positive().max(1000).nullable(),
  videoCodec: z.string().min(1).max(50),
  audioCodec: z.string().min(1).max(50).nullable(),
  posterPath: storagePath.nullable(),
  previewPath: storagePath.nullable(),
});
export type MediaIngestResult = z.infer<typeof mediaIngestResultSchema>;

/** Error codes the worker sends when the file itself is the problem (retrying won't help). */
const FILE_PROBLEM_CODES = new Set(["INVALID_VIDEO", "TOO_LONG"]);

function videoIdOf(job: Job): string | null {
  return job.entityType === "video" && job.entityId ? job.entityId : null;
}

export const mediaIngestHandler: JobHandler<MediaIngestResult> = {
  resultSchema: mediaIngestResultSchema,

  async onSucceeded(tx, job, result) {
    const videoId = videoIdOf(job);
    if (!videoId) return;
    // Outputs must live in this video's own folder.
    const ownDir = `${storagePaths.videoDir(videoId)}/`;
    for (const output of [result.posterPath, result.previewPath]) {
      if (output && !output.startsWith(ownDir)) throw new Error(`Output outside the video folder: ${output}`);
    }
    // updateMany: the video may have been deleted while processing — then there's nothing to update.
    await tx.video.updateMany({
      where: { id: videoId },
      data: {
        status: "ready",
        errorMessage: null,
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        fps: result.fps,
        videoCodec: result.videoCodec,
        audioCodec: result.audioCodec,
        posterPath: result.posterPath,
        previewPath: result.previewPath,
        processedAt: new Date(),
      },
    });

    // Phase 4: transcribe new videos automatically unless the owner turned it off.
    const settings = await tx.userSettings.findUnique({ where: { userId: job.userId } });
    if ((settings?.autoTranscribe ?? true) && result.audioCodec) {
      await queueTranscription(tx, job.userId, videoId, settings?.defaultLanguage ?? "auto");
    }
  },

  async onFailed(job) {
    const videoId = videoIdOf(job);
    if (!videoId) return;
    const message = job.errorCode === "CANCELLED" ? "Processing was cancelled." : (job.error ?? "Processing failed.");
    await db.video.updateMany({ where: { id: videoId }, data: { status: "failed", errorMessage: message } });

    // A file that isn't a usable video takes space for nothing: remove it, keep the record so
    // the user sees what happened.
    if (job.errorCode && FILE_PROBLEM_CODES.has(job.errorCode)) {
      const video = await db.video.findUnique({ where: { id: videoId }, select: { sourcePath: true } });
      if (video) {
        try {
          await fs.rm(resolveStoragePath(video.sourcePath), { force: true });
        } catch (error) {
          logger.warn("Couldn't delete rejected source file", { videoId, error });
        }
      }
    }
  },

  async cannotRetryReason(job) {
    const videoId = videoIdOf(job);
    if (!videoId) return "This job is no longer linked to a video.";
    const video = await db.video.findUnique({ where: { id: videoId }, select: { sourcePath: true } });
    if (!video) return "The video was deleted.";
    if ((await storageFileSize(video.sourcePath)) === null) {
      return "The original file is no longer available. Delete this video and upload it again.";
    }
    return null;
  },

  async onRetry(tx, job) {
    const videoId = videoIdOf(job);
    if (videoId) {
      await tx.video.updateMany({ where: { id: videoId }, data: { status: "processing", errorMessage: null } });
    }
  },
};
