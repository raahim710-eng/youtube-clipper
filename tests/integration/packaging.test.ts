import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { claimNextJob, completeJob, failJob } from "@/server/jobs/queue";
import {
  deletePackagingSet,
  getPackagingTarget,
  getThumbnailFile,
  listPackagingSets,
  listPackagingTargets,
  listThumbnails,
  requestThumbnail,
  savePackagingEdits,
  selectThumbnail,
  setPreferredPackaging,
  startPackaging,
  uploadThumbnail,
} from "@/server/services/packaging";
import { deleteShort } from "@/server/services/shorts";
import { deleteVideo } from "@/server/services/videos";
import { resolveStoragePath } from "@/server/storage";
import { createTestUser, fakeMp4 } from "../support/fixtures";

let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

async function useProvider(userId: string, llmProvider: string) {
  await db.userSettings.upsert({
    where: { userId },
    create: { userId, llmProvider, channelStyleNotes: "Calm, practical, no hype." },
    update: { llmProvider, channelStyleNotes: "Calm, practical, no hype." },
  });
}

async function readyVideo(userId: string, options: { transcript?: boolean } = {}) {
  const video = await db.video.create({
    data: {
      userId,
      title: "Editing talk",
      notes: "For beginners",
      originalFilename: "talk.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(100),
      container: "mp4",
      status: "ready",
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      audioCodec: "aac",
    },
  });
  const dir = `videos/${video.id}`;
  fs.mkdirSync(resolveStoragePath(dir), { recursive: true });
  fs.writeFileSync(resolveStoragePath(`${dir}/source.mp4`), fakeMp4(100));
  await db.video.update({ where: { id: video.id }, data: { sourcePath: `${dir}/source.mp4` } });
  if (options.transcript !== false) {
    fs.writeFileSync(resolveStoragePath(`${dir}/transcript.json`), JSON.stringify({ version: 1, segments: [] }));
    await db.transcript.create({
      data: {
        videoId: video.id,
        status: "ready",
        provider: "faster-whisper",
        filePath: `${dir}/transcript.json`,
        wordCount: 900,
      },
    });
  }
  return video;
}

const RESULT = {
  provider: "openai_compatible",
  model: "test-model",
  format: "long",
  usedSummary: true,
  sourceWords: 900,
  titles: [
    { text: "Edit Faster With <b>Transcripts</b>", flags: [] },
    { text: "10 Secrets", flags: ["Mentions 10, which isn't in the transcript — check it's accurate."] },
  ],
  hooks: [{ text: "Most editing time is spent searching.", flags: [] }],
  description: "How transcripts speed up editing.\n\nChapters\n0:00 Intro\n2:00 Setup\n5:00 Results",
  descriptionFlags: [],
  hashtags: ["VideoEditing", "videoediting", "#transcripts"],
  droppedHashtags: ["Crypto"],
  concepts: [{ headline: "Edit in seconds", composition: "Face left", emotion: "relief", frameMs: 4000, flags: [] }],
  chapters: [
    { startMs: 0, title: "Intro" },
    { startMs: 120_000, title: "Setup" },
    { startMs: 300_000, title: "Results" },
  ],
  warnings: ["Left out hashtags unrelated to the transcript: #Crypto"],
};

async function finishPackaging(result: Record<string, unknown> = RESULT) {
  const job = await claimNextJob("w1", ["ai.package"]);
  expect(job).not.toBeNull();
  await completeJob(job!.id, "w1", result);
  return job!;
}

beforeAll(async () => {
  owner = await createTestUser("packaging-owner");
  stranger = await createTestUser("packaging-stranger");
});

beforeEach(async () => {
  await db.job.deleteMany();
  await useProvider(owner.id, "openai_compatible");
});

