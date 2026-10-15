import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { storageFileSize } from "../storage";
import type { JobHandler } from "./handlers";

/** media.render_short — the exported 1080×1920 MP4 (SHORT-05, TECHNICAL_SPEC.md §7.3). */
export const mediaRenderShortResultSchema = z.object({
  outputPath: z.string().min(1).max(300),
  sizeBytes: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  width: z.literal(1080),
  height: z.literal(1920),
  fps: z.number().positive().nullable(),
  videoCodec: z.string().max(50),
  audioCodec: z.string().max(50).nullable(),
  elapsedMs: z.number().int().nonnegative(),
  preset: z.string().max(20),
  crf: z.number().int(),
});
export type MediaRenderShortResult = z.infer<typeof mediaRenderShortResultSchema>;

const payloadSchema = z.object({ outputPath: z.string(), signature: z.string() });

function shortIdOf(job: Job): string | null {
  return job.entityType === "short" && job.entityId ? job.entityId : null;
}

export const mediaRenderShortHandler: JobHandler<MediaRenderShortResult> = {
  resultSchema: mediaRenderShortResultSchema,

  async onSucceeded(tx, job, result) {
    const shortId = shortIdOf(job);
    if (!shortId) return;
    const payload = payloadSchema.parse(JSON.parse(job.payloadJson));
    // The worker may only report the file the app asked for.
    if (result.outputPath !== payload.outputPath || !result.outputPath.startsWith(`shorts/${shortId}/`)) {
      throw new Error("Unexpected output path");
    }
    const short = await tx.short.findUnique({ where: { id: shortId }, select: { id: true } });
    if (!short) return; // deleted meanwhile
    await tx.short.update({
      where: { id: shortId },
      data: {
        status: "ready",
        renderError: null,
        outputPath: result.outputPath,
        outputSizeBytes: BigInt(result.sizeBytes),
        outputDurationMs: result.durationMs,
        renderSignature: payload.signature,
        renderElapsedMs: result.elapsedMs,
        renderedAt: new Date(),
      },
    });
  },

  async onFailed(job) {
    const shortId = shortIdOf(job);
    if (!shortId) return;
    const short = await db.short.findUnique({ where: { id: shortId }, select: { outputPath: true } });
    if (!short) return;
    await db.short.update({
      where: { id: shortId },
      data:
        job.status === "cancelled"
          ? { status: short.outputPath ? "ready" : "draft", renderError: null }
          : { status: "failed", renderError: job.error ?? "Exporting failed." },
    });
  },

  async cannotRetryReason(job) {
    const shortId = shortIdOf(job);
    if (!shortId) return "This job is no longer linked to a Short.";
    const short = await db.short.findUnique({ where: { id: shortId }, include: { video: true } });
    if (!short) return "The Short was deleted.";
    if ((await storageFileSize(short.video.sourcePath)) === null) return "The original video file is missing.";
    return null;
  },

  async onRetry(tx, job) {
    const shortId = shortIdOf(job);
    if (shortId) await tx.short.update({ where: { id: shortId }, data: { status: "rendering", renderError: null } });
  },
};
