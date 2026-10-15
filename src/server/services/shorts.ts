import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma, Short } from "@/generated/prisma/client";
import {
  ACTIVE_JOB_STATUSES,
  CLIP_MAX_MS,
  CLIP_MIN_MS,
  EXPORT_QUALITIES,
  type ExportQuality,
  REFRAME_MODES,
  type ReframeMode,
  type ReframeStatus,
  type ShortStatus,
} from "@/lib/constants";
import { type CaptionWord, buildCaptions, captionsSchema, normalizeCaptions } from "@/lib/shorts/captions";
import {
  type CaptionStyle,
  captionStyleSchema,
  captionText,
  HOOK_DURATION_MS,
  hookStyle,
  parseCaptionStyle,
  renderStyle,
} from "@/lib/shorts/caption-style";
import { type CropKeyframe, framingKeyframes, needsHorizontalFraming, relativeKeyframes } from "@/lib/shorts/framing";
import { recordAuditEvent } from "../audit";
import { db } from "../db";
import { AppError } from "../errors";
import { assertNoActiveJob, cancelJobsForEntity, enqueueJob } from "../jobs/queue";
import { logger } from "../logger";
import {
  removeStorageDir,
  resolveExistingStoragePath,
  resolveStoragePath,
  storageFileSize,
  storagePaths,
} from "../storage";
import { type ReframeData, reframeDataSchema } from "../shorts/reframe-data";
import { readTranscriptFile, transcriptWords } from "../transcripts/transcript-file";
import { removeThumbnailFiles } from "./packaging";

/**
 * Shorts editor (SHORT-01…08, TECHNICAL_SPEC.md §7.3). Every query filters by `userId`.
 * Face tracking (`media.reframe`) and exports (`media.render_short`) run in the media worker.
 */

/** Face tracking analyses a little beyond the Short, so small trims don't need a new analysis. */
const REFRAME_PADDING_MS = 10_000;
/** The editor's timeline shows this much of the video around the Short. */
const EDITOR_CONTEXT_MS = 60_000;

/** Everything the editor can change. Saved as a whole (autosave). */
export const shortDocSchema = z
  .object({
    title: z.string().trim().min(1, "Give the Short a title.").max(120),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    reframeMode: z.enum(REFRAME_MODES),
    manualX: z.number().min(0).max(1),
    captionsEnabled: z.boolean(),
    captions: captionsSchema,
    captionStyle: captionStyleSchema,
    hookText: z.string().trim().max(120).nullable(),
    exportQuality: z.enum(EXPORT_QUALITIES),
  })
  .refine((doc) => doc.endMs - doc.startMs >= CLIP_MIN_MS, "A Short must be at least 1 second long.")
  .refine((doc) => doc.endMs - doc.startMs <= CLIP_MAX_MS, "A Short can be at most 3 minutes long.");
export type ShortDoc = z.infer<typeof shortDocSchema>;

export type ShortStatusView = {
  reframe: {
    status: ReframeStatus;
    error: string | null;
    keyframes: CropKeyframe[] | null;
    /** Face tracking covers the current range (needed for auto framing). */
    covers: boolean;
    warnings: string[];
    job: JobProgress | null;
  };
  render: {
    status: ShortStatus;
    error: string | null;
    job: JobProgress | null;
    /** Settings changed since the last export (SHORT-07). */
    stale: boolean;
    output: {
      url: string;
      downloadUrl: string;
      sizeBytes: number;
      durationMs: number | null;
      renderedAt: string;
      elapsedMs: number | null;
    } | null;
  };
};

type JobProgress = { id: string; status: string; progress: number; message: string | null };

export type ShortEditorData = {
  id: string;
  videoId: string;
  videoTitle: string;
  videoDurationMs: number;
  sourceWidth: number;
  sourceHeight: number;
  fps: number | null;
  hasAudio: boolean;
  hasPoster: boolean;
  clipCandidateId: string | null;
  doc: ShortDoc;
  /** Part of the video the timeline shows, with the transcript words and loudness inside it. */
  window: { startMs: number; endMs: number };
  words: CaptionWord[];
  loudness: { windowMs: number; startMs: number; db: number[] } | null;
  transcriptReady: boolean;
  status: ShortStatusView;
};

