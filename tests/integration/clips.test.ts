import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { claimNextJob, completeJob } from "@/server/jobs/queue";
import {
  createManualClip,
  listClips,
  listClipsForVideo,
  setClipStatus,
  startClipAnalysis,
  updateClipRange,
} from "@/server/services/clips";
import { startTranscription } from "@/server/services/transcripts";
import { resolveStoragePath } from "@/server/storage";
import { createTestUser, fakeMp4 } from "../support/fixtures";

const SEGMENTS = [
  {
    startMs: 1000,
    endMs: 2600,
    text: "Did you know this?",
    words: [
      [1000, 1300, "Did"],
      [1350, 1600, "you"],
      [1650, 2000, "know"],
      [2050, 2600, "this?"],
    ],
  },
  { startMs: 4000, endMs: 4400, text: "Yes.", words: [[4000, 4400, "Yes."]] },
  {
    startMs: 6000,
    endMs: 9000,
    text: "Transcripts make editing much faster.",
    words: [
      [6000, 6800, "Transcripts"],
      [6850, 7200, "make"],
      [7250, 7900, "editing"],
      [7950, 8400, "much"],
      [8450, 9000, "faster."],
    ],
  },
];

let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

/** A ready video with a real transcript file in storage. */
async function videoWithTranscript(userId: string, options: { audio?: boolean } = {}) {
  const video = await db.video.create({
    data: {
      userId,
      title: "Talk",
      originalFilename: "talk.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(100),
      container: "mp4",
      status: "ready",
      durationMs: 10_000,
      audioCodec: options.audio === false ? null : "aac",
    },
  });
  const dir = `videos/${video.id}`;
  fs.mkdirSync(resolveStoragePath(dir), { recursive: true });
  fs.writeFileSync(resolveStoragePath(`${dir}/source.mp4`), fakeMp4(100));
  const transcriptPath = `${dir}/transcript.json`;
  fs.writeFileSync(
    resolveStoragePath(transcriptPath),
    JSON.stringify({
      version: 1,
      provider: "faster-whisper",
      model: "base",
      language: "en",
      languageProbability: 1,
      durationMs: 10_000,
      segments: SEGMENTS,
    }),
  );
  await db.video.update({ where: { id: video.id }, data: { sourcePath: `${dir}/source.mp4` } });
  await db.transcript.create({
    data: {
      videoId: video.id,
      status: "ready",
      provider: "faster-whisper",
      model: "base",
      filePath: transcriptPath,
      wordCount: 10,
    },
  });
  return video;
}

const aiClip = (startMs: number, endMs: number, extra: Record<string, unknown> = {}) => ({
  startMs,
  endMs,
  score: 77,
  heuristicScore: 60,
  aiScore: 85,
  title: "Did you know?",
  hook: "Did you know this?",
  reason: "A question that makes people curious.",
  category: "surprising_fact",
  transcriptText: "Did you know this?",
  ...extra,
});

async function runAnalysisJob(result: Record<string, unknown>) {
  const claimed = await claimNextJob("w1", ["ai.find_clips"]);
  expect(claimed).not.toBeNull();
  await completeJob(claimed!.id, "w1", result);
}

beforeAll(async () => {
  owner = await createTestUser("clips-owner");
  stranger = await createTestUser("clips-stranger");
});

beforeEach(async () => {
  await db.job.deleteMany();
});

