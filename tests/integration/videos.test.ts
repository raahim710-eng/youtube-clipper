import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { enqueueJob } from "@/server/jobs/queue";
import { deleteVideo, getVideo, getVideoMediaFile, listVideos, updateVideoDetails } from "@/server/services/videos";
import { resolveStoragePath } from "@/server/storage";
import { requireWorker } from "@/server/worker-auth";
import { createTestUser, fakeMp4 } from "../support/fixtures";

let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

async function addVideo(userId: string, title: string, extra: { status?: string; durationMs?: number } = {}) {
  const video = await db.video.create({
    data: {
      userId,
      title,
      originalFilename: `${title}.mp4`,
      sourcePath: "placeholder",
      sizeBytes: BigInt(100),
      container: "mp4",
      status: extra.status ?? "ready",
      durationMs: extra.durationMs ?? null,
    },
  });
  const sourcePath = `videos/${video.id}/source.mp4`;
  fs.mkdirSync(resolveStoragePath(`videos/${video.id}`), { recursive: true });
  fs.writeFileSync(resolveStoragePath(sourcePath), fakeMp4(100));
  fs.writeFileSync(resolveStoragePath(`videos/${video.id}/poster.jpg`), "jpg");
  return db.video.update({
    where: { id: video.id },
    data: { sourcePath, posterPath: `videos/${video.id}/poster.jpg` },
  });
}

beforeAll(async () => {
  owner = await createTestUser("lib-owner");
  stranger = await createTestUser("lib-stranger");
  await addVideo(owner.id, "Alpha interview", { durationMs: 60_000 });
  await addVideo(owner.id, "Beta tutorial", { durationMs: 600_000, status: "processing" });
  await addVideo(stranger.id, "Stranger secret");
});

describe("library listing (LIB-04) and persistence", () => {
  it("lists only the user's own videos, newest first", async () => {
    const titles = (await listVideos(owner.id, { q: "", sort: "newest", status: "all" })).map((v) => v.title);
    expect(titles).toEqual(["Beta tutorial", "Alpha interview"]);
  });

  it("searches, filters and sorts", async () => {
    expect((await listVideos(owner.id, { q: "alpha", sort: "newest", status: "all" })).map((v) => v.title)).toEqual([
      "Alpha interview",
    ]);
    expect((await listVideos(owner.id, { q: "", sort: "newest", status: "processing" })).map((v) => v.title)).toEqual([
      "Beta tutorial",
    ]);
    expect((await listVideos(owner.id, { q: "", sort: "longest", status: "all" }))[0]?.title).toBe("Beta tutorial");
    expect(await listVideos(owner.id, { q: "secret", sort: "newest", status: "all" })).toEqual([]);
  });

  it("saves title and notes", async () => {
    const [video] = await listVideos(owner.id, { q: "alpha", sort: "newest", status: "all" });
    await updateVideoDetails(owner.id, video!.id, { title: "Alpha (edited)", notes: "For podcasters" });
    expect(await getVideo(owner.id, video!.id)).toMatchObject({ title: "Alpha (edited)", notes: "For podcasters" });
  });
});

describe("access restrictions (users only reach their own videos and files)", () => {
  it("treats another user's video like a missing one", async () => {
    const [theirs] = await listVideos(stranger.id, { q: "", sort: "newest", status: "all" });
    expect(await getVideo(owner.id, theirs!.id)).toBeNull();
    for (const variant of ["source", "poster", "playback"] as const) {
      await expect(getVideoMediaFile(owner.id, theirs!.id, variant)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(updateVideoDetails(owner.id, theirs!.id, { title: "x", notes: null })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(deleteVideo(owner.id, theirs!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getVideo(stranger.id, theirs!.id)).not.toBeNull();
  });

  it("serves the owner's files with the right type", async () => {
    const [mine] = await listVideos(owner.id, { q: "beta", sort: "newest", status: "all" });
    const file = await getVideoMediaFile(owner.id, mine!.id, "playback");
    expect(file).toMatchObject({ contentType: "video/mp4", size: 100 });
    await expect(getVideoMediaFile(owner.id, mine!.id, "preview")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("deleting (LIB-06)", () => {
  it("removes the record, its files and pending jobs, and audits it", async () => {
    const video = await addVideo(owner.id, "To delete", { status: "processing" });
    const job = await enqueueJob({
      userId: owner.id,
      type: "media.ingest",
      entityType: "video",
      entityId: video.id,
      payload: {},
    });
    await deleteVideo(owner.id, video.id);

    expect(await db.video.findUnique({ where: { id: video.id } })).toBeNull();
    expect(fs.existsSync(resolveStoragePath(`videos/${video.id}`))).toBe(false);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(await db.auditLog.count({ where: { action: "video.deleted", userId: owner.id } })).toBe(1);
  });
});

describe("worker API authentication (SECURITY.md §5)", () => {
  const secret = () => process.env.WORKER_SHARED_SECRET!;
  const request = (headers: Record<string, string>) =>
    new Request("http://localhost/api/internal/jobs/claim", { method: "POST", headers });

  it("accepts only the correct secret from this machine", () => {
    expect(() => requireWorker(request({ authorization: `Bearer ${secret()}` }))).not.toThrow();
    expect(() => requireWorker(request({}))).toThrow(/Invalid worker credentials/);
    expect(() => requireWorker(request({ authorization: "Bearer wrong" }))).toThrow(/Invalid worker credentials/);
    expect(() => requireWorker(request({ authorization: `Bearer ${secret()}x` }))).toThrow();
    expect(() =>
      requireWorker(request({ authorization: `Bearer ${secret()}`, "x-forwarded-for": "203.0.113.9" })),
    ).toThrow(/this computer/);
  });
});
