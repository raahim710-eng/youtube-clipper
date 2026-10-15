import fs from "node:fs/promises";
import path from "node:path";
import { ACTIVE_JOB_STATUSES } from "@/lib/constants";
import { db } from "./db";
import { recoverExpiredLeases } from "./jobs/queue";
import { logger } from "./logger";
import { sweepStaleUploads } from "./services/uploads";
import { getStorageRoot } from "./storage";

/**
 * Housekeeping (Phase 10): removes files nothing refers to any more, so the disk doesn't slowly fill up,
 * and finishes deletions that failed earlier (e.g. a file Windows still had open). Run by the Node worker
 * at start and every MAINTENANCE_INTERVAL_MIN minutes. Shared with the Node worker: no Next.js imports.
 *
 * Safety rules: only files inside STORAGE_DIR; only files older than a grace period (so nothing that is
 * being written right now); never files of a project or video with an active job.
 */

const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = HOUR_MS;
const SEARCH_CACHE_MS = 24 * HOUR_MS;

export type MaintenanceReport = {
  expiredUploads: number;
  recoveredJobs: number;
  removedFiles: number;
  removedFolders: number;
  freedBytes: number;
  failures: number;
};

type Counters = Pick<MaintenanceReport, "removedFiles" | "removedFolders" | "freedBytes" | "failures">;

async function entries(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function sizeOf(target: string): Promise<number> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of await entries(target)) total += await sizeOf(path.join(target, name));
  return total;
}

async function oldEnough(target: string, now: number, ageMs: number): Promise<boolean> {
  const stat = await fs.lstat(target).catch(() => null);
  return Boolean(stat && now - stat.mtimeMs > ageMs);
}

async function remove(target: string, counters: Counters): Promise<void> {
  const bytes = await sizeOf(target);
  const isDir = (await fs.lstat(target).catch(() => null))?.isDirectory() ?? false;
  try {
    // Windows keeps files locked briefly after a process ends; retry a few times.
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    counters.freedBytes += bytes;
    if (isDir) counters.removedFolders += 1;
    else counters.removedFiles += 1;
  } catch (error) {
    counters.failures += 1;
    logger.warn("Maintenance couldn't remove a file (will try again next time)", { target, error });
  }
}

