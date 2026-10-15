import "server-only";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { z } from "zod";
import type { GeneratorProject, GeneratorScene, Prisma, StockAsset } from "@/generated/prisma/client";
import {
  ACTIVE_JOB_STATUSES,
  ASPECT_RATIOS,
  type AspectRatio,
  EXPORT_QUALITIES,
  type ExportQuality,
  type FootageSource,
  GENERATOR_DURATIONS,
  GENERATOR_NICHE_IDS,
  GENERATOR_NICHES,
  GENERATOR_RESOLUTIONS,
  GENERATOR_TONES,
  type GeneratorStatus,
  type JobType,
} from "@/lib/constants";
import { type StockCandidate, stockCandidatesSchema, stockFilePath } from "@/lib/generator/stock";
import {
  type CreditSource,
  creditsText,
  estimateMs,
  frameCaptionStyle,
  frameSize,
  TRANSITION_MS,
  timelineCaptions,
  totalDurationMs,
  type WordTiming,
  wordTimingsSchema,
} from "@/lib/generator/timeline";
import { parseCaptionStyle } from "@/lib/shorts/caption-style";
import { recordAuditEvent } from "../audit";
import { db } from "../db";
import { getEnv } from "../env";
import { AppError } from "../errors";
import { upsertStockAsset } from "../jobs/gen-footage";
import { assertNoActiveJob, cancelJobsForEntity, enqueueJob } from "../jobs/queue";
import { logger } from "../logger";
import { removeStorageDir, resolveExistingStoragePath, resolveStoragePath, storageFileSize } from "../storage";
import { requireReadyAiProvider } from "./ai-providers";

/**
 * Original video generator (GEN-01…08, TECHNICAL_SPEC.md §7.7). Every query filters by `userId`.
 * Script, narration, footage search and rendering run in the media worker; this module validates,
 * queues and keeps the project consistent. Nothing here pretends a step worked: each scene shows
 * exactly which narration and footage it has.
 */

const ENTITY = "generator";
const WORKER_OFFLINE_AFTER_MS = 60_000;
export const SCENES_MAX = 40;
export const NARRATION_MAX_CHARS = 1500;
export const CLIP_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;
export const MUSIC_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const CLIP_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv"] as const;
export const MUSIC_EXTENSIONS = ["mp3", "wav", "m4a", "ogg"] as const;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

export const projectSettingsSchema = z.object({
  topic: z.string().trim().min(3, "Describe the topic in a few words.").max(200),
  niche: z.enum(GENERATOR_NICHE_IDS),
  audience: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value || null)
    .nullable(),
  tone: z.enum(GENERATOR_TONES),
  notes: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => value || null)
    .nullable(),
  targetDurationSec: z
    .number()
    .int()
    .refine((value) => (GENERATOR_DURATIONS as readonly number[]).includes(value)),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z
    .number()
    .int()
    .refine((value) => (GENERATOR_RESOLUTIONS as readonly number[]).includes(value)),
  voice: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || null)
    .nullable(),
  voiceRate: z.number().int().min(-5).max(5),
  captionsEnabled: z.boolean(),
  quality: z.enum(EXPORT_QUALITIES),
  musicVolumeDb: z.number().int().min(-40).max(0),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export const scriptDocSchema = z.object({
  title: z.string().trim().min(1, "Give the video a title.").max(100),
  hook: z
    .string()
    .trim()
    .max(300)
    .transform((value) => value || null)
    .nullable(),
  scenes: z
    .array(
      z.object({
        id: z.string().max(100).nullable(),
        narration: z.string().trim().min(1, "Every scene needs narration.").max(NARRATION_MAX_CHARS),
        visualQuery: z.string().trim().min(1, "Every scene needs footage keywords.").max(120),
        onScreenText: z
          .string()
          .trim()
          .max(120)
          .transform((value) => value || null)
          .nullable(),
      }),
    )
    .min(1, "Keep at least one scene.")
    .max(SCENES_MAX),
});
export type ScriptDoc = z.infer<typeof scriptDocSchema>;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type JobView = { id: string; type: JobType; status: string; progress: number; message: string | null };

export type SceneView = {
  id: string;
  order: number;
  narration: string;
  visualQuery: string;
  onScreenText: string | null;
  estimatedMs: number;
  narration_: {
    status: "none" | "processing" | "ready" | "failed";
    error: string | null;
    url: string | null;
    durationMs: number | null;
    timing: "engine" | "estimated" | null;
    /** The text changed after recording: narrate again. */
    stale: boolean;
  };
  footage: {
    status: "none" | "searching" | "ready" | "failed";
    error: string | null;
    source: FootageSource | null;
    startMs: number;
    /** What is chosen now (for the preview and the credits). */
    chosen: {
      label: string;
      previewUrl: string | null;
      durationMs: number | null;
      credit: string | null;
      pageUrl: string | null;
      providerAssetId: string | null;
    } | null;
    candidates: (StockCandidate & { chosen: boolean })[];
  };
};

