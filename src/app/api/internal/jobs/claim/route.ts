import { z } from "zod";
import { AppError } from "@/server/errors";
import { handleRoute, readJson } from "@/server/http";
import { claimNextJob } from "@/server/jobs/queue";
import { requireWorker } from "@/server/worker-auth";

const claimSchema = z.object({
  workerId: z.string().min(1).max(100),
  types: z.array(z.string().min(1).max(50)).min(1).max(20),
});

/** POST /api/internal/jobs/claim — a worker asks for the next job (204 when there's none). */
export function POST(request: Request) {
  return handleRoute(async () => {
    requireWorker(request);
    const parsed = claimSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid claim request.");
    const job = await claimNextJob(parsed.data.workerId, parsed.data.types);
    return job ? Response.json(job) : new Response(null, { status: 204 });
  });
}
