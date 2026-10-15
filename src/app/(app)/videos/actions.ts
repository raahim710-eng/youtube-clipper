"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { cancelJob, retryJob } from "@/server/jobs/queue";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import { deleteVideo, retryVideoProcessing, updateVideoDetails, videoDetailsSchema } from "@/server/services/videos";

const idSchema = z.string().trim().min(1).max(100);
const SIGNED_OUT: ActionResult = { ok: false, error: "Your session has expired. Please sign in again." };

/** Runs an action for the signed-in user and turns errors into a safe message. */
async function asUser(run: (userId: string) => Promise<void>, context: string): Promise<ActionResult> {
  const session = await getCurrentSession();
  if (!session) return SIGNED_OUT;
  try {
    await run(session.user.id);
    return { ok: true, data: undefined };
  } catch (error) {
    if (!(error instanceof AppError) || error.cause !== undefined) logger.error(`Failed to ${context}`, { error });
    return { ok: false, error: toUserMessage(error) };
  }
}

export async function updateVideoDetailsAction(videoId: unknown, input: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(videoId);
  const details = videoDetailsSchema.safeParse(input);
  if (!id.success) return { ok: false, error: "Invalid video." };
  if (!details.success) {
    return { ok: false, error: details.error.issues[0]?.message ?? "Check the details and try again." };
  }
  return asUser((userId) => updateVideoDetails(userId, id.data, details.data), "update video details");
}

export async function deleteVideoAction(videoId: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(videoId);
  if (!id.success) return { ok: false, error: "Invalid video." };
  const result = await asUser((userId) => deleteVideo(userId, id.data), "delete video");
  if (result.ok) redirect("/videos");
  return result;
}

export async function retryVideoProcessingAction(videoId: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(videoId);
  if (!id.success) return { ok: false, error: "Invalid video." };
  return asUser((userId) => retryVideoProcessing(userId, id.data), "retry processing");
}

export async function cancelJobAction(jobId: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, error: "Invalid job." };
  return asUser((userId) => cancelJob(userId, id.data), "cancel job");
}

export async function retryJobAction(jobId: unknown): Promise<ActionResult> {
  const id = idSchema.safeParse(jobId);
  if (!id.success) return { ok: false, error: "Invalid job." };
  return asUser((userId) => retryJob(userId, id.data), "retry job");
}
