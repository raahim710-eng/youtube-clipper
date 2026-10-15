import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPTION_STYLE } from "@/lib/shorts/caption-style";
import { db } from "@/server/db";
import { cancelJob, claimNextJob, completeJob, failJob } from "@/server/jobs/queue";
import {
  createShortFromClip,
  deleteShort,
  getShortEditor,
  getShortMediaFile,
  getShortStatus,
  listClipsWithoutShort,
  listShorts,
  saveShort,
  type ShortDoc,
  shortDocSchema,
  startRender,
} from "@/server/services/shorts";
import { deleteVideo } from "@/server/services/videos";
import { resolveStoragePath } from "@/server/storage";
import { createTestUser, fakeMp4 } from "../support/fixtures";

const WORDS = [
  [1000, 1600, "Transcripts"],
  [1650, 1900, "make"],
  [1950, 2400, "editing"],
  [2450, 2700, "much"],
  [2750, 3200, "faster."],
  [3300, 3450, "Did"],
  [3500, 3600, "you"],
  [3650, 3900, "know"],
  [3950, 4300, "that?"],
];

let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

async function videoWithClip(userId: string, options: { width?: number; height?: number } = {}) {
  const video = await db.video.create({
    data: {
      userId,
      title: "Talk",
      originalFilename: "talk.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(100),
      container: "mp4",
      status: "ready",
      durationMs: 60_000,
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      fps: 30,
      audioCodec: "aac",
    },
  });
  const dir = `videos/${video.id}`;
  fs.mkdirSync(resolveStoragePath(dir), { recursive: true });
  fs.writeFileSync(resolveStoragePath(`${dir}/source.mp4`), fakeMp4(100));
  fs.writeFileSync(
    resolveStoragePath(`${dir}/transcript.json`),
    JSON.stringify({
      version: 1,
      provider: "faster-whisper",
      model: "base",
      language: "en",
      languageProbability: 1,
      durationMs: 60_000,
      segments: [{ startMs: 1000, endMs: 4300, text: "…", words: WORDS }],
      loudness: { windowMs: 500, db: Array.from({ length: 120 }, () => -20) },
    }),
  );
  await db.video.update({ where: { id: video.id }, data: { sourcePath: `${dir}/source.mp4` } });
  await db.transcript.create({
    data: { videoId: video.id, status: "ready", provider: "faster-whisper", filePath: `${dir}/transcript.json` },
  });
  const clip = await db.clipCandidate.create({
    data: {
      videoId: video.id,
      startMs: 850,
      endMs: 4500,
      transcriptText: "Transcripts make editing much faster. Did you know that?",
      title: "Transcripts make editing faster",
      origin: "manual",
      status: "accepted",
    },
  });
  return { video, clip };
}

async function claim(type: "media.reframe" | "media.render_short") {
  const job = await claimNextJob("w1", [type]);
  expect(job).not.toBeNull();
  return job!;
}

async function finishReframe(keyframes = [{ tMs: 0, x: 0.4 }]) {
  const job = await claim("media.reframe");
  const payload = job.payload as { startMs: number; endMs: number };
  await completeJob(job.id, "w1", {
    startMs: payload.startMs,
    endMs: payload.endMs,
    model: "YuNet (face_detection_yunet_2023mar.onnx)",
    keyframes: keyframes.map((k) => ({ tMs: Math.max(payload.startMs, k.tMs), x: k.x })),
    shots: 1,
    shotsWithFace: 1,
    faceSamples: 10,
    samples: 10,
    warnings: [],
  });
  return job;
}

async function finishRender(shortId: string) {
  const job = await claim("media.render_short");
  const payload = job.payload as { outputPath: string };
  fs.mkdirSync(resolveStoragePath(`shorts/${shortId}`), { recursive: true });
  fs.writeFileSync(resolveStoragePath(payload.outputPath), fakeMp4(2048));
  await completeJob(job.id, "w1", {
    outputPath: payload.outputPath,
    sizeBytes: 2048,
    durationMs: 3650,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: "h264",
    audioCodec: "aac",
    elapsedMs: 4200,
    preset: "veryfast",
    crf: 20,
  });
  return { job, payload };
}

