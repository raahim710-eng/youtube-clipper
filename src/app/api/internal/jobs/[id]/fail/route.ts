import { z } from "zod";
import { AppError } from "@/server/errors";
import { handleRoute, readJson } from "@/server/http";
import { failJob } from "@/server/jobs/queue";
import { requireWorker } from "@/server/worker-auth";

const failSchema = z.object({
  workerId: z.string().min(1).max(100),
  code: z.string().min(1).max(50),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});

/** POST /api/internal/jobs/{id}/fail — the worker reports a failure (the message is shown to the user). */
export function POST(request: Request, context: RouteContext<"/api/internal/jobs/[id]/fail">) {
  return handleRoute(async () => {
    requireWorker(request);
    const { id } = await context.params;
    const parsed = failSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid failure report.");
    const { workerId, ...failure } = parsed.data;
    await failJob(id, workerId, failure);
    return new Response(null, { status: 204 });
  });
}