describe("starting packaging (PKG-01, 04, 07; missing credentials)", () => {
  it("needs a transcript", async () => {
    const video = await readyVideo(owner.id, { transcript: false });
    await expect(startPackaging(owner.id, "video", video.id, null)).rejects.toThrow(/Transcribe the video first/);
  });

  it("explains a missing API key or AI turned off, and queues nothing", async () => {
    const video = await readyVideo(owner.id);
    await useProvider(owner.id, "gemini");
    await expect(startPackaging(owner.id, "video", video.id, null)).rejects.toThrow(
      /Google Gemini API isn't ready: No API key/,
    );
    await useProvider(owner.id, "none");
    await expect(startPackaging(owner.id, "video", video.id, null)).rejects.toThrow(/AI is turned off/);
    expect(await db.job.count({ where: { type: "ai.package" } })).toBe(0);
    expect(await db.packagingSet.count({ where: { videoId: video.id } })).toBe(0);
  });

  it("queues generation with the transcript, notes and channel style", async () => {
    const video = await readyVideo(owner.id);
    const set = await startPackaging(owner.id, "video", video.id, "Audience: beginners");
    expect(set).toMatchObject({ status: "processing", inputNotes: "Audience: beginners" });
    const job = await db.job.findFirstOrThrow({ where: { type: "ai.package", entityId: set.id } });
    expect(JSON.parse(job.payloadJson)).toMatchObject({
      targetKind: "video",
      transcriptPath: `videos/${video.id}/transcript.json`,
      durationMs: 600_000,
      title: "Editing talk",
      notes: "Audience: beginners\nAbout the video: For beginners",
      channelStyle: "Calm, practical, no hype.",
      provider: "openai_compatible",
      maxInputWords: 1500,
    });
    await expect(startPackaging(owner.id, "video", video.id, null)).rejects.toThrow(/already being written/);
  });

  it("uses a Short's corrected captions and range", async () => {
    const video = await readyVideo(owner.id);
    const short = await db.short.create({
      data: {
        userId: owner.id,
        videoId: video.id,
        title: "Find any moment",
        startMs: 30_000,
        endMs: 60_000,
        captionStyleJson: "{}",
        captionsJson: JSON.stringify([
          { startMs: 30_000, endMs: 31_000, text: "Find any" },
          { startMs: 31_000, endMs: 32_000, text: "moment fast" },
        ]),
      },
    });
    const set = await startPackaging(owner.id, "short", short.id, null);
    const job = await db.job.findFirstOrThrow({ where: { type: "ai.package", entityId: set.id } });
    expect(JSON.parse(job.payloadJson)).toMatchObject({
      targetKind: "short",
      rangeStartMs: 30_000,
      rangeEndMs: 60_000,
      captionText: "Find any moment fast",
      durationMs: 30_000,
    });
  });

  it("is limited to the owner", async () => {
    const video = await readyVideo(owner.id);
    expect(await getPackagingTarget(stranger.id, "video", video.id)).toBeNull();
    await expect(startPackaging(stranger.id, "video", video.id, null)).rejects.toThrow("Video not found.");
    expect(await listPackagingSets(stranger.id, "video", video.id)).toEqual([]);
  });
});