export type ShortSummary = {
  id: string;
  title: string;
  videoId: string;
  videoTitle: string;
  hasPoster: boolean;
  startMs: number;
  endMs: number;
  reframeMode: ReframeMode;
  manualX: number;
  status: ShortStatus;
  stale: boolean;
  hasOutput: boolean;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseJson<T>(schema: z.ZodType<T>, json: string | null): T | null {
  if (!json) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function docOf(short: Short): ShortDoc {
  return {
    title: short.title,
    startMs: short.startMs,
    endMs: short.endMs,
    reframeMode: short.reframeMode as ReframeMode,
    manualX: short.manualX,
    captionsEnabled: short.captionsEnabled,
    captions: parseJson(captionsSchema, short.captionsJson) ?? [],
    captionStyle: parseCaptionStyle(short.captionStyleJson),
    hookText: short.hookText,
    exportQuality: short.exportQuality as ExportQuality,
  };
}

function coversRange(data: ReframeData | null, startMs: number, endMs: number): boolean {
  return Boolean(data && data.startMs <= startMs && data.endMs >= endMs);
}

type SourceInfo = { width: number; height: number };

/** What an export of the current settings would contain — hashed to detect "out of date" renders. */
function renderInputs(doc: ShortDoc, reframe: ReframeData | null, source: SourceInfo) {
  const autoKeyframes = coversRange(reframe, doc.startMs, doc.endMs) && reframe ? reframe.keyframes : null;
  const horizontal = needsHorizontalFraming(source.width, source.height);
  const keyframes =
    doc.reframeMode === "blur" || !horizontal
      ? []
      : relativeKeyframes(
          framingKeyframes(doc.reframeMode, { manualX: doc.manualX, autoKeyframes }),
          doc.startMs,
          doc.endMs,
        );
  const captions = doc.captionsEnabled
    ? normalizeCaptions(doc.captions, doc.startMs, doc.endMs).map((caption) => ({
        startMs: caption.startMs - doc.startMs,
        endMs: caption.endMs - doc.startMs,
        text: captionText(caption.text, doc.captionStyle),
      }))
    : [];
  return {
    startMs: doc.startMs,
    endMs: doc.endMs,
    framing: { mode: doc.reframeMode === "blur" ? ("blur" as const) : ("crop" as const), keyframes },
    captions,
    captionStyle: captions.length > 0 ? renderStyle(doc.captionStyle) : null,
    hook: doc.hookText
      ? {
          text: doc.hookText,
          endMs: Math.min(HOOK_DURATION_MS, doc.endMs - doc.startMs),
          style: renderStyle(hookStyle(doc.captionStyle)),
        }
      : null,
    quality: doc.exportQuality,
  };
}

function signatureOf(inputs: ReturnType<typeof renderInputs>): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

async function activeJob(shortId: string, type: "media.reframe" | "media.render_short") {
  return db.job.findFirst({
    where: { entityType: "short", entityId: shortId, type, status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, progress: true, progressMessage: true },
  });
}

function jobProgress(job: Awaited<ReturnType<typeof activeJob>>): JobProgress | null {
  return job ? { id: job.id, status: job.status, progress: job.progress, message: job.progressMessage } : null;
}

async function statusOf(short: Short, source: SourceInfo): Promise<ShortStatusView> {
  const [reframeJob, renderJob] = await Promise.all([
    activeJob(short.id, "media.reframe"),
    activeJob(short.id, "media.render_short"),
  ]);
  const reframe = parseJson(reframeDataSchema, short.reframeJson);
  const doc = docOf(short);
  const current = signatureOf(renderInputs(doc, reframe, source));
  return {
    reframe: {
      status: short.reframeStatus as ReframeStatus,
      error: short.reframeError,
      keyframes: reframe?.keyframes ?? null,
      covers: coversRange(reframe, short.startMs, short.endMs),
      warnings: reframe?.warnings ?? [],
      job: jobProgress(reframeJob),
    },
    render: {
      status: short.status as ShortStatus,
      error: short.renderError,
      job: jobProgress(renderJob),
      stale: Boolean(short.outputPath && short.renderSignature !== current),
      output:
        short.outputPath && short.renderedAt
          ? {
              url: `/api/media/shorts/${short.id}?v=${short.renderedAt.getTime()}`,
              downloadUrl: `/api/media/shorts/${short.id}?download=1`,
              sizeBytes: Number(short.outputSizeBytes ?? 0),
              durationMs: short.outputDurationMs,
              renderedAt: short.renderedAt.toISOString(),
              elapsedMs: short.renderElapsedMs,
            }
          : null,
    },
  };
}

async function findOwnedShort(userId: string, shortId: string) {
  const short = await db.short.findFirst({ where: { id: shortId, userId }, include: { video: true } });
  if (!short) throw new AppError("NOT_FOUND", "Short not found.");
  return short;
}

function sourceOf(video: { width: number | null; height: number | null }): SourceInfo {
  return { width: video.width ?? 1920, height: video.height ?? 1080 };
}

export async function getShortStatus(userId: string, shortId: string): Promise<ShortStatusView> {
  const short = await findOwnedShort(userId, shortId);
  return statusOf(short, sourceOf(short.video));
}

export async function getShortEditor(userId: string, shortId: string): Promise<ShortEditorData | null> {
  const short = await db.short.findFirst({
    where: { id: shortId, userId },
    include: { video: { include: { transcript: true } } },
  });
  if (!short) return null;
  const { video } = short;
  const durationMs = video.durationMs ?? short.endMs;
  const window = {
    startMs: Math.max(0, short.startMs - EDITOR_CONTEXT_MS),
    endMs: Math.min(durationMs, short.endMs + EDITOR_CONTEXT_MS),
  };

  let words: CaptionWord[] = [];
  let loudness: ShortEditorData["loudness"] = null;
  const transcriptReady = video.transcript?.status === "ready" && Boolean(video.transcript.filePath);
  if (transcriptReady && video.transcript?.filePath) {
    try {
      const file = await readTranscriptFile(video.transcript.filePath);
      words = transcriptWords(file).filter((w) => w.endMs > window.startMs && w.startMs < window.endMs);
      if (file.loudness) {
        const { windowMs, db: levels } = file.loudness;
        const first = Math.floor(window.startMs / windowMs);
        const last = Math.ceil(window.endMs / windowMs);
        loudness = { windowMs, startMs: first * windowMs, db: levels.slice(first, last) };
      }
    } catch (error) {
      logger.warn("Couldn't read transcript for the Shorts editor", { shortId, error });
    }
  }

  return {
    id: short.id,
    videoId: video.id,
    videoTitle: video.title,
    videoDurationMs: durationMs,
    sourceWidth: video.width ?? 1920,
    sourceHeight: video.height ?? 1080,
    fps: video.fps,
    hasAudio: Boolean(video.audioCodec),
    hasPoster: Boolean(video.posterPath),
    clipCandidateId: short.clipCandidateId,
    doc: docOf(short),
    window,
    words,
    loudness,
    transcriptReady,
    status: await statusOf(short, sourceOf(video)),
  };
}

export async function listShorts(userId: string, options: { limit?: number } = {}): Promise<ShortSummary[]> {
  const shorts = await db.short.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: options.limit ?? 100,
    include: { video: { select: { title: true, posterPath: true, width: true, height: true } } },
  });
  return shorts.map((short) => {
    const reframe = parseJson(reframeDataSchema, short.reframeJson);
    const signature = signatureOf(renderInputs(docOf(short), reframe, sourceOf(short.video)));
    return {
      id: short.id,
      title: short.title,
      videoId: short.videoId,
      videoTitle: short.video.title,
      hasPoster: Boolean(short.video.posterPath),
      startMs: short.startMs,
      endMs: short.endMs,
      reframeMode: short.reframeMode as ReframeMode,
      manualX: short.manualX,
      status: short.status as ShortStatus,
      stale: Boolean(short.outputPath && short.renderSignature !== signature),
      hasOutput: Boolean(short.outputPath),
      updatedAt: short.updatedAt.toISOString(),
    };
  });
}