export type GeneratorSetup = {
  workerOnline: boolean;
  tts: { provider: "sapi" | "kokoro"; voices: string[]; ready: boolean; problem: string | null };
  stock: { pexels: boolean; pixabay: boolean };
};

export type ProjectView = {
  id: string;
  status: GeneratorStatus;
  error: string | null;
  settings: ProjectSettings;
  title: string | null;
  hook: string | null;
  script: { provider: string | null; model: string | null; warnings: string[]; approved: boolean };
  scenes: SceneView[];
  music: { url: string; volumeDb: number } | null;
  jobs: JobView[];
  /** Why a render can't start yet (null = ready). */
  renderBlocked: string | null;
  estimatedDurationMs: number;
  output: {
    videoId: string;
    title: string;
    status: string;
    url: string;
    downloadUrl: string;
    durationMs: number | null;
    sizeBytes: number;
    renderedAt: string | null;
    elapsedMs: number | null;
  } | null;
  creditsText: string | null;
  updatedAt: string;
};

export type ProjectSummary = {
  id: string;
  topic: string;
  title: string | null;
  status: GeneratorStatus;
  aspectRatio: AspectRatio;
  targetDurationSec: number;
  sceneCount: number;
  outputVideoId: string | null;
  updatedAt: string;
};

function parseJson<T>(schema: z.ZodType<T>, json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function settingsOf(project: GeneratorProject): ProjectSettings {
  return {
    topic: project.topic,
    niche: projectSettingsSchema.shape.niche.catch("education").parse(project.niche),
    audience: project.audience,
    tone: projectSettingsSchema.shape.tone.catch("friendly").parse(project.tone),
    notes: project.notes,
    targetDurationSec: project.targetDurationSec,
    aspectRatio: project.aspectRatio as AspectRatio,
    resolution: project.resolution,
    voice: project.voice,
    voiceRate: project.voiceRate,
    captionsEnabled: project.captionsEnabled,
    quality: project.quality as ExportQuality,
    musicVolumeDb: project.musicVolumeDb,
  };
}

type SceneRow = GeneratorScene & {
  stockAsset: StockAsset | null;
  libraryVideo: { id: string; title: string; durationMs: number | null; userId: string } | null;
};

function narrationStale(scene: GeneratorScene): boolean {
  return Boolean(scene.audioPath && scene.narratedText !== null && scene.narratedText !== scene.narration);
}

function sceneView(scene: SceneRow): SceneView {
  const candidates = parseJson(stockCandidatesSchema, scene.candidatesJson, []);
  const source = scene.footageSource as FootageSource | null;
  let chosen: SceneView["footage"]["chosen"] = null;
  const media = `/api/generator/scenes/${scene.id}`;
  if (source === "stock" && scene.stockAsset) {
    const asset = scene.stockAsset;
    chosen = {
      label: `${asset.provider === "pexels" ? "Pexels" : "Pixabay"} clip by ${asset.creatorName}`,
      previewUrl: asset.downloadedAt ? `${media}/footage?v=${asset.id}` : null,
      durationMs: asset.durationMs,
      credit: `${asset.creatorName} · ${asset.licenseName}`,
      pageUrl: asset.pageUrl,
      providerAssetId: asset.providerAssetId,
    };
  } else if (source === "library" && scene.libraryVideo) {
    chosen = {
      label: `From your library: ${scene.libraryVideo.title}`,
      previewUrl: `/api/media/videos/${scene.libraryVideo.id}/playback`,
      durationMs: scene.libraryVideo.durationMs,
      credit: null,
      pageUrl: null,
      providerAssetId: null,
    };
  } else if (source === "upload" && scene.customClipPath) {
    chosen = {
      label: "Your uploaded clip",
      previewUrl: `${media}/footage?v=${scene.updatedAt.getTime()}`,
      durationMs: null,
      credit: null,
      pageUrl: null,
      providerAssetId: null,
    };
  }
  return {
    id: scene.id,
    order: scene.order,
    narration: scene.narration,
    visualQuery: scene.visualQuery,
    onScreenText: scene.onScreenText,
    estimatedMs: scene.estimatedMs ?? estimateMs(scene.narration),
    narration_: {
      status: scene.narrationStatus as SceneView["narration_"]["status"],
      error: scene.narrationError,
      url: scene.audioPath ? `${media}/audio?v=${encodeURIComponent(scene.audioPath)}` : null,
      durationMs: scene.audioDurationMs,
      timing: scene.timingSource as SceneView["narration_"]["timing"],
      stale: narrationStale(scene),
    },
    footage: {
      status: scene.footageStatus as SceneView["footage"]["status"],
      error: scene.footageError,
      source,
      startMs: scene.clipStartMs,
      chosen,
      candidates: candidates.map((candidate) => ({
        ...candidate,
        chosen:
          source === "stock" &&
          scene.stockAsset?.provider === candidate.provider &&
          scene.stockAsset.providerAssetId === candidate.providerAssetId,
      })),
    },
  };
}

async function activeJobs(projectId: string): Promise<JobView[]> {
  const jobs = await db.job.findMany({
    where: { entityType: ENTITY, entityId: projectId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, status: true, progress: true, progressMessage: true },
  });
  return jobs.map((job) => ({
    id: job.id,
    type: job.type as JobType,
    status: job.status,
    progress: job.progress,
    message: job.progressMessage,
  }));
}

const sceneInclude = {
  stockAsset: true,
  libraryVideo: { select: { id: true, title: true, durationMs: true, userId: true } },
} as const;

async function findOwnedProject(userId: string, projectId: string) {
  const project = await db.generatorProject.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  return project;
}

async function findOwnedScene(userId: string, sceneId: string) {
  const scene = await db.generatorScene.findFirst({
    where: { id: sceneId, project: { userId } },
    include: { ...sceneInclude, project: true },
  });
  if (!scene) throw new AppError("NOT_FOUND", "Scene not found.");
  return scene;
}

/** Python worker capabilities: installed voices and configured stock providers (runner.py). */
export async function getGeneratorSetup(): Promise<GeneratorSetup> {
  const env = getEnv();
  const stock = { pexels: Boolean(env.PEXELS_API_KEY), pixabay: Boolean(env.PIXABAY_API_KEY) };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  const workerOnline = Boolean(latest && Date.now() - latest.lastSeenAt.getTime() < WORKER_OFFLINE_AFTER_MS);
  const caps = parseJson(z.object({ tts: z.string().nullable().optional() }), latest?.capabilitiesJson ?? null, {});
  const tts = caps.tts ?? null;
  const [engine, voiceList] = tts ? [tts.slice(0, tts.indexOf(":")), tts.slice(tts.indexOf(":") + 1)] : ["", ""];
  const voices = engine === env.TTS_PROVIDER && voiceList ? voiceList.split("|").filter(Boolean) : [];
  let problem: string | null = null;
  if (!latest) problem = "Unknown until the media worker runs. Start the app with `npm run dev:all`.";
  else if (!tts)
    problem =
      env.TTS_PROVIDER === "kokoro"
        ? "Kokoro isn't installed. Install it (see README › Original video generator) or set `TTS_PROVIDER=sapi`."
        : "The media worker couldn't use the Windows voices. Check the worker log.";
  else if (engine !== env.TTS_PROVIDER) problem = "Restart `npm run dev:all` so the worker uses the new TTS_PROVIDER.";
  return {
    workerOnline,
    tts: { provider: env.TTS_PROVIDER, voices, ready: problem === null, problem },
    stock,
  };
}

function nicheLabel(id: string): string {
  return GENERATOR_NICHES.find((niche) => niche.id === id)?.label ?? id;
}

/** Why the video can't be rendered yet, scene by scene (null when it can). */
function renderBlockReason(project: GeneratorProject, scenes: SceneRow[], jobs: JobView[]): string | null {
  if (scenes.length === 0) return "Write the script first.";
  if (!project.scriptApprovedAt) return "Review and approve the script first.";
  if (jobs.some((job) => job.type === "gen.render")) return "The video is being rendered.";
  if (jobs.some((job) => job.type === "gen.narrate" || job.type === "gen.footage"))
    return "Wait until the narration and footage searches have finished.";
  const problems: string[] = [];
  for (const scene of scenes) {
    const number = scene.order + 1;
    if (scene.narrationStatus !== "ready" || !scene.audioPath) problems.push(`scene ${number} has no narration`);
    else if (narrationStale(scene)) problems.push(`scene ${number}'s narration is out of date`);
    if (!scene.footageSource) problems.push(`scene ${number} has no footage`);
  }
  if (problems.length === 0) return null;
  const shown = problems.slice(0, 4).join(", ");
  return `Before rendering: ${shown}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.`;
}

export async function getProject(userId: string, projectId: string): Promise<ProjectView | null> {
  const project = await db.generatorProject.findFirst({
    where: { id: projectId, userId },
    include: {
      scenes: { orderBy: { order: "asc" }, include: sceneInclude },
      outputVideo: { select: { id: true, title: true, status: true, durationMs: true, sizeBytes: true } },
    },
  });
  if (!project) return null;
  const jobs = await activeJobs(project.id);
  const { scenes } = project;
  const video = project.outputVideo;
  return {
    id: project.id,
    status: project.status as GeneratorStatus,
    error: project.error,
    settings: settingsOf(project),
    title: project.title,
    hook: project.hook,
    script: {
      provider: project.scriptProvider,
      model: project.scriptModel,
      warnings: parseJson(z.array(z.string()), project.scriptWarningsJson, []),
      approved: Boolean(project.scriptApprovedAt),
    },
    scenes: scenes.map(sceneView),
    music: project.musicPath
      ? {
          url: `/api/generator/projects/${project.id}/music?v=${project.updatedAt.getTime()}`,
          volumeDb: project.musicVolumeDb,
        }
      : null,
    jobs,
    renderBlocked: renderBlockReason(project, scenes, jobs),
    estimatedDurationMs: totalDurationMs(
      scenes.map((scene) => ({
        durationMs: scene.audioDurationMs ?? scene.estimatedMs ?? estimateMs(scene.narration),
      })),
    ),
    output: video
      ? {
          videoId: video.id,
          title: video.title,
          status: video.status,
          url: `/api/media/videos/${video.id}/source`,
          downloadUrl: `/api/media/videos/${video.id}/source?download=1`,
          durationMs: video.durationMs,
          sizeBytes: Number(video.sizeBytes),
          renderedAt: project.renderedAt?.toISOString() ?? null,
          elapsedMs: project.renderElapsedMs,
        }
      : null,
    creditsText: project.creditsText,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export async function listProjects(userId: string): Promise<ProjectSummary[]> {
  const projects = await db.generatorProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { _count: { select: { scenes: true } } },
  });
  return projects.map((project) => ({
    id: project.id,
    topic: project.topic,
    title: project.title,
    status: project.status as GeneratorStatus,
    aspectRatio: project.aspectRatio as AspectRatio,
    targetDurationSec: project.targetDurationSec,
    sceneCount: project._count.scenes,
    outputVideoId: project.outputVideoId,
    updatedAt: project.updatedAt.toISOString(),
  }));
}

/** Library videos that can be used as scene footage (ready, with a known length). */
export async function listLibraryFootage(userId: string) {
  const videos = await db.video.findMany({
    where: { userId, status: "ready", durationMs: { gt: 1000 } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, title: true, durationMs: true, width: true, height: true, posterPath: true, sourceType: true },
  });
  return videos.map((video) => ({
    id: video.id,
    title: video.title,
    durationMs: video.durationMs ?? 0,
    width: video.width,
    height: video.height,
    hasPoster: Boolean(video.posterPath),
    generated: video.sourceType === "generated",
  }));
}

// ---------------------------------------------------------------------------
// Brief and script
// ---------------------------------------------------------------------------

function assertIdle(project: GeneratorProject) {
  if (project.status === "scripting") throw new AppError("CONFLICT", "The script is being written. Wait a moment.");
  if (project.status === "rendering")
    throw new AppError("CONFLICT", "The video is being rendered. Wait for it to finish.");
}

/**
 * Moves the project into "scripting" or "rendering" only if it isn't already busy — atomically, so two
 * clicks can't start two scripts or two renders.
 */
async function claimStatus(
  tx: Prisma.TransactionClient,
  projectId: string,
  status: "scripting" | "rendering",
): Promise<void> {
  const { count } = await tx.generatorProject.updateMany({
    where: { id: projectId, status: { notIn: ["scripting", "rendering"] } },
    data: { status, error: null },
  });
  if (count !== 1) throw new AppError("CONFLICT", "This project is busy. Wait for the current step to finish.");
}

/** GEN-01: creates the project and starts writing the script. If the AI isn't ready, the project stays a draft. */
export async function createProject(
  userId: string,
  settings: ProjectSettings,
): Promise<{ id: string; scriptError: string | null }> {
  const project = await db.generatorProject.create({ data: { userId, ...settings } });
  await recordAuditEvent({ action: "generator.project_created", userId, details: { projectId: project.id } });
  try {
    await startScript(userId, project.id);
    return { id: project.id, scriptError: null };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    await db.generatorProject.update({ where: { id: project.id }, data: { error: error.message } });
    return { id: project.id, scriptError: error.message };
  }
}

export async function updateSettings(userId: string, projectId: string, settings: ProjectSettings): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  await db.generatorProject.update({ where: { id: project.id }, data: settings });
}

