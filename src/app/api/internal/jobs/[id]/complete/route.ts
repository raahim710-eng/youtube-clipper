import { z } from "zod";
import { AppError } from "@/server/errors";
import { handleRoute, readJson } from "@/server/http";
import { completeJob } from "@/server/jobs/queue";
import { requireWorker } from "@/server/worker-auth";

const completeSchema = z.object({
  workerId: z.string().min(1).max(100),
  result: z.unknown(),
});

/** POST /api/internal/jobs/{id}/complete — the result is validated by the job type's schema. */
export function POST(request: Request, context: RouteContext<"/api/internal/jobs/[id]/complete">) {
  return handleRoute(async () => {
    requireWorker(request);
    const { id } = await context.params;
    const parsed = completeSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid completion.");
    await completeJob(id, parsed.data.workerId, parsed.data.result);
    return new Response(null, { status: 204 });
  });
}