/** Accepted clips that don't have a Short yet (the Shorts Editor's queue, D-037). */
export async function listClipsWithoutShort(userId: string) {
  return db.clipCandidate.findMany({
    where: { status: "accepted", short: null, video: { userId } },
    orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      title: true,
      startMs: true,
      endMs: true,
      origin: true,
      aiScore: true,
      provider: true,
      model: true,
      videoId: true,
      video: { select: { title: true, posterPath: true } },
    },
  });
}

// ---------------------------------------------------------------------------
// Creating and saving
// ---------------------------------------------------------------------------

async function defaultCaptionStyle(userId: string): Promise<CaptionStyle> {
  const settings = await db.userSettings.findUnique({ where: { userId }, select: { captionStyleJson: true } });
  return parseCaptionStyle(settings?.captionStyleJson);
}

async function wordsForVideo(videoId: string): Promise<CaptionWord[] | null> {
  const transcript = await db.transcript.findUnique({ where: { videoId } });
  if (transcript?.status !== "ready" || !transcript.filePath) return null;
  try {
    return transcriptWords(await readTranscriptFile(transcript.filePath));
  } catch (error) {
    logger.warn("Couldn't read transcript for captions", { videoId, error });
    return null;
  }
}

/**
 * SHORT-01: turns a clip into a Short (or opens the existing one). Captions come from the transcript;
 * framing starts on Auto, which queues face tracking.
 */
