import "server-only";
import { recordAuditEvent } from "../audit";
import { db } from "../db";
import { AppError } from "../errors";

export type SessionSummary = {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrent: boolean;
};

/** Active sessions of one user, newest first. Tokens are never selected. */
export async function listUserSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const sessions = await db.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, expiresAt: true, userAgent: true, ipAddress: true },
  });
  return sessions.map((session) => ({ ...session, isCurrent: session.id === currentSessionId }));
}

/** Signs out another device. The ownership check is part of the query. */
export async function revokeUserSession(userId: string, sessionId: string, currentSessionId: string): Promise<void> {
  if (sessionId === currentSessionId) {
    throw new AppError("VALIDATION", "Use “Log out” to end the session you're using now.");
  }
  const { count } = await db.session.deleteMany({ where: { id: sessionId, userId } });
  if (count === 0) throw new AppError("NOT_FOUND", "That session no longer exists.");
  await recordAuditEvent({ action: "auth.session_revoked", userId, details: { sessionId } });
}
