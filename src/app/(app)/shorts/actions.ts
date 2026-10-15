"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { captionStyleSchema } from "@/lib/shorts/caption-style";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { cancelJob } from "@/server/jobs/queue";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import {
  createShortFromClip,
  deleteShort,
  getShortStatus,
  retryReframe,
  saveShort,
  setDefaultCaptionStyle,
  shortDocSchema,
  type ShortStatusView,
  startRender,
} from "@/server/services/shorts";

const idSchema = z.string().trim().min(1).max(100);

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

/** Creates a Short from a clip (or finds the existing one) and opens the editor. */
export async function createShortAction(clipId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(clipId);
  if (!id.success) return { ok: false, error: "Invalid clip." };
  const result = await asUser((userId) => createShortFromClip(userId, id.data), "create Short");
  if (!result.ok) return result;
  redirect(`/shorts/${result.data}`);
}

export async function saveShortAction(shortId: unknown, doc: unknown): Promise<ActionResult<ShortStatusView>> {
  const id = idSchema.safeParse(shortId);
  const parsed = shortDocSchema.safeParse(doc);
  if (!id.success) return { ok: false, error: "Invalid Short." };
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Some settings are invalid." };
  return asUser((userId) => saveShort(userId, id.data, parsed.data), "save Short");
}

export async function getShortStatusAction(shortId: unknown): Promise<ActionResult<ShortStatusView>> {
  const id = idSchema.safeParse(shortId);
  if (!id.success) return { ok: false, error: "Invalid Short." };
  return asUser((userId) => getShortStatus(userId, id.data), "read Short status");
}

export async function exportShortAction(shortId: unknown): Promise<ActionResult<ShortStatusView>> {
  const id = idSchema.safeParse(shortId);
  if (!id.success) return { ok: false, error: "Invalid Short." };
  return asUser((userId) => startRender(userId, id.data), "start export");
}

export async function cancelShortJobAction(jobId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, error: "Invalid job." };
  return asUser(async (userId) => {
    await cancelJob(userId, id.data);
    return null;
  }, "cancel job");
}

export async function retryReframeAction(shortId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(shortId);
  if (!id.success) return { ok: false, error: "Invalid Short." };
  return asUser(async (userId) => {
    await retryReframe(userId, id.data);
    return null;
  }, "retry face tracking");
}

export async function setDefaultCaptionStyleAction(style: unknown): Promise<ActionResult<null>> {
  const parsed = captionStyleSchema.safeParse(style);
  if (!parsed.success) return { ok: false, error: "Invalid caption style." };
  return asUser(async (userId) => {
    await setDefaultCaptionStyle(userId, parsed.data);
    return null;
  }, "save default caption style");
}

export async function deleteShortAction(shortId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(shortId);
  if (!id.success) return { ok: false, error: "Invalid Short." };
  const result = await asUser(async (userId) => {
    await deleteShort(userId, id.data);
    return null;
  }, "delete Short");
  if (!result.ok) return result;
  redirect("/shorts");
}
