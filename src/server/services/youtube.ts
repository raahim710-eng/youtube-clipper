import "server-only";
import { z } from "zod";
import { ACTIVE_JOB_STATUSES, type PrivacyStatus, type PublicationStatus } from "@/lib/constants";
import { cleanTags, publishProblems, type PublishInput } from "@/lib/youtube/publish";
import { recordAuditEvent } from "../audit";
import { db } from "../db";
import { AppError } from "../errors";
import { cancelJob, enqueueJob, retryJob } from "../jobs/queue";
import { storageFileSize } from "../storage";
import { fetchMyChannels } from "../youtube/client";
import { youtubeConfig } from "../youtube/config";
import { exchangeCode, missingScopes, revokeAndDeleteCredential, storeCredential } from "../youtube/oauth";
import { quotaStatus, type QuotaStatus } from "../youtube/quota";

/**
 * YouTube channels and publishing (YT-01…08). Every query filters by `userId`. Tokens are handled only by
 * src/server/youtube/oauth.ts; nothing here returns them.
 */

export type ChannelView = {
  id: string;
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  status: "active" | "reauth_required" | "revoked";
  scopes: string[];
  connectedAt: string;
};

export type YouTubeSetup = {
  configured: boolean;
  problems: string[];
  audited: boolean;
  usingTestServer: boolean;
};

export function getYouTubeSetup(): YouTubeSetup {
  const result = youtubeConfig();
  return result.ok
    ? { configured: true, problems: [], audited: result.config.audited, usingTestServer: result.config.usingTestServer }
    : { configured: false, problems: result.problems, audited: false, usingTestServer: false };
}

export async function listChannels(userId: string, options: { includeRevoked?: boolean } = {}): Promise<ChannelView[]> {
  const channels = await db.youTubeChannel.findMany({
    where: { userId, ...(options.includeRevoked ? {} : { status: { not: "revoked" } }) },
    orderBy: { connectedAt: "asc" },
  });
  return channels.map((channel) => ({
    id: channel.id,
    youtubeChannelId: channel.youtubeChannelId,
    title: channel.title,
    handle: channel.handle,
    thumbnailUrl: channel.thumbnailUrl,
    status: channel.status as ChannelView["status"],
    scopes: channel.grantedScopes.split(" ").filter(Boolean),
    connectedAt: channel.connectedAt.toISOString(),
  }));
}

/** OAuth callback (YT-01): exchanges the code, checks the granted scopes and stores the channel(s). */
export async function connectChannelsFromCode(userId: string, code: string, verifier: string): Promise<string[]> {
  const tokens = await exchangeCode(code, verifier);
  const missing = missingScopes(tokens.scopes);
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION",
      "Google didn't grant all the permissions the app needs (see your channel and upload videos). Connect again and tick every box.",
    );
  }
  const channels = await fetchMyChannels(tokens.accessToken);
  if (channels.length === 0) {
    throw new AppError(
      "VALIDATION",
      "This Google account has no YouTube channel. Create one on youtube.com, then connect again.",
    );
  }
  const ids: string[] = [];
  for (const channel of channels) {
    const existing = await db.youTubeChannel.findUnique({ where: { youtubeChannelId: channel.youtubeChannelId } });
    if (existing && existing.userId !== userId) {
      throw new AppError("FORBIDDEN", "This channel is already connected to another account in this app.");
    }
    const saved = await db.$transaction(async (tx) => {
      const data = {
        title: channel.title,
        handle: channel.handle,
        thumbnailUrl: channel.thumbnailUrl,
        uploadsPlaylistId: channel.uploadsPlaylistId,
        status: "active",
        grantedScopes: tokens.scopes.join(" "),
      };
      const row = await tx.youTubeChannel.upsert({
        where: { youtubeChannelId: channel.youtubeChannelId },
        create: { userId, youtubeChannelId: channel.youtubeChannelId, ...data },
        update: { ...data, connectedAt: new Date() },
      });
      await storeCredential(tx, row.id, tokens);
      return row;
    });
    ids.push(saved.id);
    await recordAuditEvent({
      action: "youtube.connected",
      userId,
      details: { channelId: saved.id, title: saved.title },
    });
  }
  const settings = await db.userSettings.findUnique({ where: { userId }, select: { defaultChannelId: true } });
  if (!settings?.defaultChannelId && ids[0]) {
    await db.userSettings.upsert({
      where: { userId },
      create: { userId, defaultChannelId: ids[0] },
      update: { defaultChannelId: ids[0] },
    });
  }
  return ids;
}

