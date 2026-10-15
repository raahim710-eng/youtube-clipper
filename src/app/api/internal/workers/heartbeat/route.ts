import { z } from "zod";
import { AppError } from "@/server/errors";
import { handleRoute, readJson } from "@/server/http";
import { recordWorkerHeartbeat } from "@/server/jobs/queue";
import { requireWorker } from "@/server/worker-auth";

const heartbeatSchema = z.object({
  workerId: z.string().min(1).max(100),
  kind: z.enum(["python", "node"]),
  version: z.string().min(1).max(30),
  capabilities: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});

/** POST /api/internal/workers/heartbeat — "I'm alive", shown on Settings › System status. */
export function POST(request: Request) {
  return handleRoute(async () => {
    requireWorker(request);
    const parsed = heartbeatSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid worker heartbeat.");
    await recordWorkerHeartbeat(parsed.data);
    return new Response(null, { status: 204 });
  });
}
