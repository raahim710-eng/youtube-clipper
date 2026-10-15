import { getCurrentSession } from "@/server/session";
import { handleRoute } from "@/server/http";
import { getSystemStatus } from "@/server/services/system-status";

/**
 * GET /api/health
 * - Signed out: only `{ ok, checkedAt }` (no details about the machine).
 * - Signed in: full dependency report (FND-06).
 */
export function GET(): Promise<Response> {
  // handleRoute marks this as per-request, so it is never prerendered at build time.
  return handleRoute(async () => {
    const [session, status] = await Promise.all([getCurrentSession(), getSystemStatus()]);
    const ok = status.counts.error === 0;
    const headers = { "Cache-Control": "no-store" };

    if (!session) {
      return Response.json({ ok, checkedAt: status.checkedAt }, { status: ok ? 200 : 503, headers });
    }
    return Response.json({ ok, ...status }, { status: ok ? 200 : 503, headers });
  });
}