export async function createShortFromClip(userId: string, clipId: string): Promise<string> {
  const clip = await db.clipCandidate.findFirst({
    where: { id: clipId, video: { userId } },
    include: { video: true, short: { select: { id: true } } },
  });
  if (!clip) throw new AppError("NOT_FOUND", "Clip not found.");
  if (clip.short) return clip.short.id;
  if (clip.video.status !== "ready") throw new AppError("VALIDATION", "The video is still being processed.");
  const length = clip.endMs - clip.startMs;
  if (length < CLIP_MIN_MS || length > CLIP_MAX_MS) {
    throw new AppError("VALIDATION", "A Short must be between 1 second and 3 minutes long.");
  }

  const [style, words] = await Promise.all([defaultCaptionStyle(userId), wordsForVideo(clip.videoId)]);
  const captions = words ? buildCaptions(words, clip.startMs, clip.endMs) : [];
  const horizontal = needsHorizontalFraming(clip.video.width ?? 1920, clip.video.height ?? 1080);

  const short = await db.$transaction(async (tx) => {
    const created = await tx.short.create({
      data: {
        userId,
        videoId: clip.videoId,
        clipCandidateId: clip.id,
        title: clip.title.slice(0, 120),
        startMs: clip.startMs,
        endMs: clip.endMs,
        reframeMode: horizontal ? "auto" : "center",
        captionsEnabled: captions.length > 0,
        captionsJson: JSON.stringify(captions),
        captionStyleJson: JSON.stringify(style),
      },
    });
    if (clip.status !== "accepted") {
      await tx.clipCandidate.update({ where: { id: clip.id }, data: { status: "accepted", reviewedAt: new Date() } });
    }
    if (horizontal) await queueReframe(tx, created, clip.video.sourcePath);
    return created;
  });
  await recordAuditEvent({ action: "short.created", userId, details: { shortId: short.id, clipId: clip.id } });
  return short.id;
}