describe("starting clip analysis (CLIP-04/08)", () => {
  it("needs a ready transcript", async () => {
    const video = await videoWithTranscript(owner.id);
    await db.transcript.update({ where: { videoId: video.id }, data: { status: "processing" } });
    await expect(startClipAnalysis(owner.id, video.id, "heuristic")).rejects.toThrow(/Transcribe the video first/);
  });

  it("queues speech-pattern ranking without any AI provider", async () => {
    const video = await videoWithTranscript(owner.id);
    await startClipAnalysis(owner.id, video.id, "heuristic");
    const job = await db.job.findFirstOrThrow({ where: { entityId: video.id, type: "ai.find_clips" } });
    expect(JSON.parse(job.payloadJson)).toMatchObject({ mode: "heuristic", provider: null });
  });

  it("refuses AI mode when the provider isn't ready, explaining the fix (missing credentials)", async () => {
    const video = await videoWithTranscript(owner.id);
    await db.userSettings.upsert({
      where: { userId: owner.id },
      create: { userId: owner.id, llmProvider: "gemini" },
      update: { llmProvider: "gemini" },
    });
    await expect(startClipAnalysis(owner.id, video.id, "ai")).rejects.toThrow(/Gemini.*No API key.*aistudio/);
    // Ollama in tests points at a closed port.
    await db.userSettings.update({ where: { userId: owner.id }, data: { llmProvider: "ollama" } });
    await expect(startClipAnalysis(owner.id, video.id, "ai")).rejects.toThrow(/Ollama/);
    await db.userSettings.update({ where: { userId: owner.id }, data: { llmProvider: "none" } });
    await expect(startClipAnalysis(owner.id, video.id, "ai")).rejects.toThrow(/AI is turned off/);
    expect(await db.job.count({ where: { entityId: video.id } })).toBe(0);
  });

  it("won't start twice at once, and is private to the owner", async () => {
    const video = await videoWithTranscript(owner.id);
    await startClipAnalysis(owner.id, video.id, "heuristic");
    await expect(startClipAnalysis(owner.id, video.id, "heuristic")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(startClipAnalysis(stranger.id, video.id, "heuristic")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("saving analysis results", () => {
  it("stores AI suggestions with their model, replacing old suggestions but keeping accepted and manual clips", async () => {
    const video = await videoWithTranscript(owner.id);
    const keptAccepted = await db.clipCandidate.create({
      data: {
        videoId: video.id,
        startMs: 6000,
        endMs: 9000,
        transcriptText: "x",
        title: "Kept",
        origin: "ai",
        status: "accepted",
      },
    });
    const keptManual = await createManualClip(owner.id, video.id, { startMs: 6000, endMs: 9000 });
    await db.clipCandidate.create({
      data: { videoId: video.id, startMs: 1000, endMs: 2600, transcriptText: "x", title: "Old", origin: "heuristic" },
    });

    await startClipAnalysis(owner.id, video.id, "heuristic");
    await runAnalysisJob({
      mode: "ai",
      provider: "ollama",
      model: "qwen2.5:1.5b",
      clips: [aiClip(850, 2850)],
      analysedCandidates: 4,
      ratedCandidates: 4,
      failedBatches: 0,
      warnings: [],
    });

    const clips = await listClipsForVideo(owner.id, video.id);
    expect(clips.map((c) => c.title).sort()).toEqual(["Did you know?", "Kept", keptManual.title].sort());
    const ai = clips.find((c) => c.origin === "ai" && c.status === "suggested")!;
    expect(ai).toMatchObject({ provider: "ollama", model: "qwen2.5:1.5b", aiScore: 85, category: "surprising_fact" });
    expect(clips.some((c) => c.id === keptAccepted.id)).toBe(true);
  });

  it("rejects results that claim AI without naming the model, or reach past the video's end", async () => {
    const video = await videoWithTranscript(owner.id);
    for (const result of [
      { mode: "ai", provider: null, model: null, clips: [aiClip(850, 2850)] },
      { mode: "heuristic", provider: null, model: null, clips: [aiClip(850, 2850)] }, // aiScore on a non-AI result
      { mode: "ai", provider: "ollama", model: "m", clips: [aiClip(8000, 60_000)] },
    ]) {
      await startClipAnalysis(owner.id, video.id, "heuristic");
      await expect(
        runAnalysisJob({ ...result, analysedCandidates: 1, ratedCandidates: 1, failedBatches: 0, warnings: [] }),
      ).rejects.toThrow();
      await db.job.deleteMany();
    }
    expect(await db.clipCandidate.count({ where: { videoId: video.id } })).toBe(0);
  });
});

describe("reviewing clips (CLIP-06)", () => {
  it("snaps adjusted timings to whole words and updates the transcript text", async () => {
    const video = await videoWithTranscript(owner.id);
    const clip = await createManualClip(owner.id, video.id, { startMs: 1000, endMs: 2600 });
    const adjusted = await updateClipRange(owner.id, clip.id, { startMs: 1500, endMs: 8000 });
    expect(adjusted.startMs).toBeGreaterThanOrEqual(1300);
    expect(adjusted.startMs).toBeLessThanOrEqual(1350);
    expect(adjusted.endMs).toBeGreaterThanOrEqual(8400);
    expect(adjusted.transcriptText).toBe("you know this? Yes. Transcripts make editing much");
  });

  it("manual clips are labelled as yours, not AI", async () => {
    const video = await videoWithTranscript(owner.id);
    const clip = await createManualClip(owner.id, video.id, { startMs: 6000, endMs: 9000 });
    expect(clip).toMatchObject({
      origin: "manual",
      score: null,
      aiScore: null,
      provider: null,
      title: "Transcripts make editing much faster.",
    });
  });

  it("accepting sends a clip to the Shorts Editor queue; rejecting removes it", async () => {
    const video = await videoWithTranscript(owner.id);
    const clip = await createManualClip(owner.id, video.id, { startMs: 6000, endMs: 9000 });
    await setClipStatus(owner.id, clip.id, "accepted");
    expect((await listClips(owner.id, { status: "accepted" })).map((c) => c.id)).toContain(clip.id);
    await setClipStatus(owner.id, clip.id, "rejected");
    expect((await listClips(owner.id, { status: "accepted" })).map((c) => c.id)).not.toContain(clip.id);
  });

  it("keeps other users out of clips", async () => {
    const video = await videoWithTranscript(owner.id);
    const clip = await createManualClip(owner.id, video.id, { startMs: 6000, endMs: 9000 });
    await expect(setClipStatus(stranger.id, clip.id, "accepted")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(updateClipRange(stranger.id, clip.id, { startMs: 0, endMs: 3000 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(createManualClip(stranger.id, video.id, { startMs: 0, endMs: 3000 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(listClipsForVideo(stranger.id, video.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listClips(stranger.id)).toEqual([]);
  });
});

describe("transcription (CLIP-01)", () => {
  it("refuses videos without audio and queues others with the owner's language", async () => {
    const silent = await videoWithTranscript(owner.id, { audio: false });
    await expect(startTranscription(owner.id, silent.id)).rejects.toThrow(/no audio track/);

    const video = await videoWithTranscript(owner.id);
    await db.userSettings.upsert({
      where: { userId: owner.id },
      create: { userId: owner.id, defaultLanguage: "en" },
      update: { defaultLanguage: "en" },
    });
    await startTranscription(owner.id, video.id);
    const job = await db.job.findFirstOrThrow({ where: { entityId: video.id, type: "media.transcribe" } });
    expect(JSON.parse(job.payloadJson)).toMatchObject({
      language: "en",
      outputPath: `videos/${video.id}/transcript.json`,
    });
    expect((await db.transcript.findUniqueOrThrow({ where: { videoId: video.id } })).status).toBe("processing");
  });

  it("stores the finished transcript with its searchable text", async () => {
    const video = await videoWithTranscript(owner.id);
    await startTranscription(owner.id, video.id);
    const claimed = await claimNextJob("w1", ["media.transcribe"]);
    await completeJob(claimed!.id, "w1", {
      transcriptPath: `videos/${video.id}/transcript.json`,
      provider: "faster-whisper",
      model: "base",
      language: "en",
      languageProbability: 0.99,
      durationMs: 10_000,
      wordCount: 10,
      segmentCount: 3,
    });
    const transcript = await db.transcript.findUniqueOrThrow({ where: { videoId: video.id } });
    expect(transcript).toMatchObject({ status: "ready", language: "en", wordCount: 10 });
    expect(transcript.fullText).toBe("Did you know this? Yes. Transcripts make editing much faster.");
  });

  it("is queued automatically after processing when audio exists and the setting is on", async () => {
    for (const [autoTranscribe, expected] of [
      [true, 1],
      [false, 0],
    ] as const) {
      await db.userSettings.upsert({
        where: { userId: owner.id },
        create: { userId: owner.id, autoTranscribe },
        update: { autoTranscribe },
      });
      const video = await db.video.create({
        data: {
          userId: owner.id,
          title: "New",
          originalFilename: "n.mp4",
          sourcePath: "x",
          sizeBytes: BigInt(1),
          container: "mp4",
        },
      });
      await db.job.create({
        data: { userId: owner.id, type: "media.ingest", entityType: "video", entityId: video.id, payloadJson: "{}" },
      });
      const claimed = await claimNextJob("w1", ["media.ingest"]);
      await completeJob(claimed!.id, "w1", {
        durationMs: 10_000,
        width: 640,
        height: 360,
        fps: 25,
        videoCodec: "h264",
        audioCodec: "aac",
        posterPath: null,
        previewPath: null,
      });
      expect(await db.job.count({ where: { entityId: video.id, type: "media.transcribe" } })).toBe(expected);
    }
  });
});