async function docOf(shortId: string): Promise<ShortDoc> {
  const editor = await getShortEditor(owner.id, shortId);
  return editor!.doc;
}

beforeAll(async () => {
  owner = await createTestUser("shorts-owner");
  stranger = await createTestUser("shorts-stranger");
});

beforeEach(async () => {
  await db.job.deleteMany();
});

describe("creating a Short from a clip (SHORT-01)", () => {
  it("builds captions from the transcript, starts on Auto framing and queues face tracking", async () => {
    const { clip } = await videoWithClip(owner.id);
    const shortId = await createShortFromClip(owner.id, clip.id);
    const editor = await getShortEditor(owner.id, shortId);
    expect(editor?.doc).toMatchObject({ startMs: 850, endMs: 4500, reframeMode: "auto", captionsEnabled: true });
    expect(editor?.doc.captions.map((c) => c.text)).toEqual([
      "Transcripts make",
      "editing much",
      "faster.",
      "Did you know that?",
    ]);
    expect(editor?.doc.captionStyle).toEqual(DEFAULT_CAPTION_STYLE);
    expect(editor?.words.length).toBe(WORDS.length);
    expect(editor?.loudness?.windowMs).toBe(500);
    expect(editor?.status.reframe.status).toBe("processing");

    const job = await db.job.findFirstOrThrow({ where: { entityId: shortId, type: "media.reframe" } });
    // Face tracking looks 10 s beyond each end so small trims don't need a new analysis.
    expect(JSON.parse(job.payloadJson)).toMatchObject({ startMs: 0, endMs: 14_500 });

    expect(await createShortFromClip(owner.id, clip.id)).toBe(shortId); // one Short per clip
    expect((await listClipsWithoutShort(owner.id)).map((c) => c.id)).not.toContain(clip.id);
  });

  it("uses centre framing for vertical videos (no face tracking needed)", async () => {
    const { clip } = await videoWithClip(owner.id, { width: 1080, height: 1920 });
    const shortId = await createShortFromClip(owner.id, clip.id);
    expect((await docOf(shortId)).reframeMode).toBe("center");
    expect(await db.job.count({ where: { entityId: shortId } })).toBe(0);
  });

  it("is limited to the owner", async () => {
    const { clip } = await videoWithClip(owner.id);
    await expect(createShortFromClip(stranger.id, clip.id)).rejects.toThrow("Clip not found.");
    const shortId = await createShortFromClip(owner.id, clip.id);
    expect(await getShortEditor(stranger.id, shortId)).toBeNull();
    await expect(getShortStatus(stranger.id, shortId)).rejects.toThrow("Short not found.");
    await expect(startRender(stranger.id, shortId)).rejects.toThrow("Short not found.");
    expect((await listShorts(stranger.id)).length).toBe(0);
  });
});

