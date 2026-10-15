import "server-only";
import fs from "node:fs/promises";
import { z } from "zod";
import type { PackagingSet, Thumbnail } from "@/generated/prisma/client";
import { ACTIVE_JOB_STATUSES, type PackagingTargetKind, type ThumbnailOrigin } from "@/lib/constants";
import {
  cleanDescription,
  cleanHashtags,
  cleanHeadline,
  cleanTitle,
  HOOK_MAX_CHARS,
  stripAngleBrackets,
} from "@/lib/packaging/limits";
import { captionsSchema } from "@/lib/shorts/captions";
import { db } from "../db";
import { getEnv } from "../env";
import { AppError } from "../errors";
import { cancelJobsForEntity, enqueueJob } from "../jobs/queue";
import { logger } from "../logger";
import { resolveExistingStoragePath, resolveStoragePath, storagePaths } from "../storage";
import { getAiSettings, requireReadyAiProvider } from "./ai-providers";

/**
 * AI packaging (PKG-01…07, TECHNICAL_SPEC.md §7.4) for a library video or a Short. Every query filters by
 * `userId`. Generation runs in the media worker (`ai.package`); thumbnails too (`media.thumbnail_mockup`).
 */

export type PackagingTarget = {
  kind: PackagingTargetKind;
  id: string;
  title: string;
  videoId: string;
  videoTitle: string;
  /** Length of the video, or of the Short. */
  durationMs: number;
  /** Source-video range (a Short's range; the whole video otherwise). */
  startMs: number;
  endMs: number;
  sourceWidth: number;
  sourceHeight: number;
  hasPoster: boolean;
  /** Why packaging can't be generated yet (no transcript, still processing), or null. */
  blockedReason: string | null;
  editHref: string;
  packagingHref: string;
};

type Flagged = { text: string; flags: string[]; edited: boolean };
type Concept = { headline: string; composition: string; emotion: string; frameMs: number | null; flags: string[] };

export type PackagingSetView = {
  id: string;
  status: "processing" | "ready" | "failed";
  error: string | null;
  job: { id: string; status: string; progress: number; message: string | null } | null;
  createdAt: string;
  savedAt: string | null;
  provider: string | null;
  model: string | null;
  inputNotes: string | null;
  titles: Flagged[];
  description: string;
  descriptionEdited: boolean;
  /** Warnings about the AI's description (cleared once the creator edits it). */
  descriptionFlags: string[];
  hashtags: { tag: string; selected: boolean }[];
  hooks: Flagged[];
  concepts: Concept[];
  chapters: { startMs: number; title: string }[];
  warnings: string[];
  selectedTitle: number;
  selectedHook: number;
  preferred: boolean;
};

export type ThumbnailView = {
  id: string;
  origin: ThumbnailOrigin;
  status: "processing" | "ready" | "failed";
  error: string | null;
  url: string | null;
  downloadUrl: string | null;
  width: number;
  height: number;
  sizeBytes: number | null;
  sourceFrameMs: number | null;
  headline: string | null;
  selected: boolean;
  createdAt: string;
};

export type PackagingTargetSummary = {
  kind: PackagingTargetKind;
  id: string;
  title: string;
  videoTitle: string;
  videoId: string;
  hasPoster: boolean;
  durationMs: number;
  sets: number;
  preferredTitle: string | null;
  lastStatus: PackagingSetView["status"] | null;
  updatedAt: string | null;
  packagingHref: string;
};

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function where(kind: PackagingTargetKind, id: string) {
  return kind === "video" ? { videoId: id } : { shortId: id };
}

export async function getPackagingTarget(
  userId: string,
  kind: PackagingTargetKind,
  id: string,
): Promise<PackagingTarget | null> {
  if (kind === "video") {
    const video = await db.video.findFirst({ where: { id, userId }, include: { transcript: true } });
    if (!video) return null;
    return {
      kind,
      id,
      title: video.title,
      videoId: video.id,
      videoTitle: video.title,
      durationMs: video.durationMs ?? 0,
      startMs: 0,
      endMs: video.durationMs ?? 0,
      sourceWidth: video.width ?? 1920,
      sourceHeight: video.height ?? 1080,
      hasPoster: Boolean(video.posterPath),
      blockedReason: transcriptProblem(video.status, video.transcript),
      editHref: `/videos/${video.id}`,
      packagingHref: `/packaging/video/${video.id}`,
    };
  }
  const short = await db.short.findFirst({
    where: { id, userId },
    include: { video: { include: { transcript: true } } },
  });
  if (!short) return null;
  return {
    kind,
    id,
    title: short.title,
    videoId: short.videoId,
    videoTitle: short.video.title,
    durationMs: short.endMs - short.startMs,
    startMs: short.startMs,
    endMs: short.endMs,
    sourceWidth: short.video.width ?? 1920,
    sourceHeight: short.video.height ?? 1080,
    hasPoster: Boolean(short.video.posterPath),
    blockedReason: transcriptProblem(short.video.status, short.video.transcript),
    editHref: `/shorts/${short.id}`,
    packagingHref: `/packaging/short/${short.id}`,
  };
}

