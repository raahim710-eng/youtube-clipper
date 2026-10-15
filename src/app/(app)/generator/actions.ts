"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { cancelJob } from "@/server/jobs/queue";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import {
  approveScript,
  chooseLibraryClip,
  chooseStockCandidate,
  createProject,
  deleteProject,
  findFootage,
  getProject,
  libraryChoiceSchema,
  narrateScenes,
  type ProjectView,
  projectSettingsSchema,
  removeMusic,
  saveScript,
  scriptDocSchema,
  setClipStart,
  startRender,
  startScript,
  updateSettings,
} from "@/server/services/generator";

const idSchema = z.string().trim().min(1).max(100);
const idListSchema = z.array(idSchema).min(1).max(40).nullable();

async function asUser<T>(run: (userId: string) => Promise<T>, context: string): Promise<ActionResult<T>> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." };
  try {
    return { ok: true, data: await run(session.user.id) };
  } catch (error) {
    if (!(error instanceof AppError) || error.cause !== undefined) logger.error(`Failed to ${context}`, { error });
    return { ok: false, error: toUserMessage(error) };
  }
}

/** Runs a change, then returns the fresh project so the workspace updates in one round trip. */
async function andProject(userId: string, projectId: string, change: () => Promise<unknown>): Promise<ProjectView> {
  await change();
  const project = await getProject(userId, projectId);
  if (!project) throw new AppError("NOT_FOUND", "Project not found.");
  return project;
}

function invalid(error: z.ZodError): { ok: false; error: string } {
  return { ok: false, error: error.issues[0]?.message ?? "Some values are invalid." };
}

export async function createProjectAction(settings: unknown): Promise<ActionResult<null>> {
  const parsed = projectSettingsSchema.safeParse(settings);
  if (!parsed.success) return invalid(parsed.error);
  const result = await asUser((userId) => createProject(userId, parsed.data), "create generator project");
  if (!result.ok) return result;
  redirect(`/generator/${result.data.id}`);
}

export async function getProjectAction(projectId: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  return asUser(async (userId) => {
    const project = await getProject(userId, id.data);
    if (!project) throw new AppError("NOT_FOUND", "Project not found.");
    return project;
  }, "read generator project");
}

export async function updateSettingsAction(projectId: unknown, settings: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const parsed = projectSettingsSchema.safeParse(settings);
  if (!id.success) return { ok: false, error: "Invalid project." };
  if (!parsed.success) return invalid(parsed.error);
  return asUser(
    (userId) => andProject(userId, id.data, () => updateSettings(userId, id.data, parsed.data)),
    "save generator settings",
  );
}

export async function writeScriptAction(projectId: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  return asUser((userId) => andProject(userId, id.data, () => startScript(userId, id.data)), "start script");
}

export async function saveScriptAction(projectId: unknown, doc: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const parsed = scriptDocSchema.safeParse(doc);
  if (!id.success) return { ok: false, error: "Invalid project." };
  if (!parsed.success) return invalid(parsed.error);
  return asUser((userId) => andProject(userId, id.data, () => saveScript(userId, id.data, parsed.data)), "save script");
}

export async function approveScriptAction(
  projectId: unknown,
): Promise<ActionResult<{ project: ProjectView; notes: string[] }>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  return asUser(async (userId) => {
    let notes: string[] = [];
    const project = await andProject(userId, id.data, async () => {
      notes = (await approveScript(userId, id.data)).notes;
    });
    return { project, notes };
  }, "approve script");
}

export async function narrateAction(projectId: unknown, sceneIds: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const ids = idListSchema.safeParse(sceneIds);
  if (!id.success || !ids.success) return { ok: false, error: "Invalid request." };
  return asUser(
    (userId) => andProject(userId, id.data, () => narrateScenes(userId, id.data, ids.data)),
    "start narration",
  );
}

export async function findFootageAction(projectId: unknown, sceneIds: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const ids = idListSchema.safeParse(sceneIds);
  if (!id.success || !ids.success) return { ok: false, error: "Invalid request." };
  return asUser(
    (userId) => andProject(userId, id.data, () => findFootage(userId, id.data, ids.data)),
    "search footage",
  );
}

export async function chooseStockAction(
  projectId: unknown,
  sceneId: unknown,
  providerAssetId: unknown,
): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const scene = idSchema.safeParse(sceneId);
  const asset = idSchema.safeParse(providerAssetId);
  if (!id.success || !scene.success || !asset.success) return { ok: false, error: "Invalid request." };
  return asUser(
    (userId) => andProject(userId, id.data, () => chooseStockCandidate(userId, scene.data, asset.data)),
    "choose stock clip",
  );
}

export async function chooseLibraryAction(
  projectId: unknown,
  sceneId: unknown,
  choice: unknown,
): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const scene = idSchema.safeParse(sceneId);
  const parsed = libraryChoiceSchema.safeParse(choice);
  if (!id.success || !scene.success) return { ok: false, error: "Invalid request." };
  if (!parsed.success) return invalid(parsed.error);
  return asUser(
    (userId) => andProject(userId, id.data, () => chooseLibraryClip(userId, scene.data, parsed.data)),
    "choose library clip",
  );
}

export async function setClipStartAction(
  projectId: unknown,
  sceneId: unknown,
  startMs: unknown,
): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const scene = idSchema.safeParse(sceneId);
  const start = z.number().int().nonnegative().max(86_400_000).safeParse(startMs);
  if (!id.success || !scene.success || !start.success) return { ok: false, error: "Invalid request." };
  return asUser(
    (userId) => andProject(userId, id.data, () => setClipStart(userId, scene.data, start.data)),
    "set clip start",
  );
}

export async function removeMusicAction(projectId: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  return asUser((userId) => andProject(userId, id.data, () => removeMusic(userId, id.data)), "remove music");
}

export async function renderAction(projectId: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  return asUser((userId) => andProject(userId, id.data, () => startRender(userId, id.data)), "start render");
}

export async function cancelGeneratorJobAction(projectId: unknown, jobId: unknown): Promise<ActionResult<ProjectView>> {
  const id = idSchema.safeParse(projectId);
  const job = idSchema.safeParse(jobId);
  if (!id.success || !job.success) return { ok: false, error: "Invalid request." };
  return asUser((userId) => andProject(userId, id.data, () => cancelJob(userId, job.data)), "cancel job");
}

export async function deleteProjectAction(projectId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(projectId);
  if (!id.success) return { ok: false, error: "Invalid project." };
  const result = await asUser((userId) => deleteProject(userId, id.data), "delete generator project");
  if (!result.ok) return result;
  redirect("/generator");
}