describe("editing (SHORT-02/03/04)", () => {
  it("normalises captions and re-runs face tracking only when the range leaves the analysed part", async () => {
    const { clip } = await videoWithClip(owner.id);
    const shortId = await createShortFromClip(owner.id, clip.id);
    await finishReframe();
    const doc = await docOf(shortId);

    const status = await saveShort(owner.id, shortId, {
      ...doc,
      startMs: 2000,
      captions: [...doc.captions, { startMs: 4000, endMs: 9000, text: "  extra  " }],
    });
    expect(status.reframe).toMatchObject({ status: "ready", covers: true });
    expect(await db.job.count({ where: { entityId: shortId, type: "media.reframe" } })).toBe(1);
    const saved = await docOf(shortId);
    expect(saved.captions.at(-1)).toEqual({ startMs: 4000, endMs: 4500, text: "extra" });
    expect(saved.captions[0].startMs).toBe(2000);

    const moved = await saveShort(owner.id, shortId, { ...saved, startMs: 30_000, endMs: 40_000 });
    expect(moved.reframe.status).toBe("processing");
    expect(moved.reframe.covers).toBe(false);
    expect(await db.job.count({ where: { entityId: shortId, type: "media.reframe", status: "queued" } })).toBe(1);
  });

  it("rejects Shorts over 3 minutes or past the end of the video", async () => {
    const { clip } = await videoWithClip(owner.id);
    const shortId = await createShortFromClip(owner.id, clip.id);
    const doc = await docOf(shortId);
    expect(shortDocSchema.safeParse({ ...doc, startMs: 0, endMs: 180_001 }).success).toBe(false);
    expect(shortDocSchema.safeParse({ ...doc, endMs: doc.startMs + 500 }).success).toBe(false);
    await expect(saveShort(owner.id, shortId, { ...doc, endMs: 61_000 })).rejects.toThrow(/after the video ends/);
  });
});

