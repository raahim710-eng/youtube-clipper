import fs from "node:fs/promises";
import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { resolveStoragePath, storagePaths } from "../storage";
import type { JobHandler } from "./handlers";

/** media.thumbnail_mockup — a frame, a frame with a headline, or a re-encoded upload (PKG-06). */
export const mediaThumbnailResultSchema = z.object({
  outputPath: z.string().min(1).max(200),
  width: z.number().int().min(320).max(1920),
  height: z.number().int().min(320).max(1920),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024),
  headline: z.string().max(120).nullable(),
});
export type MediaThumbnailResult = z.infer<typeof mediaThumbnailResultSchema>;

function thumbnailIdOf(job: Job): string | null {
  return job.entityType === "thumbnail" && job.entityId ? job.entityId : null;
}

export const mediaThumbnailHandler: JobHandler<MediaThumbnailResult> = {
  resultSchema: mediaThumbnailResultSchema,

  async onSucceeded(tx, job, result) {
    const id = thumbnailIdOf(job);
    if (!id) return;
    if (result.outputPath !== storagePaths.thumbnail(id)) throw new Error("Unexpected thumbnail path");
    const thumbnail = await tx.thumbnail.findUnique({ where: { id }, select: { id: true } });
    if (!thumbnail) return;
    await tx.thumbnail.update({
      where: { id },
      data: {
        status: "ready",
        error: null,
        filePath: result.outputPath,
        width: result.width,
        height: result.height,
        sizeBytes: result.sizeBytes,
      },
    });
  },

  async onFailed(job) {
    const id = thumbnailIdOf(job);
    if (!id) return;
    await db.thumbnail.updateMany({
      where: { id },
      data: { status: "failed", error: job.status === "cancelled" ? "Cancelled by you." : (job.error ?? "Failed.") },
    });
    // An uploaded original is only kept while it's being checked (it may contain EXIF/GPS data).
    await fs.rm(resolveStoragePath(storagePaths.thumbnailUpload(id)), { force: true }).catch(() => undefined);
  },

  async cannotRetryReason(job) {
    const id = thumbnailIdOf(job);
    const thumbnail = id ? await db.thumbnail.findUnique({ where: { id }, select: { origin: true } }) : null;
    if (!thumbnail) return "The thumbnail was deleted.";
    return thumbnail.origin === "upload" ? "Upload the image again." : null;
  },

  async onRetry(tx, job) {
    const id = thumbnailIdOf(job);
    if (id) await tx.thumbnail.update({ where: { id }, data: { status: "processing", error: null } });
  },
};
