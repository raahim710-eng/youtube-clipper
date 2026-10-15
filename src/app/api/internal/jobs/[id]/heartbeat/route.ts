import { z } from "zod";
import { AppError } from "@/server/errors";
import { handleRoute, readJson } from "@/server/http";
import { heartbeatJob } from "@/server/jobs/queue";
import { requireWorker } from "@/server/worker-auth";

const heartbeatSchema = z.object({
  workerId: z.string().min(1).max(100),
  progress: z.number().min(0).max(100),
  message: z.string().max(200).optional(),
});

/** POST /api/internal/jobs/{id}/heartbeat — progress + lease extension; replies whether to cancel. */
export function POST(request: Request, context: RouteContext<"/api/internal/jobs/[id]/heartbeat">) {
  return handleRoute(async () => {
    requireWorker(request);
    const { id } = await context.params;
    const parsed = heartbeatSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid heartbeat.");
    const { workerId, progress, message } = parsed.data;
    return Response.json(await heartbeatJob(id, workerId, progress, message));
  });
}
