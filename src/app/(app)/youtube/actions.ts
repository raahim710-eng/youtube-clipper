"use server";

import { z } from "zod";
import { publishInputSchema } from "@/lib/youtube/publish";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import {
  cancelPublication,
  disconnectChannel,
  listPublications,
  type PublicationView,
  retryPublication,
  setDefaultChannel,
  startPublication,
} from "@/server/services/youtube";

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

export async function disconnectChannelAction(channelId: unknown): Promise<ActionResult<{ revoked: boolean }>> {
  const id = idSchema.safeParse(channelId);
  if (!id.success) return { ok: false, error: "Invalid channel." };
  return asUser((userId) => disconnectChannel(userId, id.data), "disconnect channel");
}

export async function setDefaultChannelAction(channelId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(channelId);
  if (!id.success) return { ok: false, error: "Invalid channel." };
  return asUser(async (userId) => {
    await setDefaultChannel(userId, id.data);
    return null;
  }, "set default channel");
}

export async function publishAction(input: unknown): Promise<ActionResult<{ publicationId: string }>> {
  const parsed = publishInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Some fields are missing or invalid." };
  return asUser(async (userId) => ({ publicationId: await startPublication(userId, parsed.data) }), "start upload");
}

export async function listPublicationsAction(): Promise<ActionResult<PublicationView[]>> {
  return asUser((userId) => listPublications(userId), "list uploads");
}

export async function retryPublicationAction(publicationId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(publicationId);
  if (!id.success) return { ok: false, error: "Invalid upload." };
  return asUser(async (userId) => {
    await retryPublication(userId, id.data);
    return null;
  }, "retry upload");
}

export async function cancelPublicationAction(publicationId: unknown): Promise<ActionResult<null>> {
  const id = idSchema.safeParse(publicationId);
  if (!id.success) return { ok: false, error: "Invalid upload." };
  return asUser(async (userId) => {
    await cancelPublication(userId, id.data);
    return null;
  }, "cancel upload");
}
