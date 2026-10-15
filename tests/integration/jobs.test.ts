import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  cancelJob,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  recoverExpiredLeases,
  retryJob,
} from "@/server/jobs/queue";
import { resolveStoragePath } from "@/server/storage";
import { createTestUser, fakeMp4 } from "../support/fixtures";

const TYPES = ["media.ingest"];
const okResult = (videoId: string) => ({
  durationMs: 12_500,
  width: 1920,
  height: 1080,
  fps: 29.97,
  videoCodec: "h264",
  audioCodec: "aac",
  posterPath: `videos/${videoId}/poster.jpg`,
  previewPath: null,
});

/** A video in "processing" with a real source file and its ingest job. */
async function videoWithJob() {
  const user = await createTestUser("jobs");
  const video = await db.video.create({
    data: {
      userId: user.id,
      title: "Test",
      originalFilename: "t.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(100),
      container: "mp4",
    },
  });
  const sourcePath = `videos/${video.id}/source.mp4`;
  fs.mkdirSync(resolveStoragePath(`videos/${video.id}`), { recursive: true });
  fs.writeFileSync(resolveStoragePath(sourcePath), fakeMp4(100));
  await db.video.update({ where: { id: video.id }, data: { sourcePath } });
  const job = await enqueueJob({
    userId: user.id,
    type: "media.ingest",
    entityType: "video",
    entityId: video.id,
    payload: { videoId: video.id, sourcePath, outputDir: `videos/${video.id}`, maxDurationMinutes: 180 },
  });
  return { user, video, job, sourcePath };
}

beforeEach(async () => {
  await db.job.deleteMany();
});

describe("claiming (JOB-01)", () => {
  it("gives each job to exactly one worker, even when they ask at the same time", async () => {
    const { job } = await videoWithJob();
    const claims = await Promise.all(["w1", "w2", "w3"].map((worker) => claimNextJob(worker, TYPES)));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(job.id);
    expect(await claimNextJob("w4", TYPES)).toBeNull();
  });

  it("only hands out job types the worker asked for", async () => {
    await videoWithJob();
    expect(await claimNextJob("w1", ["something.else"])).toBeNull();
  });

  it("rejects heartbeats and results from a worker that doesn't hold the job", async () => {
    const { job, video } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await expect(heartbeatJob(job.id, "w2", 50)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(completeJob(job.id, "w2", okResult(video.id))).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("results (persisting what the worker found)", () => {
  it("marks the video ready with its details", async () => {
    const { job, video } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    expect(await heartbeatJob(job.id, "w1", 40, "Creating thumbnail")).toMatchObject({ cancelRequested: false });
    await completeJob(job.id, "w1", okResult(video.id));

    const saved = await db.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(saved).toMatchObject({ status: "ready", durationMs: 12_500, width: 1920, videoCodec: "h264" });
    expect(saved.posterPath).toBe(`videos/${video.id}/poster.jpg`);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("succeeded");
  });

  it("refuses malformed results and outputs outside the video's folder", async () => {
    for (const bad of [{ width: "big" }, { ...okResult("x"), posterPath: "videos/other-video/poster.jpg" }]) {
      const { job, video } = await videoWithJob();
      await claimNextJob("w1", TYPES);
      const result = "posterPath" in bad ? bad : { ...okResult(video.id), ...bad };
      await expect(completeJob(job.id, "w1", result)).rejects.toThrow();
      expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).status).not.toBe("ready");
      await db.job.deleteMany();
    }
  });

  it("refuses paths that try to leave storage", async () => {
    const { job, video } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await expect(completeJob(job.id, "w1", { ...okResult(video.id), previewPath: "../../evil.mp4" })).rejects.toThrow();
  });
});

describe("failures and retries (JOB-04/05)", () => {
  it("requeues retryable failures with a delay, then fails for good after max attempts", async () => {
    const { job, video } = await videoWithJob();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0) } }); // skip the back-off
      expect((await claimNextJob("w1", TYPES))?.attempt).toBe(attempt);
      await failJob(job.id, "w1", { code: "TRANSCODE_FAILED", message: "Try again", retryable: true });
    }
    const final = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(final).toMatchObject({ status: "failed", attempts: 3, errorCode: "TRANSCODE_FAILED" });
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).status).toBe("failed");
  });

  it("waits for the back-off before a retry can be claimed", async () => {
    const { job } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await failJob(job.id, "w1", { code: "X", message: "Temporary", retryable: true });
    expect(await claimNextJob("w1", TYPES)).toBeNull();
  });

  it("fails immediately for a bad file, explains why and deletes the unusable file", async () => {
    const { job, video, sourcePath } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await failJob(job.id, "w1", { code: "INVALID_VIDEO", message: "Not a video.", retryable: false });

    const saved = await db.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(saved).toMatchObject({ status: "failed", errorMessage: "Not a video." });
    expect(fs.existsSync(resolveStoragePath(sourcePath))).toBe(false);
    await expect(retryJob(video.userId, job.id)).rejects.toThrow(/no longer available/);
  });

  it("recovers jobs from a crashed worker when the lease expires", async () => {
    const { job } = await videoWithJob();
    await claimNextJob("crashed", TYPES);
    await db.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await recoverExpiredLeases()).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "queued",
      lockedBy: null,
      errorCode: "WORKER_LOST",
    });
  });

  it("lets the user retry a failed job and resets the video", async () => {
    const { job, video, user } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await failJob(job.id, "w1", { code: "FFMPEG_MISSING", message: "Install FFmpeg", retryable: false });
    await retryJob(user.id, job.id);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).status).toBe("processing");
  });
});

