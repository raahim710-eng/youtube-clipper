import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { type VideoStatus, videoStatusSchema } from "@/lib/constants";
import { recordAuditEvent } from "../audit";
import { db } from "../db";
import { AppError } from "../errors";
import { cancelJobsForEntity, retryJob } from "../jobs/queue";
import { removeStorageDir, resolveExistingStoragePath, storageFileSize, storagePaths } from "../storage";
import { removeThumbnailFiles } from "./packaging";

/**
 * Library videos (LIB-03…07). Every query filters by `userId`, so one user can never
 * read or change another user's videos, even by guessing an ID.
 */

export type VideoSummary = {
  id: string;
  title: string;
  status: VideoStatus;
  errorMessage: string | null;
  originalFilename: string;
  container: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hasPoster: boolean;
  /** Made by the Original Video Generator (GEN-06). */
  generated: boolean;
  createdAt: string;
};

export type VideoDetail = VideoSummary & {
  notes: string | null;
  /** Generated videos: credits for the description (GEN-06). */
  creditsText: string | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasPreview: boolean;
  /** False when the original file was removed (e.g. it turned out not to be a video). */
  sourceAvailable: boolean;
  processedAt: string | null;
  job: { id: string; status: string; progress: number; progressMessage: string | null; error: string | null } | null;
};

type VideoRow = Prisma.VideoGetPayload<object>;

function toSummary(video: VideoRow): VideoSummary {
  return {
    id: video.id,
    title: video.title,
    status: videoStatusSchema.catch("failed").parse(video.status),
    errorMessage: video.errorMessage,
    originalFilename: video.originalFilename,
    container: video.container,
    sizeBytes: Number(video.sizeBytes),
    durationMs: video.durationMs,
    width: video.width,
    height: video.height,
    hasPoster: Boolean(video.posterPath),
    generated: video.sourceType === "generated",
    createdAt: video.createdAt.toISOString(),
  };
}

export const LIBRARY_SORTS = ["newest", "oldest", "title", "longest", "largest"] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export const libraryQuerySchema = z.object({
  q: z.string().trim().max(100).catch(""),
  sort: z.enum(LIBRARY_SORTS).catch("newest"),
  status: z.enum(["all", ...["processing", "ready", "failed"]] as const).catch("all"),
});
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;

const ORDER: Record<LibrarySort, Prisma.VideoOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }],
  oldest: [{ createdAt: "asc" }],
  title: [{ title: "asc" }],
  longest: [{ durationMs: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  largest: [{ sizeBytes: "desc" }],
};

export async function listVideos(userId: string, query: LibraryQuery): Promise<VideoSummary[]> {
  const videos = await db.video.findMany({
    where: {
      userId,
      ...(query.status !== "all" ? { status: query.status } : {}),
      ...(query.q ? { title: { contains: query.q } } : {}),
    },
    orderBy: ORDER[query.sort],
    take: 500,
  });
  return videos.map(toSummary);
}

export async function getLibraryStats(userId: string) {
  const [count, bytes, processing] = await Promise.all([
    db.video.count({ where: { userId } }),
    db.video.aggregate({ where: { userId }, _sum: { sizeBytes: true } }),
    db.video.count({ where: { userId, status: "processing" } }),
  ]);
  return { count, totalBytes: Number(bytes._sum.sizeBytes ?? 0), processing };
}

export async function getVideo(userId: string, videoId: string): Promise<VideoDetail | null> {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) return null;
  const job = await db.job.findFirst({
    where: { entityType: "video", entityId: video.id, userId, type: "media.ingest" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, progress: true, progressMessage: true, error: true },
  });
  return {
    ...toSummary(video),
    notes: video.notes,
    creditsText: video.creditsText,
    fps: video.fps,
    videoCodec: video.videoCodec,
    audioCodec: video.audioCodec,
    hasPreview: Boolean(video.previewPath),
    sourceAvailable: (await storageFileSize(video.sourcePath)) !== null,
    processedAt: video.processedAt?.toISOString() ?? null,
    job,
  };
}