/** Queues gen.script. A new script replaces the scenes (and their narration and footage) when it arrives. */
export async function startScript(userId: string, projectId: string): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  const provider = await requireReadyAiProvider(userId, "Writing a script");
  await db.$transaction(async (tx) => {
    await claimStatus(tx, project.id, "scripting");
    await cancelJobsForEntity(ENTITY, project.id, tx, "gen.narrate");
    await cancelJobsForEntity(ENTITY, project.id, tx, "gen.footage");
    // Scenes waiting for those jobs would otherwise keep spinning if the new script fails.
    await tx.generatorScene.updateMany({
      where: { projectId: project.id, narrationStatus: "processing" },
      data: { narrationStatus: "none" },
    });
    await tx.generatorScene.updateMany({
      where: { projectId: project.id, footageStatus: "searching" },
      data: { footageStatus: "none" },
    });
    await enqueueJob(
      {
        userId,
        type: "gen.script",
        entityType: ENTITY,
        entityId: project.id,
        priority: 50,
        maxAttempts: 2,
        payload: {
          projectId: project.id,
          topic: project.topic,
          niche: nicheLabel(project.niche),
          audience: project.audience,
          tone: project.tone,
          durationSec: project.targetDurationSec,
          aspectRatio: project.aspectRatio,
          language: project.language,
          notes: project.notes,
          provider,
        },
      },
      tx,
    );
  });
}