describe("exporting (SHORT-05/07)", () => {
  it("waits for face tracking on Auto, then queues an export of the exact settings", async () => {
    const { clip } = await videoWithClip(owner.id);
    const shortId = await createShortFromClip(owner.id, clip.id);
    await expect(startRender(owner.id, shortId)).rejects.toThrow(/Face tracking is still running/);

    await finishReframe([
      { tMs: 0, x: 0.4 },
      { tMs: 3000, x: 0.6 },
    ]);
    const doc = await docOf(shortId);
    await saveShort(owner.id, shortId, {
      ...doc,
      hookText: "Watch this",
      captions: [{ ...doc.captions[0], text: "{hi}" }],
    });
    const status = await startRender(owner.id, shortId);
    expect(status.render.status).toBe("rendering");
    await expect(startRender(owner.id, shortId)).rejects.toThrow(/already being exported/);

    const job = await db.job.findFirstOrThrow({ where: { entityId: shortId, type: "media.render_short" } });
    const payload = JSON.parse(job.payloadJson);
    expect(payload.outputPath).toMatch(new RegExp(`^shorts/${shortId}/render-[a-z0-9]+\\.mp4$`));
    expect(payload).toMatchObject({ startMs: 850, endMs: 4500, quality: "standard" });
    expect(payload.framing.mode).toBe("crop");
    expect(payload.framing.keyframes[0]).toEqual({ tMs: 0, x: expect.closeTo(0.4567, 3) });
    expect(payload.captions[0]).toEqual({ startMs: 150, endMs: 1100, text: "{HI}" }); // relative + capitals
    expect(payload.captionStyle).toMatchObject({ fontName: "Geist Black", fontSize: 96, centerY: 1344 });
    expect(payload.hook).toMatchObject({ text: "Watch this", endMs: 3000 });
    expect(job.priority).toBeLessThan(100);
  });

  it("stores the finished file, offers it to the owner only and marks it out of date after edits", async () => {
    const { clip } = await videoWithClip(owner.id, { width: 1080, height: 1920 });
    const shortId = await createShortFromClip(owner.id, clip.id);
    await startRender(owner.id, shortId);
    const { payload } = await finishRender(shortId);

    const status = await getShortStatus(owner.id, shortId);
    expect(status.render).toMatchObject({ status: "ready", stale: false, error: null });
    expect(status.render.output).toMatchObject({ sizeBytes: 2048, durationMs: 3650, elapsedMs: 4200 });
    const file = await getShortMediaFile(owner.id, shortId);
    expect(file).toMatchObject({
      size: 2048,
      contentType: "video/mp4",
      downloadName: "Transcripts make editing faster.mp4",
    });
    await expect(getShortMediaFile(stranger.id, shortId)).rejects.toThrow(/hasn't been exported/);

    const doc = await docOf(shortId);
    await saveShort(owner.id, shortId, { ...doc, title: "Renamed only" });
    expect((await getShortStatus(owner.id, shortId)).render.stale).toBe(false); // the title isn't in the video
    await saveShort(owner.id, shortId, { ...doc, captions: [{ ...doc.captions[0], text: "Changed" }] });
    expect((await getShortStatus(owner.id, shortId)).render.stale).toBe(true);
    expect((await listShorts(owner.id)).find((s) => s.id === shortId)?.stale).toBe(true);
    await saveShort(owner.id, shortId, doc);
    expect((await getShortStatus(owner.id, shortId)).render.stale).toBe(false); // back to the exported settings

    // A new export removes older files but keeps the current one until it is replaced.
    fs.writeFileSync(resolveStoragePath(`shorts/${shortId}/render-old.mp4`), "x");
    await startRender(owner.id, shortId);
    expect(fs.existsSync(resolveStoragePath(`shorts/${shortId}/render-old.mp4`))).toBe(false);
    expect(fs.existsSync(resolveStoragePath(payload.outputPath))).toBe(true);
  });

  it("explains failures, and cancelling returns to the previous state", async () => {
    const { clip } = await videoWithClip(owner.id, { width: 1080, height: 1920 });
    const shortId = await createShortFromClip(owner.id, clip.id);
    await startRender(owner.id, shortId);
    const job = await claim("media.render_short");
    await failJob(job.id, "w1", { code: "RENDER_FAILED", message: "Exporting the Short failed.", retryable: false });
    expect((await getShortStatus(owner.id, shortId)).render).toMatchObject({
      status: "failed",
      error: "Exporting the Short failed.",
    });

    await startRender(owner.id, shortId);
    const queued = await db.job.findFirstOrThrow({ where: { entityId: shortId, status: "queued" } });
    await cancelJob(owner.id, queued.id);
    expect((await getShortStatus(owner.id, shortId)).render).toMatchObject({ status: "draft", error: null });
  });

  it("refuses results for a different file", async () => {
    const { clip } = await videoWithClip(owner.id, { width: 1080, height: 1920 });
    const shortId = await createShortFromClip(owner.id, clip.id);
    await startRender(owner.id, shortId);
    const job = await claim("media.render_short");
    await expect(
      completeJob(job.id, "w1", {
        outputPath: "videos/elsewhere/render.mp4",
        sizeBytes: 1,
        durationMs: 1000,
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: "h264",
        audioCodec: null,
        elapsedMs: 1,
        preset: "veryfast",
        crf: 20,
      }),
    ).rejects.toThrow();
    expect((await getShortStatus(owner.id, shortId)).render.output).toBeNull();
  });
});

describe("deleting", () => {
  it("removes the Short and its files; deleting the video removes its Shorts too", async () => {
    const { video, clip } = await videoWithClip(owner.id, { width: 1080, height: 1920 });
    const shortId = await createShortFromClip(owner.id, clip.id);
    await startRender(owner.id, shortId);
    await finishRender(shortId);
    const dir = resolveStoragePath(`shorts/${shortId}`);
    expect(fs.existsSync(dir)).toBe(true);

    await expect(deleteShort(stranger.id, shortId)).rejects.toThrow("Short not found.");
    await deleteShort(owner.id, shortId);
    expect(fs.existsSync(dir)).toBe(false);
    expect(await db.short.count({ where: { id: shortId } })).toBe(0);
    expect(await db.clipCandidate.count({ where: { id: clip.id } })).toBe(1); // the clip stays

    const again = await createShortFromClip(owner.id, clip.id);
    await startRender(owner.id, again);
    await finishRender(again);
    await deleteVideo(owner.id, video.id);
    expect(await db.short.count({ where: { id: again } })).toBe(0);
    expect(fs.existsSync(resolveStoragePath(`shorts/${again}`))).toBe(false);
  });
});
