import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import { CLIP_CATEGORIES, CLIP_MAX_MS, CLIP_MIN_MS } from "@/lib/constants";
import { db } from "../db";
import type { JobHandler } from "./handlers";

/**
 * ai.find_clips — moments that could become Shorts (TECHNICAL_SPEC.md §7.2). Timestamps come from
 * transcript word timings in the worker; the AI only rates and describes candidates.
 */

const clipSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    score: z.number().int().min(0).max(100),
    heuristicScore: z.number().int().min(0).max(100),
    aiScore: z.number().int().min(0).max(100).nullable(),
    title: z.string().trim().min(1).max(120),
    hook: z.string().trim().max(200).nullable(),
    reason: z.string().trim().max(400).nullable(),
    category: z.enum(CLIP_CATEGORIES).nullable(),
    transcriptText: z.string().trim().min(1).max(4000),
  })
  .refine((clip) => clip.endMs - clip.startMs >= CLIP_MIN_MS, "Clip too short")
  .refine((clip) => clip.endMs - clip.startMs <= CLIP_MAX_MS + 1_000, "Clip too long");

export const aiFindClipsResultSchema = z
  .object({
    mode: z.enum(["ai", "heuristic"]),
    provider: z.string().max(50).nullable(),
    model: z.string().max(100).nullable(),
    clips: z.array(clipSchema).max(30),
    analysedCandidates: z.number().int().nonnegative(),
    ratedCandidates: z.number().int().nonnegative(),
    failedBatches: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(300)).max(10),
  })
  // A result that claims to be AI analysis must say which AI produced it, and every clip must carry its AI score.
  .refine(
    (result) =>
      result.mode === "heuristic"
        ? result.clips.every((clip) => clip.aiScore === null)
        : Boolean(result.provider && result.model) && result.clips.every((clip) => clip.aiScore !== null),
    "AI results must name the provider and model",
  );
export type AiFindClipsResult = z.infer<typeof aiFindClipsResultSchema>;

function videoIdOf(job: Job): string | null {
  return job.entityType === "video" && job.entityId ? job.entityId : null;
}

export const aiFindClipsHandler: JobHandler<AiFindClipsResult> = {
  resultSchema: aiFindClipsResultSchema,

  async onSucceeded(tx, job, result) {
    const videoId = videoIdOf(job);
    if (!videoId) return;
    const video = await tx.video.findUnique({ where: { id: videoId }, select: { durationMs: true } });
    if (!video) return; // deleted meanwhile
    const limit = (video.durationMs ?? Number.MAX_SAFE_INTEGER) + 1_000;
    if (result.clips.some((clip) => clip.endMs > limit)) throw new Error("Clip outside the video's duration");

    // New analysis replaces earlier suggestions; accepted and manual clips are kept.
    await tx.clipCandidate.deleteMany({
      where: { videoId, origin: { in: ["ai", "heuristic"] }, status: { in: ["suggested", "rejected"] } },
    });
    await tx.clipCandidate.createMany({
      data: result.clips.map((clip) => ({
        videoId,
        startMs: clip.startMs,
        endMs: clip.endMs,
        transcriptText: clip.transcriptText,
        score: clip.score,
        heuristicScore: clip.heuristicScore,
        aiScore: clip.aiScore,
        title: clip.title,
        hook: clip.hook,
        reason: clip.reason,
        category: clip.category,
        origin: result.mode,
        provider: result.provider,
        model: result.model,
      })),
    });
  },

  async onFailed() {
    // Nothing to roll back: earlier suggestions stay; the job's error explains what happened.
  },

  async cannotRetryReason(job) {
    const videoId = videoIdOf(job);
    if (!videoId) return "This job is no longer linked to a video.";
    const transcript = await db.transcript.findUnique({ where: { videoId }, select: { status: true } });
    if (transcript?.status !== "ready") return "The video needs a finished transcript first.";
    return null;
  },

  async onRetry() {},
};