/**
 * GEN-02: saves the edited script. Scenes keep their id (and so their narration and footage) when they
 * are edited or moved; new scenes start empty; removed scenes are deleted. Editing un-approves nothing,
 * but narration made from older text is marked out of date.
 */
export async function saveScript(userId: string, projectId: string, doc: ScriptDoc): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  const existing = await db.generatorScene.findMany({ where: { projectId }, select: { id: true } });
  const known = new Set(existing.map((scene) => scene.id));
  const kept = new Set(doc.scenes.flatMap((scene) => (scene.id && known.has(scene.id) ? [scene.id] : [])));
  await db.$transaction(async (tx) => {
    await tx.generatorScene.deleteMany({ where: { projectId, id: { notIn: [...kept] } } });
    for (const [order, scene] of doc.scenes.entries()) {
      const data = {
        order,
        narration: scene.narration,
        visualQuery: scene.visualQuery,
        onScreenText: scene.onScreenText,
        estimatedMs: estimateMs(scene.narration),
      };
      if (scene.id && kept.has(scene.id)) await tx.generatorScene.update({ where: { id: scene.id }, data });
      else await tx.generatorScene.create({ data: { projectId, ...data } });
    }
    await tx.generatorProject.update({
      where: { id: projectId },
      data: { title: doc.title, hook: doc.hook, status: project.status === "draft" ? "editing" : project.status },
    });
  });
}

