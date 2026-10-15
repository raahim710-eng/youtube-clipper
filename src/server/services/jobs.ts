import "server-only";
import { ACTIVE_JOB_STATUSES, JOB_TYPE_LABELS, type JobType } from "@/lib/constants";
import { db } from "../db";
import { recoverExpiredLeases } from "../jobs/queue";

/** Jobs as shown in the activity drawer and on the dashboard (JOB-02). */
export type JobSummary = {
  id: string;
  type: string;
  label: string;
  status: string;
  progress: number;
  progressMessage: string | null;
  error: string | null;
  entityType: string | null;
  entityId: string | null;
  entityTitle: string | null;
  /** Page of the video or Short the job belongs to. */
  entityHref: string | null;
  createdAt: string;
  finishedAt: string | null;
};

let lastRecovery = 0;

export async function listJobs(userId: string, options: { activeOnly?: boolean; limit?: number } = {}) {
  // Workers recover jobs whose worker vanished; when no worker runs at all, the activity list does it
  // (at most every 30 s), so a dead job doesn't show "running" forever and can be cancelled.
  if (Date.now() - lastRecovery > 30_000) {
    lastRecovery = Date.now();
    await recoverExpiredLeases().catch(() => undefined);
  }
  const jobs = await db.job.findMany({
    where: { userId, ...(options.activeOnly ? { status: { in: [...ACTIVE_JOB_STATUSES] } } : {}) },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 20,
  });

  const idsOf = (type: string) =>
    jobs.flatMap((job) => (job.entityType === type && job.entityId ? [job.entityId] : []));
  const target = { select: { id: true, title: true } } as const;
  const [videos, shorts, sets, thumbnails, publications] = await Promise.all([
    db.video.findMany({ where: { id: { in: idsOf("video") }, userId }, select: { id: true, title: true } }),
    db.short.findMany({ where: { id: { in: idsOf("short") }, userId }, select: { id: true, title: true } }),
    db.packagingSet.findMany({
      where: { id: { in: idsOf("packaging") }, userId },
      select: { id: true, video: target, short: target },
    }),
    db.thumbnail.findMany({
      where: { id: { in: idsOf("thumbnail") }, userId },
      select: { id: true, video: target, short: target },
    }),
    db.publication.findMany({ where: { id: { in: idsOf("publication") }, userId }, select: { id: true, title: true } }),
  ]);
  // entity key → [title, link]
  const links = new Map<string, [string, string]>();
  for (const video of videos) links.set(`video:${video.id}`, [video.title, `/videos/${video.id}`]);
  for (const short of shorts) links.set(`short:${short.id}`, [short.title, `/shorts/${short.id}`]);
  for (const publication of publications) links.set(`publication:${publication.id}`, [publication.title, "/youtube"]);
  for (const [type, items] of [
    ["packaging", sets],
    ["thumbnail", thumbnails],
  ] as const) {
    for (const item of items) {
      if (item.video) links.set(`${type}:${item.id}`, [item.video.title, `/packaging/video/${item.video.id}`]);
      else if (item.short) links.set(`${type}:${item.id}`, [item.short.title, `/packaging/short/${item.short.id}`]);
    }
  }

  return jobs.map((job): JobSummary => ({
    id: job.id,
    type: job.type,
    label: JOB_TYPE_LABELS[job.type as JobType] ?? job.type,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    error: job.error,
    entityType: job.entityType,
    entityId: job.entityId,
    entityTitle: links.get(`${job.entityType}:${job.entityId}`)?.[0] ?? null,
    entityHref: links.get(`${job.entityType}:${job.entityId}`)?.[1] ?? null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  }));
}

export async function countActiveJobs(userId: string): Promise<number> {
  return db.job.count({ where: { userId, status: { in: [...ACTIVE_JOB_STATUSES] } } });
}

/** A worker that hasn't checked in for this long is treated as stopped (it checks in every 15 s). */
export const WORKER_OFFLINE_AFTER_MS = 45_000;

/** Most recent heartbeat from a Python media worker, used to explain stuck processing. */
export async function getMediaWorkerState(): Promise<{ online: boolean; lastSeenAt: string | null }> {
  const latest = await db.workerHeartbeat.findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } });
  if (!latest) return { online: false, lastSeenAt: null };
  return {
    online: Date.now() - latest.lastSeenAt.getTime() < WORKER_OFFLINE_AFTER_MS,
    lastSeenAt: latest.lastSeenAt.toISOString(),
  };
}