export const videoDetailsSchema = z.object({
  title: z.string().trim().min(1, "Enter a title.").max(200, "Use at most 200 characters."),
  notes: z
    .string()
    .trim()
    .max(5000, "Use at most 5,000 characters.")
    .transform((value) => value || null),
});

export async function updateVideoDetails(
  userId: string,
  videoId: string,
  details: z.infer<typeof videoDetailsSchema>,
): Promise<void> {
  const { count } = await db.video.updateMany({ where: { id: videoId, userId }, data: details });
  if (count === 0) throw new AppError("NOT_FOUND", "Video not found.");
}

/** LIB-06: removes the record, its files, its Shorts and pending jobs. Videos already on YouTube are untouched. */
export async function deleteVideo(userId: string, videoId: string): Promise<void> {
  const video = await db.video.findFirst({ where: { id: videoId, userId }, select: { id: true, title: true } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");
  const shorts = await db.short.findMany({ where: { videoId: video.id }, select: { id: true } });
  const shortIds = shorts.map((short) => short.id);
  const [sets, thumbnails] = await Promise.all([
    db.packagingSet.findMany({
      where: { OR: [{ videoId: video.id }, { shortId: { in: shortIds } }] },
      select: { id: true },
    }),
    db.thumbnail.findMany({
      where: { OR: [{ videoId: video.id }, { shortId: { in: shortIds } }] },
      select: { id: true },
    }),
  ]);
  await db.$transaction(async (tx) => {
    await cancelJobsForEntity("video", video.id, tx);
    for (const short of shorts) await cancelJobsForEntity("short", short.id, tx);
    for (const set of sets) await cancelJobsForEntity("packaging", set.id, tx);
    for (const thumbnail of thumbnails) await cancelJobsForEntity("thumbnail", thumbnail.id, tx);
    await tx.video.delete({ where: { id: video.id } }); // Shorts and clips are deleted with it (cascade)
  });
  await removeStorageDir(storagePaths.videoDir(video.id));
  for (const short of shorts) await removeStorageDir(storagePaths.shortDir(short.id));
  await removeThumbnailFiles(thumbnails.map((thumbnail) => thumbnail.id));
  await recordAuditEvent({ action: "video.deleted", userId, details: { videoId: video.id, title: video.title } });
}

/** Processing failed (e.g. worker or FFmpeg was missing) — try again with the same file. */
export async function retryVideoProcessing(userId: string, videoId: string): Promise<void> {
  const video = await db.video.findFirst({ where: { id: videoId, userId }, select: { id: true, status: true } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");
  if (video.status !== "failed") throw new AppError("VALIDATION", "Only videos that failed processing can be retried.");
  const job = await db.job.findFirst({
    where: { entityType: "video", entityId: video.id, userId, type: "media.ingest" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!job) throw new AppError("NOT_FOUND", "No processing job found for this video.");
  await retryJob(userId, job.id);
}

export const MEDIA_VARIANTS = ["source", "preview", "poster", "playback"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
};

export type MediaFile = {
  absolutePath: string;
  size: number;
  contentType: string;
  downloadName: string;
};

/**
 * Resolves a video file the user may access. "playback" picks the browser-friendly
 * preview when one exists, otherwise the original.
 */
export async function getVideoMediaFile(userId: string, videoId: string, variant: MediaVariant): Promise<MediaFile> {
  const video = await db.video.findFirst({ where: { id: videoId, userId } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");

  const relative =
    variant === "poster"
      ? video.posterPath
      : variant === "preview"
        ? video.previewPath
        : variant === "playback"
          ? (video.previewPath ?? video.sourcePath)
          : video.sourcePath;
  if (!relative) throw new AppError("NOT_FOUND", "This file isn't available.");

  let absolutePath: string;
  try {
    absolutePath = await resolveExistingStoragePath(relative);
  } catch {
    throw new AppError("NOT_FOUND", "This file isn't available.");
  }
  const stat = await fs.stat(absolutePath);
  const extension = path.extname(relative).slice(1).toLowerCase();
  const base =
    video.title
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .slice(0, 80) || "video";
  return {
    absolutePath,
    size: stat.size,
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    downloadName: `${base}.${extension}`,
  };
}
