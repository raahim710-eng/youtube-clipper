import { handleRoute } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { listJobs } from "@/server/services/jobs";

/** GET /api/jobs — recent jobs for the activity drawer (JOB-02). */
export function GET() {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const jobs = await listJobs(session.user.id, { limit: 20 });
    return Response.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
  });
}
