import type { Job } from "@/generated/prisma/client";
import { db } from "../db";
import { storageFileSize } from "../storage";
import { type YtUploadResult, ytUploadResultSchema } from "../youtube/upload";
import type { JobHandler } from "./handlers";

/** yt.upload — a video or Short uploaded to a connected YouTube channel (YT-04…06). */

function publicationIdOf(job: Job): string | null {
  return job.entityType === "publication" && job.entityId ? job.entityId : null;
}

export const ytUploadHandler: JobHandler<YtUploadResult> = {
  resultSchema: ytUploadResultSchema,

  async onSucceeded(tx, job, result) {
    const id = publicationIdOf(job);
    if (!id) return;
    const publication = await tx.publication.findUnique({ where: { id }, select: { publishAt: true } });
    if (!publication) return;
    await tx.publication.update({
      where: { id },
      data: {
        status: publication.publishAt ? "scheduled" : "uploaded",
        youtubeVideoId: result.youtubeVideoId,
        actualPrivacyStatus: result.privacyStatus,
        warningsJson: JSON.stringify(result.warnings),
        uploadProgress: 100,
        uploadSessionEnc: null,
        error: null,
        uploadedAt: new Date(),
      },
    });
  },

  async onFailed(job) {
    const id = publicationIdOf(job);
    if (!id) return;
    // The encrypted upload session is kept, so "Try again" continues where the upload stopped.
    await db.publication.updateMany({
      where: { id },
      data:
        job.status === "cancelled"
          ? { status: "cancelled", error: null }
          : { status: "failed", error: job.error ?? "The upload failed." },
    });
  },

  async cannotRetryReason(job) {
    const id = publicationIdOf(job);
    const publication = id ? await db.publication.findUnique({ where: { id }, include: { channel: true } }) : null;
    if (!publication) return "This upload was deleted.";
    if (publication.channel.status !== "active") return "Reconnect the channel in Settings › Channels first.";
    if ((await storageFileSize(publication.filePath)) === null) return "The video file is missing.";
    return null;
  },

  async onRetry(tx, job) {
    const id = publicationIdOf(job);
    if (id) await tx.publication.update({ where: { id }, data: { status: "queued", error: null } });
  },
};
