import "server-only";
import { z } from "zod";
import { type ClipCategory, type ClipOrigin, type ClipStatus, clipStatusSchema } from "@/lib/constants";
import { db } from "../db";
import { getEnv } from "../env";
import { AppError } from "../errors";
import { assertNoActiveJob, enqueueJob } from "../jobs/queue";
import { readTranscriptFile, snapToWords, transcriptWords } from "../transcripts/transcript-file";
import { requireReadyAiProvider } from "./ai-providers";

/**
 * AI Clip Finder (CLIP-04…08). Suggestions are created only by the `ai.find_clips` job (real
 * transcript timings + a real AI rating, or explicitly labelled speech-pattern ranking).
 * Every query is scoped to the owner through the video.
 */

export type ClipView = {
  id: string;
  videoId: string;
  startMs: number;
  endMs: number;
  transcriptText: string;
  score: number | null;
  heuristicScore: number | null;
  aiScore: number | null;
  title: string;
  hook: string | null;
  reason: string | null;
  category: ClipCategory | null;
  origin: ClipOrigin;
  status: ClipStatus;
  provider: string | null;
  model: string | null;
  /** The Short made from this clip, if any (Phase 5). */
  shortId: string | null;
};

export type AnalysisState = {
  job: {
    id: string;
    status: string;
    progress: number;
    progressMessage: string | null;
    error: string | null;
    errorCode: string | null;
    finishedAt: string | null;
  } | null;
  /** Summary of the last successful analysis (mode, provider, model, warnings). */
  lastResult: { mode: "ai" | "heuristic"; provider: string | null; model: string | null; warnings: string[] } | null;
};

type ClipRow = Awaited<ReturnType<typeof db.clipCandidate.findFirstOrThrow>>;

function toView(clip: ClipRow & { short?: { id: string } | null }): ClipView {
  return {
    id: clip.id,
    videoId: clip.videoId,
    startMs: clip.startMs,
    endMs: clip.endMs,
    transcriptText: clip.transcriptText,
    score: clip.score,
    heuristicScore: clip.heuristicScore,
    aiScore: clip.aiScore,
    title: clip.title,
    hook: clip.hook,
    reason: clip.reason,
    category: clip.category as ClipCategory | null,
    origin: clip.origin as ClipOrigin,
    status: clipStatusSchema.catch("suggested").parse(clip.status),
    provider: clip.provider,
    model: clip.model,
    shortId: clip.short?.id ?? null,
  };
}

async function getOwnedVideo(userId: string, videoId: string) {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");
  return video;
}

async function getOwnedClip(userId: string, clipId: string) {
  const clip = await db.clipCandidate.findFirst({ where: { id: clipId, video: { userId } } });
  if (!clip) throw new AppError("NOT_FOUND", "Clip not found.");
  return clip;
}

const ORDER = [{ score: { sort: "desc" as const, nulls: "last" as const } }, { startMs: "asc" as const }];

export async function listClipsForVideo(userId: string, videoId: string): Promise<ClipView[]> {
  await getOwnedVideo(userId, videoId);
  const clips = await db.clipCandidate.findMany({
    where: { videoId },
    orderBy: ORDER,
    include: { short: { select: { id: true } } },
  });
  return clips.map(toView);
}

export type ClipWithVideo = ClipView & { videoTitle: string; hasPoster: boolean };

/** Clips across all of the owner's videos (Clip Finder overview, Shorts Editor queue). */
export async function listClips(userId: string, filter: { status?: ClipStatus; limit?: number } = {}) {
  const clips = await db.clipCandidate.findMany({
    where: { video: { userId }, ...(filter.status ? { status: filter.status } : {}) },
    include: { video: { select: { title: true, posterPath: true } }, short: { select: { id: true } } },
    orderBy: filter.status === "accepted" ? [{ reviewedAt: "desc" }] : ORDER,
    take: filter.limit ?? 200,
  });
  return clips.map((clip): ClipWithVideo => ({
    ...toView(clip),
    videoTitle: clip.video.title,
    hasPoster: Boolean(clip.video.posterPath),
  }));
}