/**
 * The creator confirms they've checked the script (facts included). Narration and, when a stock provider
 * is configured, footage searches start for every scene that needs them.
 */
export async function approveScript(userId: string, projectId: string): Promise<{ notes: string[] }> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  const count = await db.generatorScene.count({ where: { projectId } });
  if (count === 0) throw new AppError("VALIDATION", "Write the script first.");
  await db.generatorProject.update({ where: { id: projectId }, data: { scriptApprovedAt: new Date() } });
  const notes: string[] = [];
  try {
    await narrateScenes(userId, projectId, null);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    notes.push(error.message);
  }
  const setup = await getGeneratorSetup();
  if (setup.stock.pexels || setup.stock.pixabay) {
    try {
      await findFootage(userId, projectId, null);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      notes.push(error.message);
    }
  } else {
    notes.push(
      "No stock video provider is set up, so choose footage from your library or upload clips for each scene (or add a free Pexels key).",
    );
  }
  return { notes };
}

// ---------------------------------------------------------------------------
// Narration and footage
// ---------------------------------------------------------------------------

async function assertNoActive(projectId: string, type: JobType, message: string) {
  const job = await db.job.findFirst({
    where: { entityType: ENTITY, entityId: projectId, type, status: { in: [...ACTIVE_JOB_STATUSES] } },
    select: { id: true },
  });
  if (job) throw new AppError("CONFLICT", message);
}

/** GEN-03: narrates the given scenes, or every scene without up-to-date narration when `sceneIds` is null. */
export async function narrateScenes(userId: string, projectId: string, sceneIds: string[] | null): Promise<number> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  if (!project.scriptApprovedAt) throw new AppError("VALIDATION", "Approve the script first.");
  await assertNoActive(projectId, "gen.narrate", "Narration is already being recorded. Wait for it to finish.");
  const scenes = await db.generatorScene.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  const chosen = sceneIds
    ? scenes.filter((scene) => sceneIds.includes(scene.id))
    : scenes.filter((scene) => scene.narrationStatus !== "ready" || narrationStale(scene));
  if (chosen.length === 0) return 0;
  const env = getEnv();
  const stamp = Date.now().toString(36);
  await db.$transaction(async (tx) => {
    await assertNoActiveJob(
      tx,
      { entityType: ENTITY, entityId: projectId, type: "gen.narrate" },
      "Narration is already being recorded. Wait for it to finish.",
    );
    await tx.generatorScene.updateMany({
      where: { id: { in: chosen.map((scene) => scene.id) } },
      data: { narrationStatus: "processing", narrationError: null },
    });
    await enqueueJob(
      {
        userId,
        type: "gen.narrate",
        entityType: ENTITY,
        entityId: projectId,
        priority: 50,
        payload: {
          projectId,
          provider: env.TTS_PROVIDER,
          voice: project.voice,
          rate: project.voiceRate,
          scenes: chosen.map((scene) => ({
            id: scene.id,
            text: scene.narration,
            outputPath: `generator/${projectId}/narration/${scene.id}-${stamp}.wav`,
          })),
        },
      },
      tx,
    );
  });
  return chosen.length;
}

