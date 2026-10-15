import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_SIZE } from "@/lib/uploads";
import { db } from "@/server/db";
import { resetEnvCacheForTests } from "@/server/env";
import { AppError } from "@/server/errors";
import {
  cancelUpload,
  completeUpload,
  createUpload,
  getUploadStatus,
  listIncompleteUploads,
  sweepStaleUploads,
  writeChunk,
} from "@/server/services/uploads";
import { getStorageRoot, resolveStoragePath, storagePaths } from "@/server/storage";
import { createTestUser, fakeMp4, streamOf } from "../support/fixtures";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

beforeAll(async () => {
  owner = await createTestUser("owner");
  stranger = await createTestUser("stranger");
});

afterEach(() => {
  delete process.env.MAX_UPLOAD_MB;
  resetEnvCacheForTests();
});

async function uploadAll(userId: string, id: string, bytes: Buffer, skip: number[] = []) {
  const chunks = Math.ceil(bytes.length / UPLOAD_CHUNK_SIZE);
  for (let index = 0; index < chunks; index += 1) {
    if (skip.includes(index)) continue;
    const part = bytes.subarray(index * UPLOAD_CHUNK_SIZE, (index + 1) * UPLOAD_CHUNK_SIZE);
    await writeChunk(userId, id, index, streamOf(part));
  }
}

describe("successful upload (LIB-01)", () => {
  it("stores a multi-chunk file byte-for-byte, creates the video and queues processing", async () => {
    const bytes = fakeMp4(UPLOAD_CHUNK_SIZE * 2 + 4321); // 3 chunks
    const upload = await createUpload(owner.id, { filename: "My_Holiday.mp4", size: bytes.length });
    expect(upload.totalChunks).toBe(3);

    await uploadAll(owner.id, upload.id, bytes);
    const { videoId } = await completeUpload(owner.id, upload.id);

    const video = await db.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video).toMatchObject({ userId: owner.id, title: "My Holiday", status: "processing", container: "mp4" });
    expect(Number(video.sizeBytes)).toBe(bytes.length);
    expect(video.sourcePath).toBe(`videos/${videoId}/source.mp4`);

    const stored = fs.readFileSync(resolveStoragePath(video.sourcePath));
    expect(sha(stored)).toBe(sha(bytes));

    const job = await db.job.findFirstOrThrow({ where: { entityType: "video", entityId: videoId } });
    expect(job).toMatchObject({ type: "media.ingest", status: "queued", userId: owner.id });
    expect(JSON.parse(job.payloadJson)).toMatchObject({ videoId, sourcePath: video.sourcePath });

    expect(fs.existsSync(resolveStoragePath(storagePaths.uploadTempDir(upload.id)))).toBe(false);
    expect((await db.upload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("completed");
  });

  it("resumes: reports received chunks and completes after the missing one arrives", async () => {
    const bytes = fakeMp4(UPLOAD_CHUNK_SIZE + 10);
    const upload = await createUpload(owner.id, { filename: "resume.mp4", size: bytes.length });
    await uploadAll(owner.id, upload.id, bytes, [1]);

    expect((await getUploadStatus(owner.id, upload.id)).receivedChunks).toEqual([0]);
    expect((await listIncompleteUploads(owner.id)).map((u) => u.id)).toContain(upload.id);
    await expect(completeUpload(owner.id, upload.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await writeChunk(owner.id, upload.id, 1, streamOf(bytes.subarray(UPLOAD_CHUNK_SIZE)));
    const { videoId } = await completeUpload(owner.id, upload.id);
    expect(sha(fs.readFileSync(resolveStoragePath(`videos/${videoId}/source.mp4`)))).toBe(sha(bytes));
  });
});

describe("invalid files (LIB-02)", () => {
  it("rejects unsupported formats and empty files before any data is sent", async () => {
    await expect(createUpload(owner.id, { filename: "notes.txt", size: 100 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(createUpload(owner.id, { filename: "a.mp4", size: 0 })).rejects.toBeInstanceOf(AppError);
  });

  it("rejects files over MAX_UPLOAD_MB with 413", async () => {
    process.env.MAX_UPLOAD_MB = "1";
    resetEnvCacheForTests();
    await expect(createUpload(owner.id, { filename: "big.mp4", size: 2 * 1024 * 1024 })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("rejects a renamed text file by its content and cleans up", async () => {
    const bytes = Buffer.from("This is a text file renamed to .mp4, not a video.");
    const upload = await createUpload(owner.id, { filename: "fake.mp4", size: bytes.length });
    await writeChunk(owner.id, upload.id, 0, streamOf(bytes));
    await expect(completeUpload(owner.id, upload.id)).rejects.toThrow(/doesn't look like a real MP4/);

    const row = await db.upload.findUniqueOrThrow({ where: { id: upload.id } });
    expect(row.status).toBe("failed");
    expect(row.videoId).toBeNull();
    expect(fs.existsSync(resolveStoragePath(storagePaths.uploadTempDir(upload.id)))).toBe(false);
  });

  it("rejects chunks that are too big, too small or out of range", async () => {
    const upload = await createUpload(owner.id, { filename: "sizes.mp4", size: 100 });
    await expect(writeChunk(owner.id, upload.id, 0, streamOf(fakeMp4(101)))).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    await expect(writeChunk(owner.id, upload.id, 0, streamOf(fakeMp4(50)))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(writeChunk(owner.id, upload.id, 1, streamOf(fakeMp4(100)))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect((await getUploadStatus(owner.id, upload.id)).receivedChunks).toEqual([]);
  });
});

describe("failed and abandoned uploads", () => {
  it("cancelling deletes partial data and blocks further chunks", async () => {
    const upload = await createUpload(owner.id, { filename: "cancel.mp4", size: 100 });
    await cancelUpload(owner.id, upload.id);
    expect(fs.existsSync(resolveStoragePath(storagePaths.uploadTempDir(upload.id)))).toBe(false);
    await expect(writeChunk(owner.id, upload.id, 0, streamOf(fakeMp4(100)))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("expires idle uploads and removes orphaned temp folders", async () => {
    const upload = await createUpload(owner.id, { filename: "idle.mp4", size: 100 });
    await db.upload.update({ where: { id: upload.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const orphan = path.join(getStorageRoot(), "uploads", "tmp", "orphan-from-a-crash");
    fs.mkdirSync(orphan, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);

    const result = await sweepStaleUploads();
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.orphans).toBeGreaterThanOrEqual(1);
    expect((await db.upload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("expired");
    expect(fs.existsSync(resolveStoragePath(storagePaths.uploadTempDir(upload.id)))).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe("ownership (users only reach their own uploads)", () => {
  it("hides another user's upload completely", async () => {
    const upload = await createUpload(owner.id, { filename: "private.mp4", size: 100 });
    for (const attempt of [
      () => getUploadStatus(stranger.id, upload.id),
      () => writeChunk(stranger.id, upload.id, 0, streamOf(fakeMp4(100))),
      () => completeUpload(stranger.id, upload.id),
      () => cancelUpload(stranger.id, upload.id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect((await db.upload.findUniqueOrThrow({ where: { id: upload.id } })).status).toBe("in_progress");
  });
});
