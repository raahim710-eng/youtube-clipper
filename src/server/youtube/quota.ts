import type { Prisma } from "@/generated/prisma/client";
import { db } from "../db";
import { getEnv } from "../env";

/**
 * YouTube Data API quota guard (YT-07). Google's limits per project and day (reset at midnight Pacific time):
 * 10,000 units shared by most methods, and a separate bucket of 100 `videos.insert` calls. Every call is
 * reserved here first; when a bucket is used up the action is refused with the reset time.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

export type QuotaBucket = "default" | "videos.insert";

/** Unit costs from Google's quota table (determine_quota_cost). */
export const QUOTA_COST = {
  "channels.list": 1,
  "videos.list": 1,
  "videos.insert": 1, // in its own bucket
  "thumbnails.set": 50,
} as const;

const PACIFIC = "America/Los_Angeles";

function pacificParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The Google quota day, YYYY-MM-DD in Pacific time. */
export function quotaDay(now = new Date()): string {
  const { year, month, day } = pacificParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** When the current quota day ends (next midnight Pacific time). */
export function nextQuotaReset(now = new Date()): Date {
  const { hour, minute, second } = pacificParts(now);
  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000 + now.getMilliseconds();
  return new Date(now.getTime() + 24 * 3600 * 1000 - elapsed);
}

export function quotaLimit(bucket: QuotaBucket): number {
  const env = getEnv();
  return bucket === "videos.insert" ? env.YOUTUBE_DAILY_UPLOADS : env.YOUTUBE_DAILY_UNITS;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly bucket: QuotaBucket,
    readonly resetsAt: Date,
  ) {
    super(
      bucket === "videos.insert"
        ? `The daily YouTube upload limit (${quotaLimit(bucket)} uploads) is used up. It resets at midnight Pacific time (${resetsAt.toISOString()}).`
        : `The daily YouTube API quota (${quotaLimit(bucket)} units) is used up. It resets at midnight Pacific time (${resetsAt.toISOString()}).`,
    );
    this.name = "QuotaExceededError";
  }
}

/** Reserves `units` in a bucket for today, or throws QuotaExceededError without changing anything. */
export async function reserveQuota(
  bucket: QuotaBucket,
  units: number,
  now = new Date(),
  tx: Prisma.TransactionClient = db,
) {
  const projectDate = quotaDay(now);
  const limit = quotaLimit(bucket);
  await tx.apiQuotaUsage.upsert({
    where: { projectDate_bucket: { projectDate, bucket } },
    create: { projectDate, bucket, units: 0 },
    update: {},
  });
  // Conditional increment: only succeeds while there is room (no read-then-write race).
  const { count } = await tx.apiQuotaUsage.updateMany({
    where: { projectDate, bucket, units: { lte: limit - units } },
    data: { units: { increment: units } },
  });
  if (count === 0) throw new QuotaExceededError(bucket, nextQuotaReset(now));
}

export type QuotaStatus = {
  day: string;
  resetsAt: string;
  units: { used: number; limit: number };
  uploads: { used: number; limit: number };
};

export async function quotaStatus(now = new Date()): Promise<QuotaStatus> {
  const projectDate = quotaDay(now);
  const rows = await db.apiQuotaUsage.findMany({ where: { projectDate } });
  const used = (bucket: QuotaBucket) => rows.find((row) => row.bucket === bucket)?.units ?? 0;
  return {
    day: projectDate,
    resetsAt: nextQuotaReset(now).toISOString(),
    units: { used: used("default"), limit: quotaLimit("default") },
    uploads: { used: used("videos.insert"), limit: quotaLimit("videos.insert") },
  };
}