describe("results, editing and saving (PKG-02, 05)", () => {
  it("stores results within YouTube's limits and keeps earlier versions", async () => {
    const video = await readyVideo(owner.id);
    await startPackaging(owner.id, "video", video.id, null);
    await finishPackaging();
    const [set] = await listPackagingSets(owner.id, "video", video.id);
    expect(set.status).toBe("ready");
    expect(set.titles[0]).toEqual({ text: "Edit Faster With bTranscripts/b", flags: [], edited: false });
    expect(set.titles[1].flags[0]).toMatch(/Mentions 10/);
    expect(set.hashtags).toEqual([
      { tag: "VideoEditing", selected: true },
      { tag: "transcripts", selected: true },
    ]);
    expect(set.chapters).toHaveLength(3);
    expect(set.warnings[0]).toMatch(/summarised first/);
    expect(set.model).toBe("test-model");

    await startPackaging(owner.id, "video", video.id, "More playful");
    await finishPackaging();
    const sets = await listPackagingSets(owner.id, "video", video.id);
    expect(sets).toHaveLength(2); // regenerating keeps the old set (PKG-04)
    expect(sets[0].inputNotes).toBe("More playful");
  });

  it("refuses results that break the schema", async () => {
    const video = await readyVideo(owner.id);
    const set = await startPackaging(owner.id, "video", video.id, null);
    await expect(finishPackaging({ ...RESULT, titles: [] })).rejects.toThrow();
    expect((await listPackagingSets(owner.id, "video", video.id)).find((s) => s.id === set.id)?.status).toBe("failed");
  });

  it("saves edits, enforces limits again and marks what the creator changed", async () => {
    const video = await readyVideo(owner.id);
    const { id } = await startPackaging(owner.id, "video", video.id, null);
    await finishPackaging();
    const saved = await savePackagingEdits(owner.id, id, {
      titles: ["Edit Faster With bTranscripts/b", "My own <title> " + "x".repeat(120)],
      description: "Café ☕ ".repeat(800),
      hashtags: [
        { tag: "VideoEditing", selected: false },
        { tag: "#transcripts", selected: true },
        { tag: "my new tag", selected: true },
      ],
      hooks: ["  A new   hook  "],
      conceptHeadlines: ["Edit in seconds every single day"],
      selectedTitle: 1,
      selectedHook: 0,
    });
    expect(saved.titles[0]).toMatchObject({ edited: false, flags: [] });
    expect(saved.titles[1].edited).toBe(true);
    expect(saved.titles[1].flags).toEqual([]);
    expect([...saved.titles[1].text].length).toBe(100);
    expect(saved.titles[1].text).not.toMatch(/[<>]/);
    expect(new TextEncoder().encode(saved.description).length).toBeLessThanOrEqual(5000);
    expect(saved.descriptionEdited).toBe(true);
    expect(saved.hashtags).toEqual([
      { tag: "VideoEditing", selected: false },
      { tag: "transcripts", selected: true },
      { tag: "myNewTag", selected: true },
    ]);
    expect(saved.hooks[0]).toMatchObject({ text: "A new hook", edited: true });
    expect(saved.concepts[0].headline).toBe("Edit in seconds every single");
    expect(saved.selectedTitle).toBe(1);
    await expect(
      savePackagingEdits(owner.id, id, {
        ...saved,
        titles: [""],
        hooks: [],
        conceptHeadlines: [],
        selectedTitle: 0,
        selectedHook: 0,
      }),
    ).rejects.toThrow(/at least one title/);
  });

  it("one preferred version per target; deleting a version", async () => {
    const video = await readyVideo(owner.id);
    const first = await startPackaging(owner.id, "video", video.id, null);
    await finishPackaging();
    const second = await startPackaging(owner.id, "video", video.id, null);
    await finishPackaging();
    await setPreferredPackaging(owner.id, first.id);
    await setPreferredPackaging(owner.id, second.id);
    const sets = await listPackagingSets(owner.id, "video", video.id);
    expect(sets.filter((s) => s.preferred).map((s) => s.id)).toEqual([second.id]);
    const summary = (await listPackagingTargets(owner.id)).find((t) => t.id === video.id);
    expect(summary).toMatchObject({ sets: 2, preferredTitle: "Edit Faster With bTranscripts/b", lastStatus: "ready" });
    await expect(setPreferredPackaging(stranger.id, first.id)).rejects.toThrow("Packaging not found.");
    await deletePackagingSet(owner.id, first.id);
    expect(await listPackagingSets(owner.id, "video", video.id)).toHaveLength(1);
  });

  it("explains failures from the worker", async () => {
    const video = await readyVideo(owner.id);
    await startPackaging(owner.id, "video", video.id, null);
    const job = await claimNextJob("w1", ["ai.package"]);
    await failJob(job!.id, "w1", {
      code: "LLM_CREDENTIALS",
      message: "The server rejected the API key.",
      retryable: false,
    });
    const [set] = await listPackagingSets(owner.id, "video", video.id);
    expect(set).toMatchObject({ status: "failed", error: "The server rejected the API key." });
  });
});

