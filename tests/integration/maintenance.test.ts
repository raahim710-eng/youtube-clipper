import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { runMaintenance } from "@/server/maintenance";
import { getStorageRoot, resolveStoragePath } from "@/server/storage";
import { createTestUser } from "../support/fixtures";

let user: Awaited<ReturnType<typeof createTestUser>>;
const DAY = 24 * 60 * 60 * 1000;

/** Writes a file and backdates it, as if it had been there for `ageMs`. */
function file(relative: string, ageMs = 2 * 60 * 60 * 1000, bytes = 1000) {
  const target = resolveStoragePath(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes));
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(target, time, time);
  fs.utimesSync(path.dirname(target), time, time);
  return target;
}

const exists = (relative: string) => fs.existsSync(resolveStoragePath(relative));

beforeAll(async () => {
  user = await createTestUser("maintenance");
});

beforeEach(async () => {
  await db.job.deleteMany();
  await db.generatorProject.deleteMany();
  await db.stockAsset.deleteMany();
  for (const dir of ["videos", "shorts", "generator", "stock-cache", "thumbnails"]) {
    fs.rmSync(path.join(getStorageRoot(), dir), { recursive: true, force: true });
  }
});

describe("maintenance (Phase 10)", () => {
  it("removes folders whose record is gone, but not new ones or ones a render is writing", async () => {
    const video = await db.video.create({
      data: {
        userId: user.id,
        title: "Kept",
        originalFilename: "k.mp4",
        sourcePath: "x",
        sizeBytes: BigInt(1),
        container: "mp4",
      },
    });
    file(`videos/${video.id}/source.mp4`);
    file("videos/deleted-video/source.mp4");
    file("videos/just-uploaded/source.mp4", 60_000);
    file("shorts/deleted-short/render-a.mp4");
    file("videos/being-rendered/source.partial.mp4");
    await db.job.create({
      data: {
        userId: user.id,
        type: "gen.render",
        status: "running",
        payloadJson: JSON.stringify({ videoId: "being-rendered" }),
      },
    });

    const report = await runMaintenance();
    expect(exists(`videos/${video.id}/source.mp4`)).toBe(true);
    expect(exists("videos/deleted-video")).toBe(false);
    expect(exists("shorts/deleted-short")).toBe(false);
    expect(exists("videos/just-uploaded")).toBe(true); // within the grace period
    expect(exists("videos/being-rendered")).toBe(true);
    expect(report.removedFolders).toBe(2);
    expect(report.freedBytes).toBe(2000);
    await db.video.delete({ where: { id: video.id } });
  });

  it("removes old narration takes and replaced clips, but nothing of a busy project", async () => {
    const project = await db.generatorProject.create({
      data: { userId: user.id, topic: "t", niche: "science", tone: "calm", targetDurationSec: 30, aspectRatio: "9:16" },
    });
    const p = `generator/${project.id}`;
    await db.generatorScene.create({
      data: {
        projectId: project.id,
        order: 0,
        narration: "n",
        visualQuery: "q",
        audioPath: `${p}/narration/s1-new.wav`,
        customClipPath: `${p}/clips/s1-new.mp4`,
      },
    });
    for (const f of [
      "narration/s1-new.wav",
      "narration/s1-old.wav",
      "clips/s1-new.mp4",
      "clips/s1-old.mp4",
      "music-old.mp3",
    ]) {
      file(`${p}/${f}`);
    }
    const busy = await db.job.create({
      data: {
        userId: user.id,
        type: "gen.narrate",
        status: "running",
        payloadJson: "{}",
        entityType: "generator",
        entityId: project.id,
      },
    });
    await runMaintenance();
    expect(exists(`${p}/narration/s1-old.wav`)).toBe(true); // busy: untouched

    await db.job.delete({ where: { id: busy.id } });
    await runMaintenance();
    expect(exists(`${p}/narration/s1-new.wav`)).toBe(true);
    expect(exists(`${p}/clips/s1-new.mp4`)).toBe(true);
    expect(exists(`${p}/narration/s1-old.wav`)).toBe(false);
    expect(exists(`${p}/clips/s1-old.mp4`)).toBe(false);
    expect(exists(`${p}/music-old.mp3`)).toBe(false);
  });

  it("trims the stock cache: old searches and long-unused clips go, clips in use stay", async () => {
    const project = await db.generatorProject.create({
      data: { userId: user.id, topic: "t", niche: "science", tone: "calm", targetDurationSec: 30, aspectRatio: "9:16" },
    });
    const asset = (id: string) =>
      db.stockAsset.create({
        data: {
          provider: "pexels",
          providerAssetId: id,
          pageUrl: `https://www.pexels.com/video/${id}/`,
          creatorName: "c",
          downloadUrl: `https://videos.pexels.com/${id}.mp4`,
          filePath: `stock-cache/pexels/${id}.mp4`,
          width: 720,
          height: 1280,
          durationMs: 5000,
          licenseName: "Pexels License",
          downloadedAt: new Date(),
        },
      });
    const used = await asset("1");
    const unused = await asset("2");
    await db.generatorScene.create({
      data: {
        projectId: project.id,
        order: 0,
        narration: "n",
        visualQuery: "q",
        footageSource: "stock",
        stockAssetId: used.id,
      },
    });
    file("stock-cache/pexels/1.mp4", 30 * DAY);
    file("stock-cache/pexels/2.mp4", 30 * DAY);
    file("stock-cache/pexels/3.mp4", 3 * DAY); // no record at all
    file("stock-cache/search/pexels/old.json", 2 * DAY);
    file("stock-cache/search/pexels/fresh.json", 60_000);

    await runMaintenance({ stockCacheDays: 14 });
    expect(exists("stock-cache/pexels/1.mp4")).toBe(true);
    expect(exists("stock-cache/pexels/2.mp4")).toBe(false);
    expect(exists("stock-cache/pexels/3.mp4")).toBe(false);
    expect(exists("stock-cache/search/pexels/old.json")).toBe(false);
    expect(exists("stock-cache/search/pexels/fresh.json")).toBe(true);
    expect((await db.stockAsset.findUniqueOrThrow({ where: { id: unused.id } })).downloadedAt).toBeNull();
  });

  it("removes uploaded thumbnail originals that are no longer being processed", async () => {
    const failed = await db.thumbnail.create({
      data: { userId: user.id, origin: "upload", status: "failed", width: 1280, height: 720 },
    });
    const working = await db.thumbnail.create({
      data: { userId: user.id, origin: "upload", status: "processing", width: 1280, height: 720 },
    });
    file(`thumbnails/uploads/${failed.id}.upload`);
    file(`thumbnails/uploads/${working.id}.upload`);
    file("thumbnails/gone.jpg");
    await runMaintenance();
    expect(exists(`thumbnails/uploads/${failed.id}.upload`)).toBe(false);
    expect(exists(`thumbnails/uploads/${working.id}.upload`)).toBe(true);
    expect(exists("thumbnails/gone.jpg")).toBe(false);
    await db.thumbnail.deleteMany({ where: { id: { in: [failed.id, working.id] } } });
  });

  it("finishes jobs whose worker vanished even when no worker is polling", async () => {
    const job = await db.job.create({
      data: {
        userId: user.id,
        type: "media.ingest",
        status: "running",
        payloadJson: "{}",
        attempts: 1,
        leaseExpiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await runMaintenance()).recoveredJobs).toBe(1);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
  });
});