async function queueReframe(
  tx: Prisma.TransactionClient,
  short: Pick<Short, "id" | "userId" | "videoId" | "startMs" | "endMs">,
  sourcePath: string,
): Promise<void> {
  const video = await tx.video.findUniqueOrThrow({ where: { id: short.videoId }, select: { durationMs: true } });
  const startMs = Math.max(0, short.startMs - REFRAME_PADDING_MS);
  const endMs = Math.min(video.durationMs ?? short.endMs, short.endMs + REFRAME_PADDING_MS);
  await cancelJobsForEntity("short", short.id, tx, "media.reframe");
  await tx.short.update({ where: { id: short.id }, data: { reframeStatus: "processing", reframeError: null } });
  await enqueueJob(
    {
      userId: short.userId,
      type: "media.reframe",
      entityType: "short",
      entityId: short.id,
      payload: { shortId: short.id, sourcePath, startMs, endMs },
      priority: 60,
    },
    tx,
  );
}

/**
 * Autosave. Validates and normalises the whole document; changing the range or switching to Auto
 * queues face tracking when the current analysis doesn't cover the new range.
 */
export async function saveShort(userId: string, shortId: string, input: ShortDoc): Promise<ShortStatusView> {
  const short = await findOwnedShort(userId, shortId);
  const durationMs = short.video.durationMs ?? input.endMs;
  if (input.endMs > durationMs + 50) throw new AppError("VALIDATION", "The Short can't end after the video ends.");

  const captions = normalizeCaptions(input.captions, input.startMs, input.endMs);
  const reframe = parseJson(reframeDataSchema, short.reframeJson);
  const horizontal = needsHorizontalFraming(short.video.width ?? 1920, short.video.height ?? 1080);
  const needsReframe =
    horizontal &&
    input.reframeMode === "auto" &&
    !coversRange(reframe, input.startMs, input.endMs) &&
    !(await activeReframeCovers(short.id, input.startMs, input.endMs));

  const updated = await db.$transaction(async (tx) => {
    const saved = await tx.short.update({
      where: { id: short.id },
      data: {
        title: input.title,
        startMs: input.startMs,
        endMs: Math.min(input.endMs, durationMs),
        reframeMode: input.reframeMode,
        manualX: input.manualX,
        captionsEnabled: input.captionsEnabled,
        captionsJson: JSON.stringify(captions),
        captionStyleJson: JSON.stringify(input.captionStyle),
        hookText: input.hookText || null,
        exportQuality: input.exportQuality,
      },
    });
    if (needsReframe) await queueReframe(tx, saved, short.video.sourcePath);
    return saved;
  });
  const fresh = await db.short.findUniqueOrThrow({ where: { id: updated.id } });
  return statusOf(fresh, sourceOf(short.video));
}