/** YT-02: revoke at Google, delete the tokens, keep the channel row (as "revoked") for upload history. */
export async function disconnectChannel(userId: string, channelId: string): Promise<{ revoked: boolean }> {
  const channel = await db.youTubeChannel.findFirst({ where: { id: channelId, userId } });
  if (!channel) throw new AppError("NOT_FOUND", "Channel not found.");
  const result = await revokeAndDeleteCredential(channel.id);
  await db.youTubeChannel.update({ where: { id: channel.id }, data: { status: "revoked" } });
  // Uploads waiting for this channel can't run any more.
  const waiting = await db.publication.findMany({
    where: { channelId: channel.id, status: "queued" },
    select: { id: true },
  });
  for (const publication of waiting) {
    const job = await db.job.findFirst({
      where: { entityType: "publication", entityId: publication.id, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true },
    });
    if (job) await cancelJob(userId, job.id).catch(() => undefined);
  }
  await recordAuditEvent({
    action: "youtube.disconnected",
    userId,
    details: { channelId: channel.id, revoked: result.revoked },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

type Target = {
  kind: "video" | "short";
  id: string;
  title: string;
  filePath: string | null;
  fileReady: boolean;
  stale: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Made by the Original Video Generator (directly or as a Short of such a video): its credits text (GEN-06). */
  generated: { credits: string | null } | null;
};

async function loadTarget(userId: string, kind: "video" | "short", id: string): Promise<Target | null> {
  if (kind === "video") {
    const video = await db.video.findFirst({ where: { id, userId } });
    if (!video) return null;
    const ready = video.status === "ready" && (await storageFileSize(video.sourcePath)) !== null;
    return {
      kind,
      id,
      title: video.title,
      filePath: video.sourcePath,
      fileReady: ready,
      stale: false,
      durationMs: video.durationMs,
      width: video.width,
      height: video.height,
      generated: video.sourceType === "generated" ? { credits: video.creditsText } : null,
    };
  }
  const short = await db.short.findFirst({
    where: { id, userId },
    include: { video: { select: { sourceType: true, creditsText: true } } },
  });
  if (!short) return null;
  const ready = Boolean(short.outputPath) && (await storageFileSize(short.outputPath ?? "")) !== null;
  return {
    kind,
    id,
    title: short.title,
    filePath: short.outputPath,
    fileReady: ready,
    stale: false,
    durationMs: short.outputDurationMs,
    width: ready ? 1080 : null,
    height: ready ? 1920 : null,
    generated: short.video.sourceType === "generated" ? { credits: short.video.creditsText } : null,
  };
}

const flaggedListSchema = z.array(z.object({ text: z.string() }));
const hashtagListSchema = z.array(z.object({ tag: z.string(), selected: z.boolean() }));

export type PublishForm = {
  target: Target & { packagingHref: string; editHref: string; sourceExportStale: boolean };
  setup: YouTubeSetup;
  channels: ChannelView[];
  defaultChannelId: string | null;
  prefill: {
    title: string;
    description: string;
    tags: string[];
    fromPackaging: boolean;
    /** Generated videos have a synthetic voice: the disclosure defaults to "yes" (GEN-07). */
    containsSyntheticMedia: boolean | null;
    creditsAdded: boolean;
  };
  thumbnails: { id: string; url: string; selected: boolean; origin: string; width: number; height: number }[];
  quota: QuotaStatus;
};

/** The publish page: the file, the channels, and metadata prefilled from the chosen packaging (Phase 6). */
export async function getPublishForm(userId: string, kind: "video" | "short", id: string): Promise<PublishForm | null> {
  const target = await loadTarget(userId, kind, id);
  if (!target) return null;
  const where = kind === "video" ? { videoId: id } : { shortId: id };
  const [preferred, thumbnails, channels, settings, quota] = await Promise.all([
    db.packagingSet.findFirst({ where: { userId, ...where, preferred: true } }),
    db.thumbnail.findMany({ where: { userId, ...where, status: "ready" }, orderBy: { createdAt: "desc" }, take: 24 }),
    listChannels(userId),
    db.userSettings.findUnique({ where: { userId }, select: { defaultChannelId: true } }),
    quotaStatus(),
  ]);

  let prefill: PublishForm["prefill"] = {
    title: target.title.slice(0, 100),
    description: "",
    tags: [],
    fromPackaging: false,
    containsSyntheticMedia: null,
    creditsAdded: false,
  };
  if (preferred) {
    const titles = flaggedListSchema.catch([]).parse(JSON.parse(preferred.titlesJson));
    const tags = hashtagListSchema
      .catch([])
      .parse(JSON.parse(preferred.hashtagsJson))
      .filter((h) => h.selected)
      .map((h) => h.tag);
    const hashtagLine = tags.map((tag) => `#${tag}`).join(" ");
    prefill = {
      title: titles[preferred.selectedTitle]?.text ?? titles[0]?.text ?? prefill.title,
      description: hashtagLine ? `${preferred.description.trim()}\n\n${hashtagLine}`.trim() : preferred.description,
      tags,
      fromPackaging: true,
      containsSyntheticMedia: null,
      creditsAdded: false,
    };
  }
  if (target.generated) {
    const credits = target.generated.credits?.trim();
    const add = Boolean(credits) && !prefill.description.includes(credits ?? "");
    prefill = {
      ...prefill,
      description: add
        ? `${prefill.description.trim()}

${credits}`.trim()
        : prefill.description,
      containsSyntheticMedia: true,
      creditsAdded: add,
    };
  }
  let sourceExportStale = false;
  if (kind === "short") {
    const { getShortStatus } = await import("./shorts");
    sourceExportStale = (await getShortStatus(userId, id)).render.stale;
  }
  return {
    target: {
      ...target,
      sourceExportStale,
      packagingHref: `/packaging/${kind}/${id}`,
      editHref: kind === "short" ? `/shorts/${id}` : `/videos/${id}`,
    },
    setup: getYouTubeSetup(),
    channels: channels.filter((c) => c.status === "active"),
    defaultChannelId: settings?.defaultChannelId ?? null,
    prefill,
    thumbnails: thumbnails.map((t) => ({
      id: t.id,
      url: `/api/media/thumbnails/${t.id}?v=${t.updatedAt.getTime()}`,
      selected: t.selected,
      origin: t.origin,
      width: t.width,
      height: t.height,
    })),
    quota,
  };
}

/** YT-04/05/08: validates everything, checks the daily upload limit, and queues the upload. */
export async function startPublication(userId: string, input: PublishInput): Promise<string> {
  const setup = getYouTubeSetup();
  if (!setup.configured) throw new AppError("CONFIGURATION", `YouTube isn't set up yet: ${setup.problems.join(" ")}`);
  const target = await loadTarget(userId, input.kind, input.targetId);
  if (!target) throw new AppError("NOT_FOUND", "Not found.");
  const channel = await db.youTubeChannel.findFirst({ where: { id: input.channelId, userId } });
  if (!channel) throw new AppError("NOT_FOUND", "Channel not found.");
  if (channel.status !== "active")
    throw new AppError("VALIDATION", "Reconnect this channel in Settings › Channels first.");

  const problems = publishProblems(input, target, { audited: setup.audited });
  if (problems.length > 0) throw new AppError("VALIDATION", problems.join(" "));
  const quota = await quotaStatus();
  if (quota.uploads.used >= quota.uploads.limit) {
    throw new AppError(
      "CONFLICT",
      `Today's YouTube upload limit (${quota.uploads.limit}) is used up. It resets at midnight Pacific time.`,
    );
  }
  const thumbnail = input.thumbnailId
    ? await db.thumbnail.findFirst({
        where: {
          id: input.thumbnailId,
          userId,
          status: "ready",
          ...(input.kind === "video" ? { videoId: input.targetId } : { shortId: input.targetId }),
        },
      })
    : null;
  if (input.thumbnailId && !thumbnail) throw new AppError("VALIDATION", "That thumbnail isn't available.");
  const active = await db.publication.count({
    where: {
      userId,
      ...(input.kind === "video" ? { videoId: input.targetId } : { shortId: input.targetId }),
      status: { in: ["queued", "uploading"] },
    },
  });
  if (active > 0) throw new AppError("CONFLICT", "This is already being uploaded.");

  const publication = await db.$transaction(async (tx) => {
    // Checked again here, atomically: a double click must not upload the video twice.
    const uploading = await tx.publication.count({
      where: {
        userId,
        ...(input.kind === "video" ? { videoId: input.targetId } : { shortId: input.targetId }),
        status: { in: ["queued", "uploading"] },
      },
    });
    if (uploading > 0) throw new AppError("CONFLICT", "This is already being uploaded.");
    const created = await tx.publication.create({
      data: {
        userId,
        channelId: channel.id,
        ...(input.kind === "video" ? { videoId: input.targetId } : { shortId: input.targetId }),
        thumbnailId: thumbnail?.id ?? null,
        sourceTitle: target.title,
        filePath: target.filePath ?? "",
        title: input.title.trim(),
        description: input.description.replace(/\r\n?/g, "\n"),
        tagsJson: JSON.stringify(cleanTags(input.tags)),
        categoryId: input.categoryId,
        privacyStatus: input.publishAt ? "private" : input.privacyStatus,
        publishAt: input.publishAt ? new Date(input.publishAt) : null,
        madeForKids: input.madeForKids === true,
        containsSyntheticMedia: input.containsSyntheticMedia === true,
      },
    });
    await enqueueJob(
      {
        userId,
        type: "yt.upload",
        entityType: "publication",
        entityId: created.id,
        payload: { publicationId: created.id }, // never tokens (SECURITY.md §3.3)
        priority: 30,
        maxAttempts: 3,
      },
      tx,
    );
    return created;
  });
  await recordAuditEvent({
    action: "youtube.upload_queued",
    userId,
    details: { publicationId: publication.id, channelId: channel.id },
  });
  return publication.id;
}

export type PublicationView = {
  id: string;
  title: string;
  sourceTitle: string;
  kind: "video" | "short" | null;
  targetId: string | null;
  channelTitle: string;
  status: PublicationStatus;
  privacyStatus: PrivacyStatus;
  actualPrivacyStatus: string | null;
  publishAt: string | null;
  progress: number;
  progressMessage: string | null;
  youtubeUrl: string | null;
  studioUrl: string | null;
  error: string | null;
  /** Machine-readable reason, for retry guidance (e.g. QUOTA_EXCEEDED, YOUTUBE_REAUTH). */
  errorCode: string | null;
  warnings: string[];
  jobId: string | null;
  canRetry: boolean;
  canCancel: boolean;
  createdAt: string;
  uploadedAt: string | null;
};

export async function listPublications(
  userId: string,
  options: { limit?: number; scheduledOnly?: boolean } = {},
): Promise<PublicationView[]> {
  const publications = await db.publication.findMany({
    where: { userId, ...(options.scheduledOnly ? { status: "scheduled", publishAt: { gt: new Date() } } : {}) },
    orderBy: options.scheduledOnly ? { publishAt: "asc" } : { createdAt: "desc" },
    take: options.limit ?? 50,
    include: { channel: { select: { title: true } } },
  });
  const jobs = await db.job.findMany({
    where: { entityType: "publication", entityId: { in: publications.map((p) => p.id) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, entityId: true, status: true, progress: true, progressMessage: true, errorCode: true },
  });
  return publications.map((publication) => {
    const job = jobs.find((j) => j.entityId === publication.id) ?? null;
    const active = job ? ACTIVE_JOB_STATUSES.includes(job.status as (typeof ACTIVE_JOB_STATUSES)[number]) : false;
    const status = publication.status as PublicationStatus;
    return {
      id: publication.id,
      title: publication.title,
      sourceTitle: publication.sourceTitle,
      kind: publication.shortId ? "short" : publication.videoId ? "video" : null,
      targetId: publication.shortId ?? publication.videoId,
      channelTitle: publication.channel.title,
      status,
      privacyStatus: publication.privacyStatus as PrivacyStatus,
      actualPrivacyStatus: publication.actualPrivacyStatus,
      publishAt: publication.publishAt?.toISOString() ?? null,
      progress: active ? (job?.progress ?? 0) : publication.uploadProgress,
      progressMessage: active ? (job?.progressMessage ?? null) : null,
      youtubeUrl: publication.youtubeVideoId
        ? publication.shortId
          ? `https://www.youtube.com/shorts/${publication.youtubeVideoId}`
          : `https://www.youtube.com/watch?v=${publication.youtubeVideoId}`
        : null,
      studioUrl: publication.youtubeVideoId
        ? `https://studio.youtube.com/video/${publication.youtubeVideoId}/edit`
        : null,
      error: publication.error,
      errorCode: status === "failed" ? (job?.errorCode ?? null) : null,
      warnings: z.array(z.string()).catch([]).parse(JSON.parse(publication.warningsJson)),
      jobId: job?.id ?? null,
      canRetry: (status === "failed" || status === "cancelled") && Boolean(job),
      canCancel: active,
      createdAt: publication.createdAt.toISOString(),
      uploadedAt: publication.uploadedAt?.toISOString() ?? null,
    };
  });
}

export async function retryPublication(userId: string, publicationId: string): Promise<void> {
  const job = await db.job.findFirst({
    where: { entityType: "publication", entityId: publicationId, userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!job) throw new AppError("NOT_FOUND", "Upload not found.");
  const quota = await quotaStatus();
  if (quota.uploads.used >= quota.uploads.limit) {
    throw new AppError("CONFLICT", "Today's YouTube upload limit is used up. Try again after midnight Pacific time.");
  }
  await retryJob(userId, job.id);
}

export async function cancelPublication(userId: string, publicationId: string): Promise<void> {
  const job = await db.job.findFirst({
    where: { entityType: "publication", entityId: publicationId, userId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true },
  });
  if (!job) throw new AppError("VALIDATION", "This upload isn't running.");
  await cancelJob(userId, job.id);
}

export async function setDefaultChannel(userId: string, channelId: string): Promise<void> {
  const channel = await db.youTubeChannel.findFirst({ where: { id: channelId, userId, status: "active" } });
  if (!channel) throw new AppError("NOT_FOUND", "Channel not found.");
  await db.userSettings.upsert({
    where: { userId },
    create: { userId, defaultChannelId: channel.id },
    update: { defaultChannelId: channel.id },
  });
}
