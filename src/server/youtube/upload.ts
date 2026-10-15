import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../crypto";
import { db } from "../db";
import { getEnv } from "../env";
import { logger } from "../logger";
import { resolveExistingStoragePath } from "../storage";
import {
  queryUpload,
  setThumbnail,
  startResumableUpload,
  type UploadState,
  uploadChunk,
  type VideoMetadata,
  YouTubeApiError,
} from "./client";
import { getAccessToken, ReauthRequiredError } from "./oauth";
import { QuotaExceededError } from "./quota";

/**
 * The `yt.upload` job (YT-04…06), run by the Node integration worker (src/worker). Google's resumable
 * upload protocol: create a session, send the file in chunks, and after any interruption ask YouTube how
 * much it has before continuing. The session URI is stored encrypted, so a retried job resumes too.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

export class UploadFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadFailure";
  }
}

export class UploadCancelled extends Error {}

export const ytUploadResultSchema = z.object({
  youtubeVideoId: z.string().min(1).max(64),
  privacyStatus: z.string().max(20).nullable(),
  publishAt: z.string().max(40).nullable(),
  thumbnailSet: z.boolean(),
  warnings: z.array(z.string().max(400)).max(5),
});
export type YtUploadResult = z.infer<typeof ytUploadResultSchema>;

/** Reports progress (0–1) and returns true when the user asked to cancel. */
export type ProgressReporter = (fraction: number, message: string) => Promise<boolean>;

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};
const MAX_NETWORK_RETRIES = 6;

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /fetch failed|ECONNRESET|socket|network|aborted/i.test(error.message))
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns errors into a failure the job queue understands (code, user message, retryable). */
export function toUploadFailure(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) return error;
  if (error instanceof ReauthRequiredError) return new UploadFailure("YOUTUBE_REAUTH", error.message, false);
  if (error instanceof QuotaExceededError) return new UploadFailure("QUOTA_EXCEEDED", error.message, false);
  if (error instanceof YouTubeApiError) {
    if (error.status === 401) return new UploadFailure("YOUTUBE_REAUTH", error.message, false);
    return new UploadFailure(`YOUTUBE_${error.reason}`.slice(0, 50), error.message, error.retryable);
  }
  if (isNetworkError(error)) {
    return new UploadFailure(
      "NETWORK",
      "The connection to YouTube dropped repeatedly. Try again — the upload resumes where it stopped.",
      true,
    );
  }
  logger.error("Unexpected YouTube upload error", { error });
  return new UploadFailure("UPLOAD_ERROR", "The upload failed unexpectedly. Try again.", true);
}