/** GEN-04, GEN-08: searches stock footage for the given scenes (or every scene without footage). */
export async function findFootage(userId: string, projectId: string, sceneIds: string[] | null): Promise<number> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  if (!project.scriptApprovedAt) throw new AppError("VALIDATION", "Approve the script first.");
  const env = getEnv();
  if (!env.PEXELS_API_KEY && !env.PIXABAY_API_KEY) {
    throw new AppError(
      "CONFIGURATION",
      "No stock video provider is set up. Get a free Pexels API key at pexels.com/api, add PEXELS_API_KEY to .env and restart the app — or use clips from your library or upload your own.",
    );
  }
  await assertNoActive(projectId, "gen.footage", "Footage is already being searched. Wait for it to finish.");
  const scenes = await db.generatorScene.findMany({ where: { projectId }, orderBy: { order: "asc" } });
  const chosen = sceneIds
    ? scenes.filter((scene) => sceneIds.includes(scene.id))
    : scenes.filter((scene) => !scene.footageSource);
  if (chosen.length === 0) return 0;
  await db.$transaction(async (tx) => {
    await assertNoActiveJob(
      tx,
      { entityType: ENTITY, entityId: projectId, type: "gen.footage" },
      "Footage is already being searched. Wait for it to finish.",
    );
    await tx.generatorScene.updateMany({
      where: { id: { in: chosen.map((scene) => scene.id) } },
      data: { footageStatus: "searching", footageError: null },
    });
    await enqueueJob(
      {
        userId,
        type: "gen.footage",
        entityType: ENTITY,
        entityId: projectId,
        priority: 50,
        payload: {
          projectId,
          orientation: project.aspectRatio === "9:16" ? "portrait" : "landscape",
          scenes: chosen.map((scene) => ({
            id: scene.id,
            query: scene.visualQuery,
            minDurationMs: scene.audioDurationMs ?? scene.estimatedMs ?? estimateMs(scene.narration),
          })),
        },
      },
      tx,
    );
  });
  return chosen.length;
}

async function assertSceneEditable(scene: { project: GeneratorProject }) {
  assertIdle(scene.project);
}

/** Swaps a scene to another of its stock candidates (downloaded at render time if not cached yet). */
export async function chooseStockCandidate(userId: string, sceneId: string, providerAssetId: string): Promise<void> {
  const scene = await findOwnedScene(userId, sceneId);
  await assertSceneEditable(scene);
  const candidate = parseJson(stockCandidatesSchema, scene.candidatesJson, []).find(
    (item) => item.providerAssetId === providerAssetId,
  );
  if (!candidate) throw new AppError("NOT_FOUND", "That clip isn't one of this scene's suggestions.");
  const cached = (await storageFileSize(stockFilePath(candidate.provider, candidate.providerAssetId))) !== null;
  await db.$transaction(async (tx) => {
    const asset = await upsertStockAsset(tx, candidate, cached);
    await tx.generatorScene.update({
      where: { id: scene.id },
      data: {
        footageSource: "stock",
        stockAssetId: asset.id,
        clipStartMs: 0,
        footageStatus: "ready",
        footageError: null,
      },
    });
  });
}

export const libraryChoiceSchema = z.object({
  videoId: z.string().min(1).max(100),
  startMs: z.number().int().nonnegative(),
});

/** Uses part of a library video as the scene's footage (the creator's own material). */
export async function chooseLibraryClip(
  userId: string,
  sceneId: string,
  choice: z.infer<typeof libraryChoiceSchema>,
): Promise<void> {
  const scene = await findOwnedScene(userId, sceneId);
  await assertSceneEditable(scene);
  const video = await db.video.findFirst({ where: { id: choice.videoId, userId } });
  if (!video) throw new AppError("NOT_FOUND", "Video not found.");
  if (video.status !== "ready" || !video.durationMs) throw new AppError("VALIDATION", "That video isn't ready yet.");
  if (choice.startMs >= video.durationMs - 500) {
    throw new AppError("VALIDATION", "Start the clip at least half a second before the video ends.");
  }
  await db.generatorScene.update({
    where: { id: scene.id },
    data: {
      footageSource: "library",
      libraryVideoId: video.id,
      clipStartMs: choice.startMs,
      footageStatus: "ready",
      footageError: null,
    },
  });
}

export async function setClipStart(userId: string, sceneId: string, startMs: number): Promise<void> {
  const scene = await findOwnedScene(userId, sceneId);
  await assertSceneEditable(scene);
  if (!scene.footageSource) throw new AppError("VALIDATION", "Choose footage first.");
  await db.generatorScene.update({ where: { id: scene.id }, data: { clipStartMs: Math.max(0, startMs) } });
}

// ---------------------------------------------------------------------------
// Uploads (own clips and music)
// ---------------------------------------------------------------------------

function looksLike(kind: "video" | "audio", extension: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  const isoMedia = ascii(4, 8) === "ftyp";
  const matroska = head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (kind === "video") return ["webm", "mkv"].includes(extension) ? matroska : isoMedia;
  if (extension === "mp3") return ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  if (extension === "wav") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  if (extension === "ogg") return ascii(0, 4) === "OggS";
  return isoMedia; // m4a
}

/**
 * Streams a request body into storage with a size cap (nothing is held in memory), then checks the file
 * really is the claimed kind of media. The final check (readable, really moving) happens when rendering.
 */