/** `videos/{id}`, `shorts/{id}` and `generator/{id}` folders whose record no longer exists. */
async function removeOrphanFolders(root: string, now: number, counters: Counters) {
  const kinds = [
    { dir: "videos", exists: async (ids: string[]) => db.video.findMany({ where: { id: { in: ids } } }) },
    { dir: "shorts", exists: async (ids: string[]) => db.short.findMany({ where: { id: { in: ids } } }) },
    {
      dir: "generator",
      exists: async (ids: string[]) => db.generatorProject.findMany({ where: { id: { in: ids } } }),
    },
  ];
  // A generator render writes videos/{videoId}/ before the library record exists.
  const rendering = (
    await db.job.findMany({
      where: { type: "gen.render", status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { payloadJson: true },
    })
  ).map((job) => {
    try {
      return String((JSON.parse(job.payloadJson) as { videoId?: unknown }).videoId ?? "");
    } catch {
      return "";
    }
  });
  for (const kind of kinds) {
    const names = await entries(path.join(root, kind.dir));
    if (names.length === 0) continue;
    const known = new Set([...(await kind.exists(names)).map((row) => row.id), ...rendering]);
    for (const name of names) {
      const target = path.join(root, kind.dir, name);
      if (!known.has(name) && (await oldEnough(target, now, GRACE_MS))) await remove(target, counters);
    }
  }
}

/** Thumbnail images whose record is gone, and uploaded originals left by a failed or interrupted check. */
async function removeOrphanThumbnails(root: string, now: number, counters: Counters) {
  const dir = path.join(root, "thumbnails");
  const files = (await entries(dir)).filter((name) => name.endsWith(".jpg"));
  const uploads = (await entries(path.join(dir, "uploads"))).filter((name) => name.endsWith(".upload"));
  const ids = [...files.map((f) => f.slice(0, -4)), ...uploads.map((f) => f.slice(0, -7))];
  if (ids.length === 0) return;
  const rows = await db.thumbnail.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  for (const file of files) {
    const target = path.join(dir, file);
    if (!byId.has(file.slice(0, -4)) && (await oldEnough(target, now, GRACE_MS))) await remove(target, counters);
  }
  for (const file of uploads) {
    // The original upload is only needed while its thumbnail is being made (it may contain EXIF/GPS data).
    const target = path.join(dir, "uploads", file);
    if (byId.get(file.slice(0, -7)) !== "processing" && (await oldEnough(target, now, GRACE_MS))) {
      await remove(target, counters);
    }
  }
}

/** Old narration takes, replaced clips and music of generator projects that aren't busy. */
async function removeUnusedGeneratorFiles(root: string, now: number, counters: Counters) {
  const projects = await db.generatorProject.findMany({
    select: {
      id: true,
      musicPath: true,
      scenes: { select: { audioPath: true, customClipPath: true } },
    },
  });
  if (projects.length === 0) return;
  const busy = new Set(
    (
      await db.job.findMany({
        where: { entityType: "generator", status: { in: [...ACTIVE_JOB_STATUSES] } },
        select: { entityId: true },
      })
    ).map((job) => job.entityId),
  );
  for (const project of projects) {
    if (busy.has(project.id)) continue;
    const used = new Set(
      [project.musicPath, ...project.scenes.flatMap((scene) => [scene.audioPath, scene.customClipPath])]
        .filter((p): p is string => Boolean(p))
        .map((p) => path.resolve(root, p)),
    );
    const base = path.join(root, "generator", project.id);
    const candidates = [
      ...(await entries(path.join(base, "narration"))).map((name) => path.join(base, "narration", name)),
      ...(await entries(path.join(base, "clips"))).map((name) => path.join(base, "clips", name)),
      ...(await entries(base)).filter((name) => name.startsWith("music-")).map((name) => path.join(base, name)),
      path.join(base, "render"),
    ];
    for (const target of candidates) {
      if (!used.has(path.resolve(target)) && (await oldEnough(target, now, GRACE_MS))) await remove(target, counters);
    }
  }
}

/**
 * Stock clips no scene uses any more (after `STOCK_CACHE_DAYS` days unused) and searches older than the
 * 24 hours Pixabay allows them to be cached. A clip a scene still uses is never removed.
 */
async function trimStockCache(root: string, now: number, keepDays: number, counters: Counters) {
  for (const provider of await entries(path.join(root, "stock-cache", "search"))) {
    const dir = path.join(root, "stock-cache", "search", provider);
    for (const file of await entries(dir)) {
      const target = path.join(dir, file);
      if (await oldEnough(target, now, SEARCH_CACHE_MS)) await remove(target, counters);
    }
  }
  for (const provider of ["pexels", "pixabay"]) {
    const dir = path.join(root, "stock-cache", provider);
    const files = await entries(dir);
    if (files.length === 0) continue;
    const assets = await db.stockAsset.findMany({
      where: { provider, filePath: { in: files.map((f) => `stock-cache/${provider}/${f}`) } },
      select: { id: true, filePath: true, _count: { select: { scenes: true } } },
    });
    const byPath = new Map(assets.map((asset) => [asset.filePath, asset]));
    for (const file of files) {
      const target = path.join(dir, file);
      const asset = byPath.get(`stock-cache/${provider}/${file}`);
      if (asset && asset._count.scenes > 0) continue;
      const age = asset ? keepDays * 24 * HOUR_MS : GRACE_MS;
      if (!(await oldEnough(target, now, age))) continue;
      await remove(target, counters);
      if (asset) await db.stockAsset.update({ where: { id: asset.id }, data: { downloadedAt: null } });
    }
  }
}

export async function runMaintenance(
  options: { now?: Date; stockCacheDays?: number; root?: string } = {},
): Promise<MaintenanceReport> {
  const now = options.now ?? new Date();
  const root = options.root ?? getStorageRoot();
  const counters: Counters = { removedFiles: 0, removedFolders: 0, freedBytes: 0, failures: 0 };
  const recoveredJobs = await recoverExpiredLeases(now);
  const { expired } = await sweepStaleUploads(now);
  await removeOrphanFolders(root, now.getTime(), counters);
  await removeOrphanThumbnails(root, now.getTime(), counters);
  await removeUnusedGeneratorFiles(root, now.getTime(), counters);
  await trimStockCache(root, now.getTime(), options.stockCacheDays ?? 14, counters);
  const report = { expiredUploads: expired, recoveredJobs, ...counters };
  if (counters.removedFiles + counters.removedFolders + counters.failures + expired + recoveredJobs > 0) {
    logger.info("Maintenance finished", report);
  }
  return report;
}