export async function runYouTubeUpload(publicationId: string, report: ProgressReporter): Promise<YtUploadResult> {
  const publication = await db.publication.findUnique({
    where: { id: publicationId },
    include: { channel: true, thumbnail: true },
  });
  if (!publication) throw new UploadFailure("NOT_FOUND", "This upload was deleted.", false);
  if (publication.channel.status === "revoked") {
    throw new UploadFailure("YOUTUBE_REAUTH", "The channel was disconnected. Connect it again, then retry.", false);
  }

  let absolute: string;
  try {
    absolute = await resolveExistingStoragePath(publication.filePath);
  } catch {
    throw new UploadFailure("SOURCE_MISSING", "The video file to upload is missing. Export or upload it again.", false);
  }
  const total = (await fs.stat(absolute)).size;
  const contentType = CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream";
  const token = () => getAccessToken(publication.channelId);

  const metadata: VideoMetadata = {
    snippet: {
      title: publication.title,
      description: publication.description,
      tags: z.array(z.string()).catch([]).parse(JSON.parse(publication.tagsJson)),
      categoryId: publication.categoryId,
    },
    status: {
      // publishAt only works together with private (YouTube Data API: status.publishAt).
      privacyStatus: publication.publishAt
        ? "private"
        : (publication.privacyStatus as VideoMetadata["status"]["privacyStatus"]),
      ...(publication.publishAt ? { publishAt: publication.publishAt.toISOString() } : {}),
      selfDeclaredMadeForKids: publication.madeForKids,
      containsSyntheticMedia: publication.containsSyntheticMedia,
    },
  };

  const newSession = async (): Promise<string> => {
    await report(0, "Starting the upload");
    const uri = await startResumableUpload(await token(), metadata, total, contentType);
    await db.publication.update({
      where: { id: publicationId },
      data: { uploadSessionEnc: encryptSecret(uri), bytesUploaded: BigInt(0), status: "uploading", error: null },
    });
    return uri;
  };

  let sessionUri: string;
  let state: UploadState = { kind: "partial", received: 0 };
  if (publication.uploadSessionEnc) {
    sessionUri = decryptSecret(publication.uploadSessionEnc);
    state = await queryUpload(sessionUri, await token(), total);
    if (state.kind === "expired") {
      sessionUri = await newSession();
      state = { kind: "partial", received: 0 };
    }
  } else {
    sessionUri = await newSession();
  }
  await db.publication.update({ where: { id: publicationId }, data: { status: "uploading" } });

  const chunkSize = getEnv().YOUTUBE_UPLOAD_CHUNK_KB * 1024;
  const file = await fs.open(absolute, "r");
  let failures = 0;
  try {
    while (state.kind === "partial") {
      const start = state.received;
      if (await report(start / total, `Uploading (${Math.round((start / total) * 100)}%)`)) throw new UploadCancelled();
      const length = Math.min(chunkSize, total - start);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      try {
        state = await uploadChunk(sessionUri, await token(), buffer, start, total, contentType);
        failures = 0;
      } catch (error) {
        const transient = isNetworkError(error) || (error instanceof YouTubeApiError && error.retryable);
        if (!transient || failures >= MAX_NETWORK_RETRIES) throw error;
        failures += 1;
        logger.warn("YouTube upload interrupted; checking what arrived before resuming", {
          publicationId,
          attempt: failures,
        });
        await wait(Math.min(30_000, 1000 * 2 ** (failures - 1)));
        // Never assume how much arrived: ask YouTube (Google's resumable upload guide).
        state = await queryUpload(sessionUri, await token(), total);
        if (state.kind === "expired") {
          sessionUri = await newSession();
          state = { kind: "partial", received: 0 };
        }
      }
      if (state.kind === "partial") {
        await db.publication.update({
          where: { id: publicationId },
          data: { bytesUploaded: BigInt(state.received), uploadProgress: Math.floor((state.received / total) * 100) },
        });
      }
    }
  } finally {
    await file.close();
  }
  if (state.kind !== "done")
    throw new UploadFailure("UPLOAD_ERROR", "YouTube ended the upload unexpectedly. Try again.", true);
  const video = state.video;

  const warnings: string[] = [];
  let thumbnailSet = false;
  if (publication.thumbnail?.filePath && publication.thumbnail.status === "ready") {
    await report(0.99, "Setting the thumbnail");
    try {
      const jpeg = await fs.readFile(await resolveExistingStoragePath(publication.thumbnail.filePath));
      await setThumbnail(await token(), video.id, jpeg);
      thumbnailSet = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      warnings.push(
        `The video was uploaded, but the thumbnail couldn't be set: ${reason} Custom thumbnails need a verified channel (youtube.com/verify).`.slice(
          0,
          400,
        ),
      );
    }
  }
  const actual = video.status?.privacyStatus ?? null;
  if (actual && actual !== metadata.status.privacyStatus) {
    warnings.push(`YouTube set the video to "${actual}" instead of "${metadata.status.privacyStatus}".`);
  }
  return {
    youtubeVideoId: video.id,
    privacyStatus: actual,
    publishAt: video.status?.publishAt ?? metadata.status.publishAt ?? null,
    thumbnailSet,
    warnings,
  };
}
