import { db } from "./db";
import { logger, redact } from "./logger";

export type AuditAction =
  | "auth.setup_completed"
  | "auth.login"
  | "auth.login_failed"
  | "auth.password_changed"
  | "auth.session_revoked"
  | "video.deleted"
  | "short.created"
  | "short.deleted"
  | "youtube.connected"
  | "youtube.disconnected"
  | "youtube.upload_queued"
  | "generator.project_created"
  | "generator.project_deleted";

/**
 * Writes a security event to AuditLog. Never throws: a logging failure must not
 * break login. Details are redacted and must not contain secrets.
 */
export async function recordAuditEvent(event: {
  action: AuditAction;
  userId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: event.action,
        userId: event.userId ?? null,
        detailsJson: JSON.stringify(redact(event.details ?? {})),
        ipAddress: event.ipAddress ?? null,
      },
    });
  } catch (error) {
    logger.error("Failed to write audit event", { action: event.action, error });
  }
}
