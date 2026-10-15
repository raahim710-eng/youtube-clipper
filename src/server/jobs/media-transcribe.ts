import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { storageFileSize, storagePaths } from "../storage";
import { readTranscriptFile, transcriptFullText } from "../transcripts/transcript-file";
import type { JobHandler } from "./handlers";

/** media.transcribe — local speech-to-text with word timings (TECHNICAL_SPEC.md §7.2). */

export const mediaTranscribePayloadSchema = z.object({
  videoId: z.string().min(1),
  sourcePath: z.string().min(1),
  outputPath: z.string().min(1),
  language: z.string().max(10),
});

export const mediaTranscribeResultSchema = z.object({
  transcriptPath: z.string().min(1).max(300),
  provider: z.string().min(1).max(50),
  model: z.string().max(100).nullable(),
  language: z.string().max(20).nullable(),
  languageProbability: z.number().min(0).max(1).nullable(),
  durationMs: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
});
export type MediaTranscribeResult = z.infer<typeof mediaTranscribeResultSchema>;

export function transcriptPathFor(videoId: string): string {
  return `${storagePaths.videoDir(videoId)}/transcript.json`;
}

function videoIdOf(job: Job): string | null {
  return job.entityType === "video" && job.entityId ? job.entityId : null;
}

export const mediaTranscribeHandler: JobHandler<MediaTranscribeResult> = {
  resultSchema: mediaTranscribeResultSchema,

  async onSucceeded(tx, job, result) {
    const videoId = videoIdOf(job);
    if (!videoId) return;
    if (result.transcriptPath !== transcriptPathFor(videoId)) {
      throw new Error(`Unexpected transcript path: ${result.transcriptPath}`);
    }
    // Validates the file the worker wrote and derives the searchable text from it.
    const file = await readTranscriptFile(result.transcriptPath);
    await tx.transcript.updateMany({
      where: { videoId },
      data: {
        status: "ready",
        provider: result.provider,
        model: result.model,
        language: result.language,
        languageProbability: result.languageProbability,
        filePath: result.transcriptPath,
        fullText: transcriptFullText(file),
        wordCount: result.wordCount,
        segmentCount: result.segmentCount,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
  },

  async onFailed(job) {
    const videoId = videoIdOf(job);
    if (!videoId) return;
    const message =
      job.errorCode === "CANCELLED" ? "Transcription was cancelled." : (job.error ?? "Transcription failed.");
    await db.transcript.updateMany({ where: { videoId }, data: { status: "failed", errorMessage: message } });
  },

  async cannotRetryReason(job) {
    const videoId = videoIdOf(job);
    if (!videoId) return "This job is no longer linked to a video.";
    const video = await db.video.findUnique({ where: { id: videoId }, select: { sourcePath: true } });
    if (!video) return "The video was deleted.";
    if ((await storageFileSize(video.sourcePath)) === null) return "The original video file is no longer available.";
    if (job.errorCode === "NO_AUDIO") return "This video has no audio track, so it can't be transcribed.";
    return null;
  },

  async onRetry(tx, job) {
    const videoId = videoIdOf(job);
    if (videoId) {
      await tx.transcript.updateMany({ where: { videoId }, data: { status: "processing", errorMessage: null } });
    }
  },
};
