import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { claimNextJob, completeJob, failJob } from "@/server/jobs/queue";
import {
  approveScript,
  chooseLibraryClip,
  chooseStockCandidate,
  createProject,
  deleteProject,
  findFootage,
  getProject,
  getSceneAudioFile,
  narrateScenes,
  type ProjectSettings,
  saveScript,
  startRender,
  startScript,
  uploadSceneClip,
} from "@/server/services/generator";
import { getPublishForm } from "@/server/services/youtube";
import { resolveStoragePath } from "@/server/storage";
import { createTestUser, fakeMp4, streamOf } from "../support/fixtures";

type RenderPayload = {
  videoId: string;
  outputPath: string;
  credits: string;
  scenes: unknown[];
  captions: { startMs: number }[];
  captionStyle: { fontSize: number };
};

let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

const SETTINGS: ProjectSettings = {
  topic: "Why the ocean is salty",
  niche: "science",
  audience: "curious teenagers",
  tone: "friendly",
  notes: null,
  targetDurationSec: 30,
  aspectRatio: "9:16",
  resolution: 720,
  voice: null,
  voiceRate: 0,
  captionsEnabled: true,
  quality: "standard",
  musicVolumeDb: -18,
};

const SCRIPT_RESULT = {
  provider: "openai_compatible",
  model: "test-model",
  title: "Why is the sea salty?",
  hook: "Ever tasted the sea?",
  scenes: [
    {
      narration: "Rain slowly breaks down rocks on land.",
      visualQuery: "rain on rocks",
      onScreenText: null,
      estimatedMs: 2800,
    },
    {
      narration: "Rivers carry the salt into the sea.",
      visualQuery: "river flowing",
      onScreenText: "Rivers",
      estimatedMs: 2800,
    },
  ],
  wordCount: 15,
  targetWords: 75,
  warnings: ["The script has 15 words; about 75 fit 30 seconds."],
};

async function setAiProvider(userId: string, llmProvider: string) {
  await db.userSettings.upsert({ where: { userId }, create: { userId, llmProvider }, update: { llmProvider } });
}

async function finish(type: string, result: unknown) {
  const job = await claimNextJob("w1", [type]);
  expect(job, `a queued ${type} job`).not.toBeNull();
  await completeJob(job!.id, "w1", result);
  return job!;
}