describe("cancelling (JOB-03)", () => {
  it("cancels a queued job at once", async () => {
    const { job, video, user } = await videoWithJob();
    await cancelJob(user.id, job.id);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(await db.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
      status: "failed",
      errorMessage: "Processing was cancelled.",
    });
  });

  it("asks a running job to stop via its next heartbeat", async () => {
    const { job, user } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await cancelJob(user.id, job.id);
    expect(await heartbeatJob(job.id, "w1", 60)).toMatchObject({ cancelRequested: true });
    await failJob(job.id, "w1", { code: "CANCELLED", message: "Cancelled", retryable: false });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
  });

  it("won't let another user cancel or retry a job", async () => {
    const { job } = await videoWithJob();
    const stranger = await createTestUser("stranger");
    await expect(cancelJob(stranger.id, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(retryJob(stranger.id, job.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("races and duplicate processing (Phase 10)", () => {
  it("never applies a result from a worker whose lease was taken over", async () => {
    const { job, video } = await videoWithJob();
    await claimNextJob("slow", TYPES);
    await db.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await recoverExpiredLeases();
    await db.job.update({ where: { id: job.id }, data: { runAfter: new Date(0) } });
    expect((await claimNextJob("fresh", TYPES))?.id).toBe(job.id);
    await expect(completeJob(job.id, "slow", okResult(video.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await completeJob(job.id, "fresh", okResult(video.id));
    await expect(completeJob(job.id, "fresh", okResult(video.id))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "succeeded" });
  });

  it("recovers an expired lease only once when two processes sweep at the same time", async () => {
    const { job } = await videoWithJob();
    await claimNextJob("crashed", TYPES);
    await db.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const counts = await Promise.all([recoverExpiredLeases(), recoverExpiredLeases(), recoverExpiredLeases()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("fails a job whose result can't be saved instead of re-running it, with a safe message", async () => {
    const { job, video } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    const bad = { ...okResult(video.id), posterPath: "videos/someone-else/poster.jpg" };
    await expect(completeJob(job.id, "w1", bad)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "failed",
      errorCode: "RESULT_REJECTED",
      error: "The result couldn't be saved. Try again.",
    });
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).status).toBe("failed");
  });

  it("a late failure report can't overwrite a cancelled job", async () => {
    const { job, user } = await videoWithJob();
    await claimNextJob("w1", TYPES);
    await cancelJob(user.id, job.id);
    await failJob(job.id, "w1", { code: "CANCELLED", message: "Cancelled", retryable: false });
    await expect(
      failJob(job.id, "w1", { code: "FFMPEG_STALLED", message: "Stuck", retryable: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
  });
});