describe("thumbnails (PKG-06)", () => {
  it("queues frames and mock-ups at the right size, inside the Short", async () => {
    const video = await readyVideo(owner.id);
    const mockup = await requestThumbnail(owner.id, "video", video.id, {
      mode: "mockup",
      frameMs: 4000,
      headline: "Edit in seconds every single day <b>",
      packagingSetId: null,
    });
    expect(mockup).toMatchObject({
      origin: "mockup",
      status: "processing",
      width: 1280,
      height: 720,
      headline: "Edit in seconds every single",
    });
    const job = await db.job.findFirstOrThrow({ where: { entityId: mockup.id } });
    expect(JSON.parse(job.payloadJson)).toMatchObject({
      mode: "mockup",
      outputPath: `thumbnails/${mockup.id}.jpg`,
      frameMs: 4000,
      sourcePath: `videos/${video.id}/source.mp4`,
    });
    await expect(
      requestThumbnail(owner.id, "video", video.id, {
        mode: "mockup",
        frameMs: 0,
        headline: " ",
        packagingSetId: null,
      }),
    ).rejects.toThrow(/Write a headline/);

    const short = await db.short.create({
      data: { userId: owner.id, videoId: video.id, title: "S", startMs: 30_000, endMs: 60_000, captionStyleJson: "{}" },
    });
    const frame = await requestThumbnail(owner.id, "short", short.id, {
      mode: "frame",
      frameMs: 5_000, // before the Short: moved inside it
      headline: null,
      packagingSetId: null,
    });
    expect(frame).toMatchObject({ width: 720, height: 1280, sourceFrameMs: 30_000 });
  });

  it("accepts only JPEG/PNG uploads and stores the worker's re-encoded file for the owner", async () => {
    const video = await readyVideo(owner.id);
    await expect(
      uploadThumbnail(owner.id, "video", video.id, new TextEncoder().encode("not an image")),
    ).rejects.toThrow(/Only JPEG and PNG/);
    await expect(uploadThumbnail(owner.id, "video", video.id, new Uint8Array())).rejects.toThrow(/empty/);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const uploaded = await uploadThumbnail(owner.id, "video", video.id, png);
    expect(fs.existsSync(resolveStoragePath(`thumbnails/uploads/${uploaded.id}.upload`))).toBe(true);

    const job = await claimNextJob("w1", ["media.thumbnail_mockup"]);
    expect(JSON.parse(JSON.stringify(job!.payload))).toMatchObject({ mode: "upload" });
    fs.mkdirSync(resolveStoragePath("thumbnails"), { recursive: true });
    fs.writeFileSync(resolveStoragePath(`thumbnails/${uploaded.id}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    await completeJob(job!.id, "w1", {
      outputPath: `thumbnails/${uploaded.id}.jpg`,
      width: 1280,
      height: 720,
      sizeBytes: 6,
      headline: null,
    });
    const [view] = await listThumbnails(owner.id, "video", video.id);
    expect(view).toMatchObject({ id: uploaded.id, status: "ready", origin: "upload" });
    expect(view.url).toMatch(`/api/media/thumbnails/${uploaded.id}`);
    expect((await getThumbnailFile(owner.id, uploaded.id)).contentType).toBe("image/jpeg");
    await expect(getThumbnailFile(stranger.id, uploaded.id)).rejects.toThrow("Thumbnail not found.");
    await selectThumbnail(owner.id, uploaded.id);
    expect((await listThumbnails(owner.id, "video", video.id))[0].selected).toBe(true);
    await expect(uploadThumbnail(stranger.id, "video", video.id, png)).rejects.toThrow("Not found.");
  });

  it("refuses results for a different path", async () => {
    const video = await readyVideo(owner.id);
    const thumbnail = await requestThumbnail(owner.id, "video", video.id, {
      mode: "frame",
      frameMs: 1000,
      headline: null,
      packagingSetId: null,
    });
    const job = await claimNextJob("w1", ["media.thumbnail_mockup"]);
    await expect(
      completeJob(job!.id, "w1", {
        outputPath: "videos/x/poster.jpg",
        width: 1280,
        height: 720,
        sizeBytes: 5,
        headline: null,
      }),
    ).rejects.toThrow();
    expect((await listThumbnails(owner.id, "video", video.id)).find((t) => t.id === thumbnail.id)?.status).not.toBe(
      "ready",
    );
  });

  it("deleting a Short or video removes its packaging and thumbnail files", async () => {
    const video = await readyVideo(owner.id);
    const short = await db.short.create({
      data: { userId: owner.id, videoId: video.id, title: "S", startMs: 0, endMs: 10_000, captionStyleJson: "{}" },
    });
    const shortThumb = await db.thumbnail.create({
      data: {
        userId: owner.id,
        shortId: short.id,
        origin: "frame",
        status: "ready",
        width: 720,
        height: 1280,
        filePath: "x",
      },
    });
    const videoThumb = await db.thumbnail.create({
      data: {
        userId: owner.id,
        videoId: video.id,
        origin: "frame",
        status: "ready",
        width: 1280,
        height: 720,
        filePath: "y",
      },
    });
    fs.mkdirSync(resolveStoragePath("thumbnails"), { recursive: true });
    for (const id of [shortThumb.id, videoThumb.id]) fs.writeFileSync(resolveStoragePath(`thumbnails/${id}.jpg`), "x");
    await db.packagingSet.create({ data: { userId: owner.id, shortId: short.id, status: "ready" } });

    await deleteShort(owner.id, short.id);
    expect(fs.existsSync(resolveStoragePath(`thumbnails/${shortThumb.id}.jpg`))).toBe(false);
    expect(await db.packagingSet.count({ where: { shortId: short.id } })).toBe(0);
    expect(fs.existsSync(resolveStoragePath(`thumbnails/${videoThumb.id}.jpg`))).toBe(true);

    await deleteVideo(owner.id, video.id);
    expect(fs.existsSync(resolveStoragePath(`thumbnails/${videoThumb.id}.jpg`))).toBe(false);
    expect(await db.thumbnail.count({ where: { id: videoThumb.id } })).toBe(0);
  });
});
