"use server";

import { z } from "zod";
import { PACKAGING_TARGET_KINDS } from "@/lib/constants";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { cancelJob } from "@/server/jobs/queue";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import {
  deletePackagingSet,
  deleteThumbnail,
  generateInputSchema,
  listPackagingSets,
  listThumbnails,
  packagingEditSchema,
  type PackagingSetView,
  requestThumbnail,
  savePackagingEdits,
  selectThumbnail,
  setPreferredPackaging,
  startPackaging,
  thumbnailRequestSchema,
  type ThumbnailView,
} from "@/server/services/packaging";

const idSchema = z.string().trim().min(1).max(100);
const kindSchema = z.enum(PACKAGING_TARGET_KINDS);

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

function target(kind: unknown, id: unknown) {
  const parsedKind = kindSchema.safeParse(kind);
  const parsedId = idSchema.safeParse(id);
  return parsedKind.success && parsedId.success ? { kind: parsedKind.data, id: parsedId.data } : null;
}

export async function generatePackagingAction(
  kind: unknown,
  id: unknown,
  input: unknown,
): Promise<ActionResult<PackagingSetView>> {
  const t = target(kind, id);
  const parsed = generateInputSchema.safeParse(input);
  if (!t || !parsed.success) return { ok: false, error: "Notes can be up to 1,000 characters." };
  return asUser((userId) => startPackaging(userId, t.kind, t.id, parsed.data.notes), "start packaging");
}

export async function getPackagingStateAction(
  kind: unknown,
  id: unknown,
): Promise<ActionResult<{ sets: PackagingSetView[]; thumbnails: ThumbnailView[] }>> {
  const t = target(kind, id);
  if (!t) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    const [sets, thumbnails] = await Promise.all([
      listPackagingSets(userId, t.kind, t.id),
      listThumbnails(userId, t.kind, t.id),
    ]);
    return { sets, thumbnails };
  }, "read packaging");
}

export async function savePackagingAction(setId: unknown, edit: unknown): Promise<ActionResult<PackagingSetView>> {
  const id = idSchema.safeParse(setId);
  const parsed = packagingEditSchema.safeParse(edit);
  if (!id.success || !parsed.success) return { ok: false, error: "Some fields are too long or invalid." };
  return asUser((userId) => savePackagingEdits(userId, id.data, parsed.data), "save packaging");
}

export async function setPreferredPackagingAction(setId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(setId);
  if (!id.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await setPreferredPackaging(userId, id.data);
    return null;
  }, "choose packaging");
}

export async function deletePackagingSetAction(setId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(setId);
  if (!id.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await deletePackagingSet(userId, id.data);
    return null;
  }, "delete packaging");
}

export async function cancelPackagingJobAction(jobId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await cancelJob(userId, id.data);
    return null;
  }, "cancel packaging");
}

export async function requestThumbnailAction(
  kind: unknown,
  id: unknown,
  request: unknown,
): Promise<ActionResult<ThumbnailView>> {
  const t = target(kind, id);
  const parsed = thumbnailRequestSchema.safeParse(request);
  if (!t || !parsed.success) return { ok: false, error: "Invalid thumbnail request." };
  return asUser((userId) => requestThumbnail(userId, t.kind, t.id, parsed.data), "make thumbnail");
}

export async function selectThumbnailAction(thumbnailId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(thumbnailId);
  if (!id.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await selectThumbnail(userId, id.data);
    return null;
  }, "choose thumbnail");
}

export async function deleteThumbnailAction(thumbnailId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(thumbnailId);
  if (!id.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await deleteThumbnail(userId, id.data);
    return null;
  }, "delete thumbnail");
}