async function saveUpload(
  body: ReadableStream<Uint8Array> | null,
  relativePath: string,
  kind: "video" | "audio",
  extension: string,
  limit: number,
): Promise<void> {
  if (!body) throw new AppError("VALIDATION", "The file is empty.");
  const target = resolveStoragePath(relativePath);
  const partial = `${target}.partial`;
  await fs.mkdir(resolveStoragePath(relativePath.slice(0, relativePath.lastIndexOf("/"))), { recursive: true });
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      done(
        size > limit ? new AppError("PAYLOAD_TOO_LARGE", `The file is larger than ${limit / 1024 / 1024} MB.`) : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), cap, createWriteStream(partial));
    if (size === 0) throw new AppError("VALIDATION", "The file is empty.");
    const handle = await fs.open(partial, "r");
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    await handle.close();
    if (!looksLike(kind, extension, head)) {
      throw new AppError(
        "VALIDATION",
        `That doesn't look like a .${extension} ${kind === "video" ? "video" : "audio"} file.`,
      );
    }
    await fs.rename(partial, target);
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw error;
  }
}

/**
 * Saves an upload, then re-checks the project: an upload can take minutes, and meanwhile the scene may have
 * been deleted or a render started. Then the new file is removed instead of being attached. Replaced
 * files are not deleted here (a render may be reading them); housekeeping removes them once unused.
 */
async function attachUpload(
  relativePath: string,
  projectId: string,
  attach: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      const project = await tx.generatorProject.findUnique({ where: { id: projectId }, select: { status: true } });
      if (!project) throw new AppError("NOT_FOUND", "The project was deleted while the file was uploading.");
      if (project.status === "scripting" || project.status === "rendering") {
        throw new AppError("CONFLICT", "The project got busy while the file was uploading. Try again when it's done.");
      }
      await attach(tx);
    });
  } catch (error) {
    await fs.rm(resolveStoragePath(relativePath), { force: true }).catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "P2025") {
      throw new AppError("NOT_FOUND", "The scene was deleted while the file was uploading.");
    }
    throw error;
  }
}

export async function uploadSceneClip(
  userId: string,
  sceneId: string,
  extension: (typeof CLIP_EXTENSIONS)[number],
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  const scene = await findOwnedScene(userId, sceneId);
  await assertSceneEditable(scene);
  const relativePath = `generator/${scene.projectId}/clips/${scene.id}-${Date.now().toString(36)}.${extension}`;
  await saveUpload(body, relativePath, "video", extension, CLIP_UPLOAD_MAX_BYTES);
  await attachUpload(relativePath, scene.projectId, (tx) =>
    tx.generatorScene.update({
      where: { id: scene.id },
      data: {
        footageSource: "upload",
        customClipPath: relativePath,
        clipStartMs: 0,
        footageStatus: "ready",
        footageError: null,
      },
    }),
  );
}

export async function uploadMusic(
  userId: string,
  projectId: string,
  extension: (typeof MUSIC_EXTENSIONS)[number],
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  const relativePath = `generator/${project.id}/music-${Date.now().toString(36)}.${extension}`;
  await saveUpload(body, relativePath, "audio", extension, MUSIC_UPLOAD_MAX_BYTES);
  await attachUpload(relativePath, project.id, (tx) =>
    tx.generatorProject.update({ where: { id: project.id }, data: { musicPath: relativePath } }),
  );
}

/** The file itself is removed by housekeeping once no render can be using it. */
export async function removeMusic(userId: string, projectId: string): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  await db.generatorProject.update({ where: { id: project.id }, data: { musicPath: null } });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function footageOf(scene: SceneRow) {
  if (scene.footageSource === "stock" && scene.stockAsset) {
    const asset = scene.stockAsset;
    return {
      footage: {
        path: asset.filePath,
        startMs: scene.clipStartMs,
        provider: asset.provider,
        downloadUrl: asset.downloadUrl,
      },
      credit: {
        kind: "stock",
        provider: asset.provider,
        creatorName: asset.creatorName,
        pageUrl: asset.pageUrl,
        licenseName: asset.licenseName,
      } satisfies CreditSource,
    };
  }
  return null;
}