function writeFile(relativePath: string, bytes: Buffer) {
  const target = resolveStoragePath(relativePath);
  fs.mkdirSync(target.slice(0, Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"))), { recursive: true });
  fs.writeFileSync(target, bytes);
}

/** A project with an approved two-scene script whose narration has been recorded. */
async function narratedProject() {
  await setAiProvider(owner.id, "openai_compatible");
  const { id } = await createProject(owner.id, SETTINGS);
  await finish("gen.script", SCRIPT_RESULT);
  const { notes } = await approveScript(owner.id, id);
  const job = await claimNextJob("w1", ["gen.narrate"]);
  const payload = job!.payload as { scenes: { id: string; text: string; outputPath: string }[] };
  for (const scene of payload.scenes) writeFile(scene.outputPath, Buffer.from("RIFF....WAVE"));
  await completeJob(job!.id, "w1", {
    provider: "sapi",
    voice: "Microsoft Zira Desktop",
    scenes: payload.scenes.map((scene, index) => ({
      id: scene.id,
      audioPath: scene.outputPath,
      durationMs: 2000 + index * 500,
      words: [
        [100, 600, scene.text.split(" ")[0]],
        [600, 1400, scene.text.split(" ")[1]],
      ],
      timing: "engine",
    })),
    failed: [],
  });
  return { id, notes, payload };
}

async function readyLibraryVideo(userId: string) {
  const video = await db.video.create({
    data: {
      userId,
      title: "My B-roll",
      originalFilename: "broll.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(2048),
      container: "mp4",
      status: "ready",
      durationMs: 60_000,
      width: 1920,
      height: 1080,
    },
  });
  writeFile(`videos/${video.id}/source.mp4`, fakeMp4(2048));
  return db.video.update({ where: { id: video.id }, data: { sourcePath: `videos/${video.id}/source.mp4` } });
}

beforeAll(async () => {
  owner = await createTestUser("gen-owner");
  stranger = await createTestUser("gen-stranger");
});

beforeEach(async () => {
  await db.job.deleteMany();
  await db.generatorProject.deleteMany();
});

describe("brief and script (GEN-01, GEN-02)", () => {
  it("keeps the project as a draft with an explanation when no AI is ready, and never queues a job", async () => {
    await setAiProvider(owner.id, "none");
    const { id, scriptError } = await createProject(owner.id, SETTINGS);
    expect(scriptError).toMatch(/needs an AI model/);
    const project = await getProject(owner.id, id);
    expect(project).toMatchObject({ status: "draft", error: scriptError });
    expect(await db.job.count()).toBe(0);
  });

  it("queues the script with the brief and stores the scenes it returns", async () => {
    await setAiProvider(owner.id, "openai_compatible");
    const { id, scriptError } = await createProject(owner.id, SETTINGS);
    expect(scriptError).toBeNull();
    expect((await getProject(owner.id, id))?.status).toBe("scripting");
    const job = await finish("gen.script", SCRIPT_RESULT);
    expect(job.payload).toMatchObject({
      projectId: id,
      topic: "Why the ocean is salty",
      niche: "Science",
      durationSec: 30,
      aspectRatio: "9:16",
      provider: "openai_compatible",
    });
    const project = await getProject(owner.id, id);
    expect(project).toMatchObject({ status: "editing", title: "Why is the sea salty?", hook: "Ever tasted the sea?" });
    expect(project?.script).toMatchObject({ approved: false, model: "test-model", warnings: SCRIPT_RESULT.warnings });
    expect(project?.scenes.map((scene) => scene.visualQuery)).toEqual(["rain on rocks", "river flowing"]);
    expect(project?.renderBlocked).toBe("Review and approve the script first.");
  });

  it("returns to a draft with the reason when writing the script fails", async () => {
    await setAiProvider(owner.id, "openai_compatible");
    const { id } = await createProject(owner.id, SETTINGS);
    const job = await claimNextJob("w1", ["gen.script"]);
    await failJob(job!.id, "w1", {
      code: "LLM_BAD_OUTPUT",
      message: "The AI model didn't return a usable script.",
      retryable: false,
    });
    expect(await getProject(owner.id, id)).toMatchObject({
      status: "draft",
      error: "The AI model didn't return a usable script.",
    });
  });

  it("saves edits, reorders and adds scenes while keeping existing scenes' ids", async () => {
    await setAiProvider(owner.id, "openai_compatible");
    const { id } = await createProject(owner.id, SETTINGS);
    await finish("gen.script", SCRIPT_RESULT);
    const [first, second] = (await getProject(owner.id, id))!.scenes;
    await saveScript(owner.id, id, {
      title: "The salty sea",
      hook: null,
      scenes: [
        { id: second.id, narration: "Rivers carry salt.", visualQuery: "river", onScreenText: null },
        { id: null, narration: "The sun leaves the salt behind.", visualQuery: "sun over sea", onScreenText: null },
        { id: first.id, narration: first.narration, visualQuery: first.visualQuery, onScreenText: null },
      ],
    });
    const project = await getProject(owner.id, id);
    expect(project?.title).toBe("The salty sea");
    expect(project?.scenes.map((scene) => scene.id)).toEqual([second.id, expect.any(String), first.id]);
    expect(project?.scenes[1].narration).toBe("The sun leaves the salt behind.");
  });

  it("can't touch another user's project", async () => {
    await setAiProvider(owner.id, "openai_compatible");
    const { id } = await createProject(owner.id, SETTINGS);
    expect(await getProject(stranger.id, id)).toBeNull();
    await expect(startScript(stranger.id, id)).rejects.toThrow("Project not found.");
    await expect(deleteProject(stranger.id, id)).rejects.toThrow("Project not found.");
  });
});

describe("narration and footage (GEN-03, GEN-04, GEN-08)", () => {
  it("approving starts narration and explains how to get footage without a stock key", async () => {
    const { id, notes, payload } = await narratedProject();
    expect(notes.join(" ")).toMatch(/No stock video provider is set up/);
    expect(payload.scenes[0].outputPath).toMatch(new RegExp(`^generator/${id}/narration/.+\\.wav$`));
    const project = await getProject(owner.id, id);
    expect(project?.scenes.map((scene) => scene.narration_.status)).toEqual(["ready", "ready"]);
    expect(project?.scenes[1].narration_).toMatchObject({ durationMs: 2500, timing: "engine", stale: false });
    expect((await getSceneAudioFile(owner.id, project!.scenes[0].id)).contentType).toBe("audio/wav");
    await expect(getSceneAudioFile(stranger.id, project!.scenes[0].id)).rejects.toThrow("Scene not found.");
  });

  it("refuses to search stock footage without a key and says how to get one (GEN-08)", async () => {
    const { id } = await narratedProject();
    await expect(findFootage(owner.id, id, null)).rejects.toThrow(/free Pexels API key at pexels.com\/api/);
  });

  it("keeps going when one scene's narration fails, and marks edited narration out of date", async () => {
    await setAiProvider(owner.id, "openai_compatible");
    const { id } = await createProject(owner.id, SETTINGS);
    await finish("gen.script", SCRIPT_RESULT);
    await approveScript(owner.id, id);
    const job = await claimNextJob("w1", ["gen.narrate"]);
    const payload = job!.payload as { scenes: { id: string; text: string; outputPath: string }[] };
    writeFile(payload.scenes[0].outputPath, Buffer.from("RIFF"));
    await completeJob(job!.id, "w1", {
      provider: "sapi",
      voice: null,
      scenes: [
        {
          id: payload.scenes[0].id,
          audioPath: payload.scenes[0].outputPath,
          durationMs: 1800,
          words: [],
          timing: "estimated",
        },
      ],
      failed: [{ id: payload.scenes[1].id, error: "The Windows voice failed: simulated" }],
    });
    let project = await getProject(owner.id, id);
    expect(project?.scenes[1].narration_).toMatchObject({
      status: "failed",
      error: "The Windows voice failed: simulated",
    });

    const [first, second] = project!.scenes;
    await saveScript(owner.id, id, {
      title: "t",
      hook: null,
      scenes: [
        { id: first.id, narration: "Rain breaks down rocks.", visualQuery: "rain", onScreenText: null },
        { id: second.id, narration: second.narration, visualQuery: "river", onScreenText: null },
      ],
    });
    project = await getProject(owner.id, id);
    expect(project?.scenes[0].narration_.stale).toBe(true);
    expect(project?.renderBlocked).toMatch(/scene 1's narration is out of date.*scene 2 has no narration/);
    expect(await narrateScenes(owner.id, id, null)).toBe(2); // the stale one and the failed one
  });

  it("stores stock suggestions, picks the downloaded best one and lets the creator swap", async () => {
    const { id } = await narratedProject();
    const [scene] = (await getProject(owner.id, id))!.scenes;
    // The search is queued by the worker side here (no key in tests), so add the job as the app would.
    await db.job.create({
      data: {
        userId: owner.id,
        type: "gen.footage",
        payloadJson: JSON.stringify({
          projectId: id,
          orientation: "portrait",
          scenes: [{ id: scene.id, query: "rain", minDurationMs: 2000 }],
        }),
        entityType: "generator",
        entityId: id,
      },
    });
    const candidate = (assetId: string, filePath: string | null) => ({
      provider: "pexels",
      providerAssetId: assetId,
      pageUrl: `https://www.pexels.com/video/${assetId}/`,
      creatorName: `Creator ${assetId}`,
      creatorUrl: null,
      downloadUrl: `https://videos.pexels.com/video-files/${assetId}/hd.mp4`,
      previewImageUrl: null,
      width: 720,
      height: 1280,
      durationMs: 9000,
      licenseName: "Pexels License",
      filePath,
    });
    writeFile("stock-cache/pexels/11.mp4", fakeMp4(1024));
    await finish("gen.footage", {
      providers: ["pexels"],
      scenes: [
        {
          id: scene.id,
          candidates: [candidate("11", "stock-cache/pexels/11.mp4"), candidate("12", null)],
          warnings: [],
        },
      ],
      failed: [],
    });
    let project = await getProject(owner.id, id);
    expect(project?.scenes[0].footage).toMatchObject({ status: "ready", source: "stock" });
    expect(project?.scenes[0].footage.chosen?.label).toBe("Pexels clip by Creator 11");
    expect(project?.scenes[0].footage.candidates.map((c) => c.chosen)).toEqual([true, false]);

    await chooseStockCandidate(owner.id, scene.id, "12");
    project = await getProject(owner.id, id);
    expect(project?.scenes[0].footage.chosen).toMatchObject({ providerAssetId: "12", previewUrl: null });
    await expect(chooseStockCandidate(owner.id, scene.id, "99")).rejects.toThrow(/isn't one of this scene's/);
  });

  it("refuses an upload that isn't a video", async () => {
    const { id } = await narratedProject();
    const [scene] = (await getProject(owner.id, id))!.scenes;
    await expect(
      uploadSceneClip(owner.id, scene.id, "mp4", streamOf(Buffer.from("not a video at all"))),
    ).rejects.toThrow(/doesn't look like a .mp4 video/);
    await uploadSceneClip(owner.id, scene.id, "mp4", streamOf(fakeMp4(4096)));
    expect((await getProject(owner.id, id))?.scenes[0].footage).toMatchObject({ source: "upload", status: "ready" });
  });
});

describe("rendering and the library (GEN-05, GEN-06, GEN-07)", () => {
  it("won't render until every scene has narration and footage", async () => {
    const { id } = await narratedProject();
    await expect(startRender(owner.id, id)).rejects.toThrow(
      "Before rendering: scene 1 has no footage, scene 2 has no footage.",
    );
  });

  it("a double click on Render queues exactly one render (Phase 10)", async () => {
    const { id } = await narratedProject();
    const library = await readyLibraryVideo(owner.id);
    for (const scene of (await getProject(owner.id, id))!.scenes) {
      await chooseLibraryClip(owner.id, scene.id, { videoId: library.id, startMs: 0 });
    }
    const results = await Promise.allSettled([startRender(owner.id, id), startRender(owner.id, id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(await db.job.count({ where: { type: "gen.render", entityId: id } })).toBe(1);
  });

  it("renders with timed captions and credits, then adds a generated video to the library", async () => {
    const { id } = await narratedProject();
    const library = await readyLibraryVideo(owner.id);
    const [first, second] = (await getProject(owner.id, id))!.scenes;
    await chooseLibraryClip(owner.id, first.id, { videoId: library.id, startMs: 5000 });
    await uploadSceneClip(owner.id, second.id, "mp4", streamOf(fakeMp4(4096)));
    await expect(chooseLibraryClip(stranger.id, first.id, { videoId: library.id, startMs: 0 })).rejects.toThrow(
      "Scene not found.",
    );

    await startRender(owner.id, id);
    expect((await getProject(owner.id, id))?.status).toBe("rendering");
    const job = await claimNextJob("w1", ["gen.render"]);
    const payload = job!.payload as RenderPayload;
    expect(payload).toMatchObject({ width: 720, height: 1280, transitionMs: 400, music: null, quality: "standard" });
    expect(payload.outputPath).toBe(`videos/${payload.videoId}/source.mp4`);
    expect(payload.scenes).toEqual([
      expect.objectContaining({ number: 1, durationMs: 2000, footage: { path: library.sourcePath, startMs: 5000 } }),
      expect.objectContaining({ number: 2, durationMs: 2500, footage: expect.objectContaining({ startMs: 0 }) }),
    ]);
    // Scene 2's words start after scene 1's narration (2000 ms).
    expect(payload.captions.map((c) => c.startMs)).toEqual([100, 2100]);
    expect(payload.captionStyle.fontSize).toBeLessThan(80);
    expect(payload.credits).toContain("Some footage is the creator's own.");
    expect(payload.credits).toContain("Narration: synthetic voice");

    writeFile(payload.outputPath, fakeMp4(8192));
    await completeJob(job!.id, "w1", {
      outputPath: payload.outputPath,
      durationMs: 4900,
      width: 720,
      height: 1280,
      sizeBytes: 8192,
      elapsedMs: 3000,
    });
    const project = await getProject(owner.id, id);
    expect(project).toMatchObject({ status: "ready", error: null, creditsText: payload.credits });
    const video = await db.video.findUniqueOrThrow({ where: { id: payload.videoId } });
    expect(video).toMatchObject({
      sourceType: "generated",
      status: "processing",
      creditsText: payload.credits,
      userId: owner.id,
    });
    expect(await db.job.count({ where: { type: "media.ingest", entityId: video.id } })).toBe(1);

    // GEN-06/07: publishing suggests the disclosure and appends the credits.
    await db.video.update({ where: { id: video.id }, data: { status: "ready" } });
    const form = await getPublishForm(owner.id, "video", video.id);
    expect(form?.prefill).toMatchObject({ containsSyntheticMedia: true, creditsAdded: true });
    expect(form?.prefill.description).toContain("Narration: synthetic voice");
    const uploaded = await getPublishForm(owner.id, "video", library.id);
    expect(uploaded?.prefill).toMatchObject({ containsSyntheticMedia: null, creditsAdded: false });

    // Deleting the project keeps the rendered video.
    await deleteProject(owner.id, id);
    expect(await db.video.count({ where: { id: video.id } })).toBe(1);
    expect(fs.existsSync(resolveStoragePath(`generator/${id}`))).toBe(false);
  });

  it("goes back to editing with the reason when rendering fails, and removes the partial output", async () => {
    const { id } = await narratedProject();
    const library = await readyLibraryVideo(owner.id);
    for (const scene of (await getProject(owner.id, id))!.scenes) {
      await chooseLibraryClip(owner.id, scene.id, { videoId: library.id, startMs: 0 });
    }
    await startRender(owner.id, id);
    const job = await claimNextJob("w1", ["gen.render"]);
    const payload = job!.payload as RenderPayload;
    writeFile(`videos/${payload.videoId}/source.partial.mp4`, fakeMp4(100));
    await failJob(job!.id, "w1", {
      code: "SCENE_FOOTAGE",
      message: "Fix the footage first — scene 2: the footage doesn't move (still images aren't allowed).",
      retryable: false,
    });
    expect(await getProject(owner.id, id)).toMatchObject({
      status: "editing",
      error: "Fix the footage first — scene 2: the footage doesn't move (still images aren't allowed).",
    });
    expect(fs.existsSync(resolveStoragePath(`videos/${payload.videoId}`))).toBe(false);
    expect(await db.video.count({ where: { id: payload.videoId } })).toBe(0);
  });
});
