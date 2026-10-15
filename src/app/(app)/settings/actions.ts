"use server";

import { z } from "zod";
import { type ActionResult, AppError, toUserMessage } from "@/server/errors";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import { revokeUserSession } from "@/server/services/sessions";
import { getSystemStatus } from "@/server/services/system-status";

const sessionIdSchema = z.string().trim().min(1).max(200);

/** Signs out one of the user's other devices. Re-checks the session itself (never trust the caller). */
export async function revokeSessionAction(sessionId: unknown): Promise<ActionResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." };

  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) return { ok: false, error: "Invalid session." };

  try {
    await revokeUserSession(session.user.id, parsed.data, session.sessionId);
    return { ok: true, data: undefined };
  } catch (error) {
    if (!(error instanceof AppError) || error.cause !== undefined) logger.error("Failed to revoke session", { error });
    return { ok: false, error: toUserMessage(error) };
  }
}

/** Runs the dependency checks again, bypassing the short cache. */
export async function recheckSystemStatusAction(): Promise<ActionResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." };
  await getSystemStatus({ fresh: true });
  return { ok: true, data: undefined };
}
