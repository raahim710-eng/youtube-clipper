import type { Job } from "@/generated/prisma/client";
import { ACTIVE_JOB_STATUSES } from "@/lib/constants";
import { db } from "../db";
import { type ReframeData, reframeDataSchema } from "../shorts/reframe-data";
import type { JobHandler } from "./handlers";

/**
 * media.reframe — face tracking for a Short's auto framing (SHORT-03, TECHNICAL_SPEC.md §7.3).
 * The worker returns crop-centre keyframes in source-video time.
 */
export const mediaReframeResultSchema = reframeDataSchema
  .refine((data) => data.endMs > data.startMs, "Invalid range")
  .refine(
    (data) =>
      data.keyframes.every((k, i) => i === 0 || k.tMs >= data.keyframes[i - 1].tMs) &&
      data.keyframes.every((k) => k.tMs >= data.startMs - 1 && k.tMs <= data.endMs + 1),
    "Keyframes must be sorted and inside the analysed range",
  );

function shortIdOf(job: Job): string | null {
  return job.entityType === "short" && job.entityId ? job.entityId : null;
}

async function otherActiveReframe(shortId: string, jobId: string): Promise<boolean> {
  const count = await db.job.count({
    where: {
      entityType: "short",
      entityId: shortId,
      type: "media.reframe",
      id: { not: jobId },
      status: { in: [...ACTIVE_JOB_STATUSES] },
    },
  });
  return count > 0;
}

export const mediaReframeHandler: JobHandler<ReframeData> = {
  resultSchema: mediaReframeResultSchema,

  async onSucceeded(tx, job, result) {
    const shortId = shortIdOf(job);
    if (!shortId) return;
    const short = await tx.short.findUnique({ where: { id: shortId }, select: { id: true } });
    if (!short) return; // deleted meanwhile
    const newer = await tx.job.count({
      where: {
        entityType: "short",
        entityId: shortId,
        type: "media.reframe",
        id: { not: job.id },
        status: { in: [...ACTIVE_JOB_STATUSES] },
      },
    });
    await tx.short.update({
      where: { id: shortId },
      data: {
        reframeJson: JSON.stringify(result),
        reframeStatus: newer > 0 ? "processing" : "ready",
        reframeError: null,
      },
    });
  },

  async onFailed(job) {
    const shortId = shortIdOf(job);
    if (!shortId || (await otherActiveReframe(shortId, job.id))) return; // a newer analysis is on its way
    const short = await db.short.findUnique({ where: { id: shortId }, select: { reframeJson: true } });
    if (!short) return;
    await db.short.update({
      where: { id: shortId },
      data:
        job.status === "cancelled"
          ? { reframeStatus: short.reframeJson ? "ready" : "none", reframeError: null }
          : { reframeStatus: "failed", reframeError: job.error ?? "Face tracking failed." },
    });
  },

  async cannotRetryReason(job) {
    const shortId = shortIdOf(job);
    if (!shortId) return "This job is no longer linked to a Short.";
    const short = await db.short.findUnique({ where: { id: shortId }, select: { id: true } });
    return short ? null : "The Short was deleted.";
  },

  async onRetry(tx, job) {
    const shortId = shortIdOf(job);
    if (shortId)
      await tx.short.update({ where: { id: shortId }, data: { reframeStatus: "processing", reframeError: null } });
  },
};