/** GEN-05: assembles the finished video. Every scene must have current narration and chosen footage. */
export async function startRender(userId: string, projectId: string): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  assertIdle(project);
  const scenes = await db.generatorScene.findMany({
    where: { projectId },
    orderBy: { order: "asc" },
    include: sceneInclude,
  });
  const blocked = renderBlockReason(project, scenes, await activeJobs(projectId));
  if (blocked) throw new AppError("VALIDATION", blocked);

  const renderScenes: { id: string; number: number; audioPath: string; durationMs: number; footage: object }[] = [];
  const credits: CreditSource[] = [];
  const timeline: { durationMs: number; words: WordTiming[] }[] = [];
  for (const scene of scenes) {
    const number = scene.order + 1;
    if (!scene.audioPath || !scene.audioDurationMs || (await storageFileSize(scene.audioPath)) === null) {
      throw new AppError("VALIDATION", `Scene ${number}'s narration file is missing. Narrate it again.`);
    }
    let footage: { path: string; startMs: number; provider?: string; downloadUrl?: string };
    const stock = footageOf(scene);
    if (stock) {
      footage = stock.footage;
      credits.push(stock.credit);
    } else if (scene.footageSource === "library" && scene.libraryVideoId) {
      const video = await db.video.findFirst({ where: { id: scene.libraryVideoId, userId } });
      if (!video || (await storageFileSize(video.sourcePath)) === null) {
        throw new AppError("VALIDATION", `Scene ${number}'s library video is missing. Choose other footage.`);
      }
      footage = { path: video.sourcePath, startMs: scene.clipStartMs };
      credits.push({ kind: "library" });
    } else if (scene.footageSource === "upload" && scene.customClipPath) {
      if ((await storageFileSize(scene.customClipPath)) === null) {
        throw new AppError("VALIDATION", `Scene ${number}'s uploaded clip is missing. Upload it again.`);
      }
      footage = { path: scene.customClipPath, startMs: scene.clipStartMs };
      credits.push({ kind: "upload" });
    } else {
      throw new AppError("VALIDATION", `Scene ${number} has no footage.`);
    }
    renderScenes.push({
      id: scene.id,
      number,
      audioPath: scene.audioPath,
      durationMs: scene.audioDurationMs,
      footage,
    });
    timeline.push({
      durationMs: scene.audioDurationMs,
      words: parseJson(wordTimingsSchema, scene.wordTimingsJson, []),
    });
  }

  const settings = await db.userSettings.findUnique({ where: { userId }, select: { captionStyleJson: true } });
  const style = parseCaptionStyle(settings?.captionStyleJson);
  const { width, height } = frameSize(project.aspectRatio as AspectRatio, project.resolution);
  const captions = project.captionsEnabled ? timelineCaptions(timeline, style) : [];
  const env = getEnv();
  const credit = creditsText(credits, { provider: env.TTS_PROVIDER, name: project.voice });
  const videoId = randomUUID();
  const title = (project.title ?? project.topic).slice(0, 100);

  await db.$transaction(async (tx) => {
    await claimStatus(tx, projectId, "rendering");
    await enqueueJob(
      {
        userId,
        type: "gen.render",
        entityType: ENTITY,
        entityId: projectId,
        priority: 50,
        maxAttempts: 2,
        payload: {
          projectId,
          videoId,
          title,
          topic: project.topic,
          credits: credit,
          outputPath: `videos/${videoId}/source.mp4`,
          width,
          height,
          quality: project.quality,
          transitionMs: TRANSITION_MS,
          scenes: renderScenes,
          captions,
          captionStyle: captions.length > 0 ? frameCaptionStyle(style, width, height) : null,
          music: project.musicPath ? { path: project.musicPath, volumeDb: project.musicVolumeDb } : null,
        },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Media and deletion
// ---------------------------------------------------------------------------

async function streamable(relativePath: string, contentType: string, downloadName: string) {
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingStoragePath(relativePath);
  } catch {
    throw new AppError("NOT_FOUND", "The file is missing.");
  }
  const stat = await fs.stat(absolutePath);
  return { absolutePath, size: stat.size, contentType, downloadName };
}

const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};
const AUDIO_TYPES: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg" };

function extensionOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
}

export async function getSceneAudioFile(userId: string, sceneId: string) {
  const scene = await findOwnedScene(userId, sceneId);
  if (!scene.audioPath) throw new AppError("NOT_FOUND", "This scene has no narration yet.");
  return streamable(scene.audioPath, "audio/wav", `scene-${scene.order + 1}.wav`);
}

/** The chosen stock or uploaded clip (library clips play through the normal video media route). */
export async function getSceneFootageFile(userId: string, sceneId: string) {
  const scene = await findOwnedScene(userId, sceneId);
  if (scene.footageSource === "stock" && scene.stockAsset) {
    return streamable(scene.stockAsset.filePath, "video/mp4", `scene-${scene.order + 1}.mp4`);
  }
  if (scene.footageSource === "upload" && scene.customClipPath) {
    const extension = extensionOf(scene.customClipPath);
    return streamable(
      scene.customClipPath,
      VIDEO_TYPES[extension] ?? "video/mp4",
      `scene-${scene.order + 1}.${extension}`,
    );
  }
  throw new AppError("NOT_FOUND", "No downloaded clip for this scene.");
}

export async function getMusicFile(userId: string, projectId: string) {
  const project = await findOwnedProject(userId, projectId);
  if (!project.musicPath) throw new AppError("NOT_FOUND", "No music added.");
  const extension = extensionOf(project.musicPath);
  return streamable(project.musicPath, AUDIO_TYPES[extension] ?? "audio/mpeg", `music.${extension}`);
}

/** Deletes the project and its narration, uploads and music. Rendered videos stay in the library. */
export async function deleteProject(userId: string, projectId: string): Promise<void> {
  const project = await findOwnedProject(userId, projectId);
  await db.$transaction(async (tx) => {
    await cancelJobsForEntity(ENTITY, project.id, tx);
    await tx.generatorProject.delete({ where: { id: project.id } });
  });
  await removeStorageDir(`generator/${project.id}`).catch((error: unknown) =>
    logger.warn("Couldn't remove generator files", { projectId, error }),
  );
  await recordAuditEvent({ action: "generator.project_deleted", userId, details: { projectId: project.id } });
}
