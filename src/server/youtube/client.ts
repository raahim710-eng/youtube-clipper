import { z } from "zod";
import { googleEndpoints } from "./config";
import { QUOTA_COST, reserveQuota } from "./quota";

/**
 * Minimal YouTube Data API v3 client over fetch (official REST endpoints, D-047). Every call reserves
 * its quota first (YT-07). Access tokens are passed in by the caller and never logged.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

const errorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional(), message: z.string().optional() })).optional(),
  }),
});

/** Plain-language messages for errors the owner can act on. */
const FRIENDLY: Record<string, string> = {
  quotaExceeded:
    "YouTube's daily API quota for this Google Cloud project is used up. Try again after midnight Pacific time.",
  uploadLimitExceeded:
    "YouTube says this channel has reached its upload limit for now. Try again later (often 24 hours).",
  forbidden:
    "YouTube refused the request for this channel. Check that the channel is in good standing and reconnect it.",
  forbiddenPrivacySetting: "YouTube doesn't allow this privacy setting for this upload.",
  invalidPublishAt: "YouTube rejected the scheduled time. It must be in the future.",
  invalidTitle: "YouTube rejected the title.",
  invalidDescription: "YouTube rejected the description.",
  invalidTags: "YouTube rejected the tags (they must total 500 characters or fewer).",
  invalidCategoryId: "YouTube rejected the category.",
  youtubeSignupRequired: "This Google account has no YouTube channel yet. Create one on youtube.com first.",
  authError: "Google no longer accepts this channel's sign-in. Reconnect the channel.",
  invalidImage: "YouTube couldn't use the thumbnail image.",
  uploadRateLimitExceeded: "This channel has set too many thumbnails recently. Try again later.",
};

export async function apiError(response: Response): Promise<YouTubeApiError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(body);
  const reason = parsed.success ? (parsed.data.error.errors?.[0]?.reason ?? "unknown") : "unknown";
  const raw = parsed.success ? (parsed.data.error.message ?? "") : "";
  const friendly = FRIENDLY[reason] ?? (response.status === 401 ? FRIENDLY.authError : null);
  const retryable = response.status >= 500 || response.status === 429;
  return new YouTubeApiError(
    response.status,
    reason,
    friendly ?? `YouTube returned an error (HTTP ${response.status}${raw ? `: ${raw.slice(0, 200)}` : ""}).`,
    retryable,
  );
}

function auth(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const channelsSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({
          title: z.string(),
          customUrl: z.string().optional(),
          thumbnails: z.record(z.string(), z.object({ url: z.string() })).optional(),
        }),
        contentDetails: z.object({ relatedPlaylists: z.object({ uploads: z.string().optional() }) }).optional(),
      }),
    )
    .default([]),
});

export type MyChannel = {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string | null;
};

/** `channels.list?mine=true` — the channel(s) of the Google account that just signed in. */
export async function fetchMyChannels(accessToken: string): Promise<MyChannel[]> {
  await reserveQuota("default", QUOTA_COST["channels.list"]);
  const url = `${googleEndpoints().api}/channels?part=snippet,contentDetails&mine=true&maxResults=50`;
  const response = await fetch(url, { headers: auth(accessToken) });
  if (!response.ok) throw await apiError(response);
  const data = channelsSchema.parse(await response.json());
  return data.items.map((item) => {
    const thumbs = item.snippet.thumbnails ?? {};
    const thumb = thumbs.medium?.url ?? thumbs.default?.url ?? null;
    return {
      youtubeChannelId: item.id,
      title: item.snippet.title.slice(0, 200),
      handle: item.snippet.customUrl ?? null,
      // Only YouTube's own image hosts are shown in the app (CSP and privacy).
      thumbnailUrl: thumb && /^https:\/\/yt\d\.(ggpht|googleusercontent)\.com\//.test(thumb) ? thumb : null,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists.uploads ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Resumable upload (videos.insert)
// ---------------------------------------------------------------------------

export type VideoMetadata = {
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: {
    privacyStatus: "private" | "unlisted" | "public";
    publishAt?: string;
    selfDeclaredMadeForKids: boolean;
    containsSyntheticMedia: boolean;
  };
};

const videoSchema = z.object({
  id: z.string(),
  status: z.object({ privacyStatus: z.string().optional(), publishAt: z.string().optional() }).optional(),
});
export type UploadedVideo = z.infer<typeof videoSchema>;

export type UploadState =
  { kind: "done"; video: UploadedVideo } | { kind: "partial"; received: number } | { kind: "expired" };

/** Step 1: creates a resumable upload session; returns its URI (treat it as a secret). */
export async function startResumableUpload(
  accessToken: string,
  metadata: VideoMetadata,
  size: number,
  contentType: string,
): Promise<string> {
  await reserveQuota("videos.insert", QUOTA_COST["videos.insert"]);
  const url = `${googleEndpoints().upload}/videos?uploadType=resumable&part=snippet,status`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...auth(accessToken),
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": contentType,
    },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) throw await apiError(response);
  const location = response.headers.get("location");
  if (!location)
    throw new YouTubeApiError(response.status, "noSession", "YouTube didn't start the upload. Try again.", true);
  return location;
}

async function uploadState(response: Response): Promise<UploadState> {
  if (response.status === 200 || response.status === 201)
    return { kind: "done", video: videoSchema.parse(await response.json()) };
  if (response.status === 308) {
    const range = response.headers.get("range");
    const match = range?.match(/bytes=0-(\d+)/);
    return { kind: "partial", received: match ? Number(match[1]) + 1 : 0 };
  }
  if (response.status === 404 || response.status === 410) return { kind: "expired" };
  throw await apiError(response);
}

/** After an interruption: how much YouTube already has (never assume, per Google's guide). */
export async function queryUpload(sessionUri: string, accessToken: string, total: number): Promise<UploadState> {
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: { ...auth(accessToken), "Content-Length": "0", "Content-Range": `bytes */${total}` },
  });
  return uploadState(response);
}

/** Step 3: sends bytes [start, start + chunk.length) of `total`. */
export async function uploadChunk(
  sessionUri: string,
  accessToken: string,
  chunk: Uint8Array,
  start: number,
  total: number,
  contentType: string,
  signal?: AbortSignal,
): Promise<UploadState> {
  const response = await fetch(sessionUri, {
    method: "PUT",
    headers: {
      ...auth(accessToken),
      "Content-Type": contentType,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${total}`,
    },
    body: new Uint8Array(chunk),
    signal,
  });
  return uploadState(response);
}

/** `thumbnails.set` (50 units). */
export async function setThumbnail(accessToken: string, videoId: string, jpeg: Uint8Array): Promise<void> {
  await reserveQuota("default", QUOTA_COST["thumbnails.set"]);
  const url = `${googleEndpoints().upload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...auth(accessToken), "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) },
    body: new Uint8Array(jpeg),
  });
  if (!response.ok) throw await apiError(response);
}