function transcriptProblem(
  videoStatus: string,
  transcript: { status: string; filePath: string | null; wordCount: number } | null,
): string | null {
  if (videoStatus !== "ready") return "The video is still being processed.";
  if (!transcript) return "Transcribe the video first — packaging is written from what is said in it.";
  if (transcript.status === "processing") return "The video is still being transcribed.";
  if (transcript.status !== "ready" || !transcript.filePath) {
    return "The transcript failed. Transcribe the video again on its page.";
  }
  if (transcript.wordCount < 5) return "No speech was found in this video, so there's nothing to write packaging from.";
  return null;
}

/** Videos and Shorts for the AI Packaging page, with their latest packaging. */
export async function listPackagingTargets(userId: string): Promise<PackagingTargetSummary[]> {
  const [videos, shorts, sets] = await Promise.all([
    db.video.findMany({ where: { userId, status: "ready" }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.short.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { video: { select: { title: true, posterPath: true } } },
    }),
    db.packagingSet.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        videoId: true,
        shortId: true,
        status: true,
        preferred: true,
        titlesJson: true,
        selectedTitle: true,
        updatedAt: true,
      },
    }),
  ]);
  const byTarget = new Map<string, typeof sets>();
  for (const set of sets) {
    const key = set.videoId ? `video:${set.videoId}` : `short:${set.shortId}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), set]);
  }
  const summary = (kind: PackagingTargetKind, id: string) => {
    const list = byTarget.get(`${kind}:${id}`) ?? [];
    const preferred = list.find((s) => s.preferred);
    const titles = preferred ? parse(titlesSchema, preferred.titlesJson, []) : [];
    return {
      sets: list.length,
      preferredTitle: preferred ? (titles[preferred.selectedTitle]?.text ?? titles[0]?.text ?? null) : null,
      lastStatus: (list[0]?.status as PackagingSetView["status"] | undefined) ?? null,
      updatedAt: list[0]?.updatedAt.toISOString() ?? null,
    };
  };
  return [
    ...shorts.map((short) => ({
      kind: "short" as const,
      id: short.id,
      title: short.title,
      videoTitle: short.video.title,
      videoId: short.videoId,
      hasPoster: Boolean(short.video.posterPath),
      durationMs: short.endMs - short.startMs,
      packagingHref: `/packaging/short/${short.id}`,
      ...summary("short", short.id),
    })),
    ...videos.map((video) => ({
      kind: "video" as const,
      id: video.id,
      title: video.title,
      videoTitle: video.title,
      videoId: video.id,
      hasPoster: Boolean(video.posterPath),
      durationMs: video.durationMs ?? 0,
      packagingHref: `/packaging/video/${video.id}`,
      ...summary("video", video.id),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

const flaggedSchema = z.object({
  text: z.string(),
  flags: z.array(z.string()).default([]),
  edited: z.boolean().default(false),
});
const titlesSchema = z.array(flaggedSchema);
const hashtagsSchema = z.array(z.object({ tag: z.string(), selected: z.boolean() }));
const conceptsSchema = z.array(
  z.object({
    headline: z.string(),
    composition: z.string(),
    emotion: z.string(),
    frameMs: z.number().nullable(),
    flags: z.array(z.string()).default([]),
  }),
);
const chaptersSchema = z.array(z.object({ startMs: z.number(), title: z.string() }));
const generatedSchema = z
  .object({ description: z.string(), descriptionFlags: z.array(z.string()).default([]) })
  .passthrough();

function parse<T>(schema: z.ZodType<T>, json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

function toView(set: PackagingSet, job: PackagingSetView["job"]): PackagingSetView {
  const generated = parse(generatedSchema, set.generatedJson, null);
  return {
    id: set.id,
    status: set.status as PackagingSetView["status"],
    error: set.error,
    job,
    createdAt: set.createdAt.toISOString(),
    savedAt: set.savedAt?.toISOString() ?? null,
    provider: set.provider,
    model: set.model,
    inputNotes: set.inputNotes,
    titles: parse(titlesSchema, set.titlesJson, []),
    description: set.description,
    descriptionEdited: Boolean(generated && generated.description !== set.description),
    descriptionFlags: generated && generated.description === set.description ? generated.descriptionFlags : [],
    hashtags: parse(hashtagsSchema, set.hashtagsJson, []),
    hooks: parse(titlesSchema, set.hooksJson, []),
    concepts: parse(conceptsSchema, set.thumbnailConceptsJson, []),
    chapters: parse(chaptersSchema, set.chaptersJson, []),
    warnings: parse(z.array(z.string()), set.warningsJson, []),
    selectedTitle: set.selectedTitle,
    selectedHook: set.selectedHook,
    preferred: set.preferred,
  };
}

async function jobsFor(setIds: string[]) {
  if (setIds.length === 0) return new Map<string, PackagingSetView["job"]>();
  const jobs = await db.job.findMany({
    where: { entityType: "packaging", entityId: { in: setIds }, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true, status: true, progress: true, progressMessage: true, entityId: true },
  });
  return new Map(
    jobs.map((job) => [
      job.entityId ?? "",
      { id: job.id, status: job.status, progress: job.progress, message: job.progressMessage },
    ]),
  );
}

export async function listPackagingSets(
  userId: string,
  kind: PackagingTargetKind,
  id: string,
): Promise<PackagingSetView[]> {
  const sets = await db.packagingSet.findMany({
    where: { userId, ...where(kind, id) },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const jobs = await jobsFor(sets.map((s) => s.id));
  return sets.map((set) => toView(set, jobs.get(set.id) ?? null));
}

export async function getPackagingSet(userId: string, setId: string): Promise<PackagingSetView> {
  const set = await db.packagingSet.findFirst({ where: { id: setId, userId } });
  if (!set) throw new AppError("NOT_FOUND", "Packaging not found.");
  const jobs = await jobsFor([set.id]);
  return toView(set, jobs.get(set.id) ?? null);
}

export const generateInputSchema = z.object({
  notes: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => value || null),
});

/** PKG-01/04: queues a new packaging set. Earlier sets are kept for comparison. */
export async function startPackaging(
  userId: string,
  kind: PackagingTargetKind,
  id: string,
  notes: string | null,
): Promise<PackagingSetView> {
  const target = await getPackagingTarget(userId, kind, id);
  if (!target) throw new AppError("NOT_FOUND", kind === "video" ? "Video not found." : "Short not found.");
  if (target.blockedReason) throw new AppError("VALIDATION", target.blockedReason);
  const running = await db.packagingSet.count({ where: { userId, ...where(kind, id), status: "processing" } });
  if (running > 0)
    throw new AppError("CONFLICT", "Packaging is already being written for this. Wait for it to finish.");
  const provider = await requireReadyAiProvider(userId, "Packaging");

  const [video, settings] = await Promise.all([
    db.video.findUniqueOrThrow({ where: { id: target.videoId }, include: { transcript: true } }),
    getAiSettings(userId),
  ]);
  let captionText: string | null = null;
  if (kind === "short") {
    const short = await db.short.findUniqueOrThrow({
      where: { id },
      select: { captionsEnabled: true, captionsJson: true },
    });
    const captions = parse(captionsSchema, short.captionsJson, []);
    // The creator's corrected captions are the best text for a Short.
    if (short.captionsEnabled && captions.length > 0)
      captionText = captions
        .map((c) => c.text)
        .join(" ")
        .slice(0, 20_000);
  }
  const combinedNotes =
    [notes, video.notes ? `About the video: ${video.notes}` : null].filter(Boolean).join("\n") || null;

  const set = await db.$transaction(async (tx) => {
    // Checked again here, atomically: a double click must not start two generations.
    if ((await tx.packagingSet.count({ where: { userId, ...where(kind, id), status: "processing" } })) > 0) {
      throw new AppError("CONFLICT", "Packaging is already being written for this. Wait for it to finish.");
    }
    const created = await tx.packagingSet.create({
      data: { userId, ...where(kind, id), status: "processing", inputNotes: notes, provider },
    });
    await enqueueJob(
      {
        userId,
        type: "ai.package",
        entityType: "packaging",
        entityId: created.id,
        priority: 120,
        maxAttempts: 2,
        payload: {
          targetKind: kind,
          targetId: id,
          transcriptPath: video.transcript?.filePath,
          rangeStartMs: kind === "short" ? target.startMs : null,
          rangeEndMs: kind === "short" ? target.endMs : null,
          captionText,
          durationMs: Math.max(1, target.durationMs),
          title: target.title,
          notes: combinedNotes?.slice(0, 2000) ?? null,
          channelStyle: settings.channelStyleNotes,
          provider,
          maxInputWords: getEnv().PACKAGING_MAX_INPUT_WORDS,
        },
      },
      tx,
    );
    return created;
  });
  return getPackagingSet(userId, set.id);
}

export const packagingEditSchema = z.object({
  titles: z.array(z.string().max(300)).max(10),
  description: z.string().max(20_000),
  hashtags: z.array(z.object({ tag: z.string().max(100), selected: z.boolean() })).max(30),
  hooks: z.array(z.string().max(1000)).max(6),
  conceptHeadlines: z.array(z.string().max(200)).max(6),
  selectedTitle: z.number().int().min(0).max(9),
  selectedHook: z.number().int().min(0).max(5),
});
export type PackagingEdit = z.infer<typeof packagingEditSchema>;

/** PKG-05: saves edits to a set. Limits are enforced again; edited items lose the AI's warnings. */
export async function savePackagingEdits(
  userId: string,
  setId: string,
  edit: PackagingEdit,
): Promise<PackagingSetView> {
  const set = await db.packagingSet.findFirst({ where: { id: setId, userId } });
  if (!set) throw new AppError("NOT_FOUND", "Packaging not found.");
  if (set.status !== "ready") throw new AppError("VALIDATION", "This packaging isn't ready to edit.");
  const generated = parse(z.object({ titles: titlesSchema, hooks: titlesSchema }).passthrough(), set.generatedJson, {
    titles: [],
    hooks: [],
  });
  const merge = (values: string[], original: Flagged[], clean: (text: string) => string) =>
    values
      .map(clean)
      .map((text, i) => {
        const before = original[i];
        const unchanged = before && before.text === text;
        return { text, flags: unchanged ? before.flags : [], edited: !unchanged };
      })
      .filter((item) => item.text.length > 0);

  const titles = merge(edit.titles, generated.titles, cleanTitle);
  if (titles.length === 0) throw new AppError("VALIDATION", "Keep at least one title.");
  const hooks = merge(edit.hooks, generated.hooks, (text) =>
    stripAngleBrackets(text).replace(/\s+/g, " ").trim().slice(0, HOOK_MAX_CHARS),
  );
  const selectedTags = new Set(
    cleanHashtags(edit.hashtags.filter((h) => h.selected).map((h) => h.tag)).map((t) => t.toLowerCase()),
  );
  const hashtags = cleanHashtags(edit.hashtags.map((h) => h.tag)).map((tag) => ({
    tag,
    selected: selectedTags.has(tag.toLowerCase()),
  }));
  const concepts = parse(conceptsSchema, set.thumbnailConceptsJson, []).map((concept, i) => {
    const headline = cleanHeadline(edit.conceptHeadlines[i] ?? concept.headline) || concept.headline;
    return headline === concept.headline ? concept : { ...concept, headline, flags: [] };
  });

  const updated = await db.packagingSet.update({
    where: { id: set.id },
    data: {
      titlesJson: JSON.stringify(titles),
      description: cleanDescription(edit.description),
      hashtagsJson: JSON.stringify(hashtags),
      hooksJson: JSON.stringify(hooks),
      thumbnailConceptsJson: JSON.stringify(concepts),
      selectedTitle: Math.min(edit.selectedTitle, titles.length - 1),
      selectedHook: Math.max(0, Math.min(edit.selectedHook, hooks.length - 1)),
      savedAt: new Date(),
    },
  });
  return toView(updated, null);
}

/** "Use this packaging": the creator's saved choice for the video/Short (one per target). */
export async function setPreferredPackaging(userId: string, setId: string): Promise<void> {
  const set = await db.packagingSet.findFirst({ where: { id: setId, userId } });
  if (!set) throw new AppError("NOT_FOUND", "Packaging not found.");
  if (set.status !== "ready") throw new AppError("VALIDATION", "Only finished packaging can be chosen.");
  await db.$transaction([
    db.packagingSet.updateMany({
      where: { userId, ...(set.videoId ? { videoId: set.videoId } : { shortId: set.shortId }), preferred: true },
      data: { preferred: false },
    }),
    db.packagingSet.update({ where: { id: set.id }, data: { preferred: true, savedAt: new Date() } }),
  ]);
}

export async function deletePackagingSet(userId: string, setId: string): Promise<void> {
  const set = await db.packagingSet.findFirst({ where: { id: setId, userId }, select: { id: true } });
  if (!set) throw new AppError("NOT_FOUND", "Packaging not found.");
  await db.$transaction(async (tx) => {
    await cancelJobsForEntity("packaging", set.id, tx);
    await tx.packagingSet.delete({ where: { id: set.id } });
  });
}

// ---------------------------------------------------------------------------
// Thumbnails (PKG-06)
// ---------------------------------------------------------------------------

/** Long-form thumbnails are 1280×720; Shorts are vertical, so their cover images are 720×1280. */
function thumbnailSize(kind: PackagingTargetKind) {
  return kind === "video" ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
}

function thumbnailView(thumbnail: Thumbnail): ThumbnailView {
  const ready = thumbnail.status === "ready" && thumbnail.filePath;
  const version = thumbnail.updatedAt.getTime();
  return {
    id: thumbnail.id,
    origin: thumbnail.origin as ThumbnailOrigin,
    status: thumbnail.status as ThumbnailView["status"],
    error: thumbnail.error,
    url: ready ? `/api/media/thumbnails/${thumbnail.id}?v=${version}` : null,
    downloadUrl: ready ? `/api/media/thumbnails/${thumbnail.id}?download=1` : null,
    width: thumbnail.width,
    height: thumbnail.height,
    sizeBytes: thumbnail.sizeBytes,
    sourceFrameMs: thumbnail.sourceFrameMs,
    headline: thumbnail.headline,
    selected: thumbnail.selected,
    createdAt: thumbnail.createdAt.toISOString(),
  };
}

export async function listThumbnails(userId: string, kind: PackagingTargetKind, id: string): Promise<ThumbnailView[]> {
  const thumbnails = await db.thumbnail.findMany({
    where: { userId, ...where(kind, id) },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  return thumbnails.map(thumbnailView);
}

export const thumbnailRequestSchema = z.object({
  mode: z.enum(["frame", "mockup"]),
  frameMs: z.number().int().nonnegative(),
  headline: z.string().max(200).nullable(),
  packagingSetId: z.string().max(100).nullable(),
});

/** A frame (or a frame with a headline) from the source video, made by the worker. */
export async function requestThumbnail(
  userId: string,
  kind: PackagingTargetKind,
  id: string,
  request: z.infer<typeof thumbnailRequestSchema>,
): Promise<ThumbnailView> {
  const target = await getPackagingTarget(userId, kind, id);
  if (!target) throw new AppError("NOT_FOUND", "Not found.");
  const video = await db.video.findUniqueOrThrow({ where: { id: target.videoId } });
  if (video.status !== "ready") throw new AppError("VALIDATION", "The video is still being processed.");
  const videoEnd = video.durationMs ?? target.endMs;
  const frameMs = Math.min(
    Math.max(request.frameMs, target.startMs),
    Math.max(target.startMs, Math.min(target.endMs, videoEnd) - 100),
  );
  const headline = request.mode === "mockup" ? cleanHeadline(request.headline ?? "") : "";
  if (request.mode === "mockup" && !headline) throw new AppError("VALIDATION", "Write a headline for the mock-up.");
  const setId = request.packagingSetId
    ? ((await db.packagingSet.findFirst({ where: { id: request.packagingSetId, userId }, select: { id: true } }))?.id ??
      null)
    : null;
  const size = thumbnailSize(kind);

  const thumbnail = await db.$transaction(async (tx) => {
    const created = await tx.thumbnail.create({
      data: {
        userId,
        ...where(kind, id),
        packagingSetId: setId,
        origin: request.mode,
        status: "processing",
        ...size,
        sourceFrameMs: frameMs,
        headline: headline || null,
      },
    });
    await enqueueJob(
      {
        userId,
        type: "media.thumbnail_mockup",
        entityType: "thumbnail",
        entityId: created.id,
        priority: 40,
        payload: {
          thumbnailId: created.id,
          mode: request.mode,
          sourcePath: video.sourcePath,
          outputPath: storagePaths.thumbnail(created.id),
          frameMs,
          headline: headline || null,
          ...size,
        },
      },
      tx,
    );
    return created;
  });
  return thumbnailView(thumbnail);
}

export const THUMBNAIL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

function imageKind(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * PKG-06: the creator's own thumbnail. Only JPEG/PNG (checked by content, not by name); the worker decodes it,
 * crops it to the thumbnail shape and re-encodes it as JPEG, which removes metadata. The original isn't kept.
 */
export async function uploadThumbnail(
  userId: string,
  kind: PackagingTargetKind,
  id: string,
  bytes: Uint8Array,
): Promise<ThumbnailView> {
  const target = await getPackagingTarget(userId, kind, id);
  if (!target) throw new AppError("NOT_FOUND", "Not found.");
  if (bytes.length === 0) throw new AppError("VALIDATION", "The file is empty.");
  if (bytes.length > THUMBNAIL_UPLOAD_MAX_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Images can be up to 10 MB.");
  if (!imageKind(bytes)) throw new AppError("VALIDATION", "Only JPEG and PNG images can be used as thumbnails.");
  const size = thumbnailSize(kind);

  const thumbnail = await db.thumbnail.create({
    data: { userId, ...where(kind, id), origin: "upload", status: "processing", ...size },
  });
  const uploadPath = storagePaths.thumbnailUpload(thumbnail.id);
  try {
    const absolute = resolveStoragePath(uploadPath);
    await fs.mkdir(resolveStoragePath("thumbnails/uploads"), { recursive: true });
    await fs.writeFile(absolute, bytes);
    await enqueueJob({
      userId,
      type: "media.thumbnail_mockup",
      entityType: "thumbnail",
      entityId: thumbnail.id,
      priority: 40,
      maxAttempts: 1,
      payload: {
        thumbnailId: thumbnail.id,
        mode: "upload",
        sourcePath: uploadPath,
        outputPath: storagePaths.thumbnail(thumbnail.id),
        frameMs: null,
        headline: null,
        ...size,
      },
    });
  } catch (error) {
    await db.thumbnail.delete({ where: { id: thumbnail.id } }).catch(() => undefined);
    await removeThumbnailFiles([thumbnail.id]); // the original may contain EXIF/GPS data
    throw error;
  }
  return thumbnailView(thumbnail);
}

export async function selectThumbnail(userId: string, thumbnailId: string): Promise<void> {
  const thumbnail = await db.thumbnail.findFirst({ where: { id: thumbnailId, userId } });
  if (!thumbnail) throw new AppError("NOT_FOUND", "Thumbnail not found.");
  if (thumbnail.status !== "ready") throw new AppError("VALIDATION", "This thumbnail isn't ready yet.");
  await db.$transaction([
    db.thumbnail.updateMany({
      where: { userId, ...(thumbnail.videoId ? { videoId: thumbnail.videoId } : { shortId: thumbnail.shortId }) },
      data: { selected: false },
    }),
    db.thumbnail.update({ where: { id: thumbnail.id }, data: { selected: true } }),
  ]);
}

export async function deleteThumbnail(userId: string, thumbnailId: string): Promise<void> {
  const thumbnail = await db.thumbnail.findFirst({ where: { id: thumbnailId, userId } });
  if (!thumbnail) throw new AppError("NOT_FOUND", "Thumbnail not found.");
  await db.$transaction(async (tx) => {
    await cancelJobsForEntity("thumbnail", thumbnail.id, tx);
    await tx.thumbnail.delete({ where: { id: thumbnail.id } });
  });
  await removeThumbnailFiles([thumbnail.id]);
}

/** Removes thumbnail images (and leftover uploads) — used when thumbnails, Shorts or videos are deleted. */
export async function removeThumbnailFiles(ids: string[]): Promise<void> {
  for (const id of ids) {
    for (const relative of [storagePaths.thumbnail(id), storagePaths.thumbnailUpload(id)]) {
      await fs.rm(resolveStoragePath(relative), { force: true }).catch((error: unknown) => {
        logger.warn("Couldn't delete a thumbnail file", { id, error });
      });
    }
  }
}

export async function getThumbnailFile(userId: string, thumbnailId: string) {
  const thumbnail = await db.thumbnail.findFirst({ where: { id: thumbnailId, userId } });
  if (!thumbnail?.filePath || thumbnail.status !== "ready") throw new AppError("NOT_FOUND", "Thumbnail not found.");
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingStoragePath(thumbnail.filePath);
  } catch {
    throw new AppError("NOT_FOUND", "The thumbnail file is missing.");
  }
  const stat = await fs.stat(absolutePath);
  return { absolutePath, size: stat.size, contentType: "image/jpeg", downloadName: `thumbnail-${thumbnail.id}.jpg` };
}