async function activeReframeCovers(shortId: string, startMs: number, endMs: number): Promise<boolean> {
  const job = await db.job.findFirst({
    where: { entityType: "short", entityId: shortId, type: "media.reframe", status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { payloadJson: true },
  });
  if (!job) return false;
  const payload = parseJson(z.object({ startMs: z.number(), endMs: z.number() }), job.payloadJson);
  return Boolean(payload && payload.startMs <= startMs && payload.endMs >= endMs);
}

/** "Try again" for face tracking after a failure. */
export async function retryReframe(userId: string, shortId: string): Promise<void> {
  const short = await findOwnedShort(userId, shortId);
  if (await activeJob(short.id, "media.reframe")) return;
  await db.$transaction((tx) => queueReframe(tx, short, short.video.sourcePath));
}

export async function setDefaultCaptionStyle(userId: string, style: CaptionStyle): Promise<void> {
  const json = JSON.stringify(style);
  await db.userSettings.upsert({
    where: { userId },
    create: { userId, captionStyleJson: json },
    update: { captionStyleJson: json },
  });
}

// ---------------------------------------------------------------------------
// Exporting
// ---------------------------------------------------------------------------

/** SHORT-05: queues an export of the current settings. */
export async function startRender(userId: string, shortId: string): Promise<ShortStatusView> {
  const short = await findOwnedShort(userId, shortId);
  const { video } = short;
  if (video.status !== "ready") throw new AppError("VALIDATION", "The video is still being processed.");
  if ((await storageFileSize(video.sourcePath)) === null) {
    throw new AppError("VALIDATION", "The original video file is missing, so this Short can't be exported.");
  }
  if (await activeJob(short.id, "media.render_short")) {
    throw new AppError("CONFLICT", "This Short is already being exported.");
  }

  const doc = docOf(short);
  const reframe = parseJson(reframeDataSchema, short.reframeJson);
  const source = sourceOf(video);
  if (doc.reframeMode === "auto" && needsHorizontalFraming(source.width, source.height)) {
    if (!coversRange(reframe, doc.startMs, doc.endMs)) {
      throw new AppError(
        "VALIDATION",
        short.reframeStatus === "failed"
          ? "Face tracking failed for this Short. Try it again or choose another framing before exporting."
          : "Face tracking is still running. Export when it has finished, or choose another framing.",
      );
    }
  }

  const inputs = renderInputs(doc, reframe, source);
  const outputPath = storagePaths.shortRender(short.id, `render-${Date.now().toString(36)}`);
  await removeOldRenders(short.id, short.outputPath);

  await db.$transaction(async (tx) => {
    await assertNoActiveJob(
      tx,
      { entityType: "short", entityId: short.id, type: "media.render_short" },
      "This Short is already being exported.",
    );
    await tx.short.update({ where: { id: short.id }, data: { status: "rendering", renderError: null } });
    await enqueueJob(
      {
        userId,
        type: "media.render_short",
        entityType: "short",
        entityId: short.id,
        payload: {
          shortId: short.id,
          sourcePath: video.sourcePath,
          outputPath,
          ...inputs,
          signature: signatureOf(inputs),
        },
        // Someone is waiting for this: run it before background transcription.
        priority: 50,
      },
      tx,
    );
  });
  return getShortStatus(userId, shortId);
}

/** Keeps the folder tidy: earlier exports other than the current one are removed before a new export. */
async function removeOldRenders(shortId: string, keep: string | null): Promise<void> {
  const dir = resolveStoragePath(storagePaths.shortDir(shortId));
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const keepName = keep ? path.posix.basename(keep) : null;
  await Promise.all(
    names
      .filter((name) => /^render-[a-z0-9]+(\.partial)?\.mp4$/.test(name) && name !== keepName)
      .map((name) => fs.rm(path.join(dir, name), { force: true })),
  );
}

export async function getShortMediaFile(userId: string, shortId: string) {
  const short = await db.short.findFirst({ where: { id: shortId, userId }, select: { title: true, outputPath: true } });
  if (!short?.outputPath) throw new AppError("NOT_FOUND", "This Short hasn't been exported yet.");
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingStoragePath(short.outputPath);
  } catch {
    throw new AppError("NOT_FOUND", "The exported file is missing. Export the Short again.");
  }
  const stat = await fs.stat(absolutePath);
  const base =
    short.title
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .slice(0, 80) || "short";
  return { absolutePath, size: stat.size, contentType: "video/mp4", downloadName: `${base}.mp4` };
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

export async function deleteShort(userId: string, shortId: string): Promise<void> {
  const short = await db.short.findFirst({ where: { id: shortId, userId }, select: { id: true, title: true } });
  if (!short) throw new AppError("NOT_FOUND", "Short not found.");
  const [sets, thumbnails] = await Promise.all([
    db.packagingSet.findMany({ where: { shortId: short.id }, select: { id: true } }),
    db.thumbnail.findMany({ where: { shortId: short.id }, select: { id: true } }),
  ]);
  await db.$transaction(async (tx) => {
    await cancelJobsForEntity("short", short.id, tx);
    for (const set of sets) await cancelJobsForEntity("packaging", set.id, tx);
    for (const thumbnail of thumbnails) await cancelJobsForEntity("thumbnail", thumbnail.id, tx);
    await tx.short.delete({ where: { id: short.id } }); // packaging and thumbnails go with it (cascade)
  });
  await removeStorageDir(storagePaths.shortDir(short.id));
  await removeThumbnailFiles(thumbnails.map((thumbnail) => thumbnail.id));
  await recordAuditEvent({ action: "short.deleted", userId, details: { shortId: short.id, title: short.title } });
}
