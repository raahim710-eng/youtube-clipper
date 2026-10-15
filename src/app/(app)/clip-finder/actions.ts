"use server";

import { z } from "zod";
import { clipStatusSchema } from "@/lib/constants";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import type { ClipView } from "@/server/services/clips";
import {
  clipRangeSchema,
  createManualClip,
  setClipStatus,
  startClipAnalysis,
  updateClipRange,
  updateClipTitle,
} from "@/server/services/clips";
import { startTranscription } from "@/server/services/transcripts";

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

export async function transcribeVideoAction(videoId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(videoId);
  if (!id.success) return { ok: false, error: "Invalid video." };
  return asUser(async (userId) => {
    await startTranscription(userId, id.data);
    return null;
  }, "start transcription");
}

export async function findClipsAction(videoId: unknown, mode: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(videoId);
  const parsedMode = z.enum(["ai", "heuristic"]).safeParse(mode);
  if (!id.success || !parsedMode.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await startClipAnalysis(userId, id.data, parsedMode.data);
    return null;
  }, "start clip analysis");
}

export async function updateClipRangeAction(clipId: unknown, range: unknown): Promise<ActionResult<ClipView>> {
  const id = idSchema.safeParse(clipId);
  const parsed = clipRangeSchema.safeParse(range);
  if (!id.success || !parsed.success) return { ok: false, error: "Enter a valid start and end time." };
  return asUser((userId) => updateClipRange(userId, id.data, parsed.data), "adjust clip");
}

export async function setClipStatusAction(clipId: unknown, status: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(clipId);
  const parsed = clipStatusSchema.safeParse(status);
  if (!id.success || !parsed.success) return { ok: false, error: "Invalid request." };
  return asUser(async (userId) => {
    await setClipStatus(userId, id.data, parsed.data);
    return null;
  }, "update clip status");
}

export async function createManualClipAction(videoId: unknown, range: unknown): Promise<ActionResult<ClipView>> {
  const id = idSchema.safeParse(videoId);
  const parsed = clipRangeSchema.safeParse(range);
  if (!id.success || !parsed.success) return { ok: false, error: "Select a start and an end in the transcript." };
  return asUser((userId) => createManualClip(userId, id.data, parsed.data), "create clip");
}

export async function updateClipTitleAction(clipId: unknown, title: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(clipId);
  const parsed = z.string().trim().min(1, "Enter a title.").max(100).safeParse(title);
  if (!id.success) return { ok: false, error: "Invalid clip." };
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid title." };
  return asUser(async (userId) => {
    await updateClipTitle(userId, id.data, parsed.data);
    return null;
  }, "rename clip");
}