export async function getAnalysisState(userId: string, videoId: string): Promise<AnalysisState> {
  const jobs = await db.job.findMany({
    where: { userId, entityType: "video", entityId: videoId, type: "ai.find_clips" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const latest = jobs[0];
  const lastSucceeded = jobs.find((job) => job.status === "succeeded" && job.resultJson);
  let lastResult: AnalysisState["lastResult"] = null;
  if (lastSucceeded?.resultJson) {
    const parsed = JSON.parse(lastSucceeded.resultJson) as Record<string, unknown>;
    lastResult = {
      mode: parsed.mode === "ai" ? "ai" : "heuristic",
      provider: typeof parsed.provider === "string" ? parsed.provider : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === "string") : [],
    };
  }
  return {
    job: latest
      ? {
          id: latest.id,
          status: latest.status,
          progress: latest.progress,
          progressMessage: latest.progressMessage,
          error: latest.error,
          errorCode: latest.errorCode,
          finishedAt: latest.finishedAt?.toISOString() ?? null,
        }
      : null,
    lastResult,
  };
}

/**
 * Queues clip analysis. mode "ai" uses the owner's chosen provider and refuses to start when it isn't
 * ready (with the fix); mode "heuristic" never uses AI and is labelled that way.
 */
export async function startClipAnalysis(userId: string, videoId: string, mode: "ai" | "heuristic"): Promise<void> {
  const video = await getOwnedVideo(userId, videoId);
  const transcript = await db.transcript.findUnique({ where: { videoId } });
  if (transcript?.status !== "ready" || !transcript.filePath) {
    throw new AppError("VALIDATION", "Transcribe the video first — clips are found from the transcript.");
  }
  if (transcript.wordCount < 5) {
    throw new AppError("VALIDATION", "No speech was found in this video, so there are no moments to suggest.");
  }
  const active = await db.job.count({
    where: { entityType: "video", entityId: videoId, type: "ai.find_clips", status: { in: ["queued", "running"] } },
  });
  if (active > 0) throw new AppError("CONFLICT", "Clips are already being found for this video.");

  const provider = mode === "ai" ? await requireReadyAiProvider(userId, "Finding clips with AI") : null;

  const env = getEnv();
  await db.$transaction(async (tx) => {
    await assertNoActiveJob(
      tx,
      { entityType: "video", entityId: videoId, type: "ai.find_clips" },
      "Clips are already being found for this video.",
    );
    await enqueueJob(
      {
        userId,
        type: "ai.find_clips",
        entityType: "video",
        entityId: videoId,
        priority: 150,
        // The AI step can fail for reasons the owner must fix (credentials, model); don't retry those silently.
        maxAttempts: 2,
        payload: {
          videoId,
          transcriptPath: transcript.filePath,
          mode,
          provider,
          minSec: env.CLIP_MIN_SEC,
          maxSec: Math.max(env.CLIP_MAX_SEC, env.CLIP_MIN_SEC + 5),
          maxClips: env.CLIP_MAX_SUGGESTIONS,
          aiCandidates: env.CLIP_AI_CANDIDATES,
          aiBatchSize: env.CLIP_AI_BATCH_SIZE,
          videoTitle: video.title,
          notes: video.notes,
        },
      },
      tx,
    );
  });
}

async function snapForVideo(videoId: string, startMs: number, endMs: number) {
  const [video, transcript] = await Promise.all([
    db.video.findUnique({ where: { id: videoId }, select: { durationMs: true } }),
    db.transcript.findUnique({ where: { videoId } }),
  ]);
  if (transcript?.status !== "ready" || !transcript.filePath) {
    throw new AppError("VALIDATION", "This video's transcript isn't available.");
  }
  const file = await readTranscriptFile(transcript.filePath);
  const duration = video?.durationMs ?? file.durationMs;
  if (startMs < 0 || endMs > duration + 1000 || endMs <= startMs) {
    throw new AppError("VALIDATION", "The start must be before the end, and both inside the video.");
  }
  return snapToWords(transcriptWords(file), startMs, endMs, duration);
}

export const clipRangeSchema = z.object({
  startMs: z
    .number()
    .int()
    .nonnegative()
    .max(24 * 3600 * 1000),
  endMs: z
    .number()
    .int()
    .positive()
    .max(24 * 3600 * 1000),
});

/** CLIP-06: adjust a clip; the result is snapped to whole words and its transcript text updated. */
export async function updateClipRange(userId: string, clipId: string, range: z.infer<typeof clipRangeSchema>) {
  const clip = await getOwnedClip(userId, clipId);
  const snapped = await snapForVideo(clip.videoId, range.startMs, range.endMs);
  const updated = await db.clipCandidate.update({
    where: { id: clip.id },
    data: { startMs: snapped.startMs, endMs: snapped.endMs, transcriptText: snapped.text },
  });
  return toView(updated);
}

/** Accepting sends the clip to the Shorts Editor queue; rejecting hides it from the review list. */
export async function setClipStatus(userId: string, clipId: string, status: ClipStatus): Promise<void> {
  const clip = await getOwnedClip(userId, clipId);
  await db.clipCandidate.update({
    where: { id: clip.id },
    data: { status, reviewedAt: status === "suggested" ? null : new Date() },
  });
}

/** CLIP-06: a clip chosen by hand from the transcript. Labelled "manual" — never shown as AI. */
export async function createManualClip(userId: string, videoId: string, range: z.infer<typeof clipRangeSchema>) {
  await getOwnedVideo(userId, videoId);
  const snapped = await snapForVideo(videoId, range.startMs, range.endMs);
  const firstSentence = snapped.text.split(/(?<=[.!?])\s/)[0] ?? snapped.text;
  const clip = await db.clipCandidate.create({
    data: {
      videoId,
      startMs: snapped.startMs,
      endMs: snapped.endMs,
      transcriptText: snapped.text,
      title: firstSentence.length > 60 ? `${firstSentence.slice(0, 59)}…` : firstSentence,
      origin: "manual",
      status: "suggested",
    },
  });
  return toView(clip);
}

export async function updateClipTitle(userId: string, clipId: string, title: string): Promise<void> {
  const clip = await getOwnedClip(userId, clipId);
  await db.clipCandidate.update({ where: { id: clip.id }, data: { title } });
}

export type ClipFinderVideoRow = {
  id: string;
  title: string;
  status: string;
  hasPoster: boolean;
  durationMs: number | null;
  transcriptStatus: "none" | "processing" | "ready" | "failed";
  analysing: boolean;
  toReview: number;
  accepted: number;
};

/** One row per video for the Clip Finder overview page. */
export async function listClipFinderOverview(userId: string): Promise<ClipFinderVideoRow[]> {
  const [videos, counts, activeJobs] = await Promise.all([
    db.video.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { transcript: { select: { status: true } } },
    }),
    db.clipCandidate.groupBy({
      by: ["videoId", "status"],
      where: { video: { userId } },
      _count: { _all: true },
    }),
    db.job.findMany({
      where: { userId, type: "ai.find_clips", status: { in: ["queued", "running"] } },
      select: { entityId: true },
    }),
  ]);
  const count = (videoId: string, status: string) =>
    counts.find((row) => row.videoId === videoId && row.status === status)?._count._all ?? 0;
  const analysing = new Set(activeJobs.map((job) => job.entityId));
  return videos.map((video) => ({
    id: video.id,
    title: video.title,
    status: video.status,
    hasPoster: Boolean(video.posterPath),
    durationMs: video.durationMs,
    transcriptStatus: (video.transcript?.status ?? "none") as ClipFinderVideoRow["transcriptStatus"],
    analysing: analysing.has(video.id),
    toReview: count(video.id, "suggested"),
    accepted: count(video.id, "accepted"),
  }));
}
