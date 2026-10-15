import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { getUploadLimits } from "../env";
import { logger } from "../logger";
import { removeStorageDir, storagePaths } from "../storage";
import { generatorProjectIdOf } from "./gen-script";
import type { JobHandler } from "./handlers";
import { enqueueJob } from "./queue";

/**
 * gen.render — the finished MP4 (GEN-05). On success it becomes a library video (`sourceType = generated`,
 * GEN-06) and goes through normal processing (poster, metadata, transcription) like an upload.
 */
export const genRenderResultSchema = z.object({
  outputPath: z.string().min(1).max(300),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  sizeBytes: z.number().int().positive(),
  elapsedMs: z.number().int().nonnegative(),
});
export type GenRenderResult = z.infer<typeof genRenderResultSchema>;

export const genRenderPayloadSchema = z.object({
  projectId: z.string(),
  videoId: z.string(),
  outputPath: z.string(),
  title: z.string(),
  topic: z.string(),
  credits: z.string(),
});

function payloadOf(job: Job) {
  return genRenderPayloadSchema.parse(JSON.parse(job.payloadJson));
}

export const genRenderHandler: JobHandler<GenRenderResult> = {
  resultSchema: genRenderResultSchema,

  async onSucceeded(tx, job, result) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const payload = payloadOf(job);
    if (result.outputPath !== payload.outputPath || payload.outputPath !== `videos/${payload.videoId}/source.mp4`) {
      throw new Error("Unexpected output path");
    }
    const project = await tx.generatorProject.findUnique({ where: { id: projectId }, select: { status: true } });
    // Deleted meanwhile (its jobs are cancelled first), or not rendering any more: don't add a video.
    if (project?.status !== "rendering") return;
    await tx.video.create({
      data: {
        id: payload.videoId,
        userId: job.userId,
        title: payload.title,
        notes: `Made with the Original Video Generator. Topic: ${payload.topic}`.slice(0, 5000),
        creditsText: payload.credits,
        sourceType: "generated",
        status: "processing",
        originalFilename: `${
          payload.title
            .replace(/[^\w\- ]+/g, "")
            .trim()
            .slice(0, 80) || "generated-video"
        }.mp4`,
        sourcePath: result.outputPath,
        sizeBytes: BigInt(result.sizeBytes),
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        container: "mp4",
      },
    });
    await enqueueJob(
      {
        userId: job.userId,
        type: "media.ingest",
        entityType: "video",
        entityId: payload.videoId,
        payload: {
          videoId: payload.videoId,
          sourcePath: result.outputPath,
          outputDir: storagePaths.videoDir(payload.videoId),
          maxDurationMinutes: getUploadLimits().maxDurationMinutes,
        },
      },
      tx,
    );
    await tx.generatorProject.update({
      where: { id: projectId },
      data: {
        status: "ready",
        error: null,
        outputVideoId: payload.videoId,
        creditsText: payload.credits,
        renderElapsedMs: result.elapsedMs,
        renderedAt: new Date(),
      },
    });
  },

  async onFailed(job) {
    const projectId = generatorProjectIdOf(job);
    if (!projectId) return;
    const payload = payloadOf(job);
    // Nothing reached the library, so the partial output folder can go.
    if (!(await db.video.findUnique({ where: { id: payload.videoId }, select: { id: true } }))) {
      await removeStorageDir(storagePaths.videoDir(payload.videoId)).catch((error: unknown) =>
        logger.warn("Couldn't remove a failed render", { projectId, error }),
      );
    }
    const project = await db.generatorProject.findUnique({
      where: { id: projectId },
      select: { status: true, outputVideoId: true },
    });
    if (project?.status !== "rendering") return;
    await db.generatorProject.update({
      where: { id: projectId },
      data: {
        status: project.outputVideoId ? "ready" : "editing",
        error: job.status === "cancelled" ? null : (job.error ?? "Rendering failed."),
      },
    });
  },

  async cannotRetryReason() {
    // The scenes may have changed since: render again from the project instead.
    return "Render again from the project page, so the latest script and footage are used.";
  },

  async onRetry() {},
};
