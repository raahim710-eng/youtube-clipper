// `npm run start:all` runs the worker with --production, like `next start` runs the app (test-only
// settings such as GOOGLE_API_TEST_BASE_URL are ignored in production).
import "./production-flag";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import { getEnv } from "@/server/env";
import { claimNextJob, completeJob, failJob, heartbeatJob, recordWorkerHeartbeat } from "@/server/jobs/queue";
import { logger } from "@/server/logger";
import { runMaintenance } from "@/server/maintenance";
import { youtubeConfig } from "@/server/youtube/config";
import { runYouTubeUpload, toUploadFailure, UploadCancelled } from "@/server/youtube/upload";

/**
 * Node integration worker (DECISIONS.md D-007, D-028): runs `yt.*` jobs. It shares the database and the
 * token module with the app, so OAuth tokens never travel through job payloads or the worker API.
 * Start with `npm run worker:yt` (or `npm run dev:all`).
 */

const TYPES = ["yt.upload"];
const VERSION = "0.1.0";
const env = getEnv();
const POLL_MS = env.WORKER_POLL_INTERVAL_MS;
const MAINTENANCE_MS = env.MAINTENANCE_INTERVAL_MIN * 60_000;
const HEARTBEAT_MS = 15_000;
const workerId = `node-${os.hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const payloadSchema = z.object({ publicationId: z.string().min(1) });

let stopping = false;
let current: { id: string } | null = null;

function capabilities() {
  const config = youtubeConfig();
  return {
    jobTypes: TYPES.join(","),
    youtubeConfigured: config.ok,
    testServer: config.ok && config.config.usingTestServer,
  };
}

async function runJob(job: { id: string; payload: unknown }) {
  current = { id: job.id };
  let progress = 0;
  let message = "Starting";
  let cancelRequested = false;
  const beat = async () => {
    const result = await heartbeatJob(job.id, workerId, progress, message);
    cancelRequested = result.cancelRequested;
  };
  // Long chunks on a slow connection could outlast the 60 s lease; keep it alive meanwhile.
  const keepAlive = setInterval(() => void beat().catch(() => undefined), 10_000);
  let lastBeat = 0;
  try {
    const { publicationId } = payloadSchema.parse(job.payload);
    const result = await runYouTubeUpload(publicationId, async (fraction, text) => {
      progress = Math.round(fraction * 100);
      message = text;
      if (Date.now() - lastBeat > 2_000) {
        lastBeat = Date.now();
        await beat();
      }
      return cancelRequested || stopping;
    });
    await completeJob(job.id, workerId, result);
    logger.info("YouTube upload finished", { jobId: job.id });
  } catch (error) {
    if (error instanceof UploadCancelled) {
      await failJob(
        job.id,
        workerId,
        stopping
          ? {
              code: "WORKER_STOPPED",
              message: "The worker was stopped; the upload will continue later.",
              retryable: true,
            }
          : { code: "CANCELLED", message: "Cancelled by you.", retryable: false },
      );
    } else {
      const failure = toUploadFailure(error);
      logger.warn("YouTube upload failed", { jobId: job.id, code: failure.code, retryable: failure.retryable });
      await failJob(job.id, workerId, { code: failure.code, message: failure.message, retryable: failure.retryable });
    }
  } finally {
    clearInterval(keepAlive);
    current = null;
  }
}

async function main() {
  logger.info("Node integration worker ready", { workerId, types: TYPES });
  let lastHeartbeat = 0;
  let lastMaintenance = 0;
  while (!stopping) {
    try {
      // Housekeeping between jobs (never during an upload): unused files, failed deletions, stale uploads.
      if (Date.now() - lastMaintenance > MAINTENANCE_MS) {
        lastMaintenance = Date.now();
        await runMaintenance({ stockCacheDays: env.STOCK_CACHE_DAYS }).catch((error: unknown) =>
          logger.error("Maintenance failed", { error }),
        );
      }
      if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        await recordWorkerHeartbeat({ workerId, kind: "node", version: VERSION, capabilities: capabilities() });
        lastHeartbeat = Date.now();
      }
      const job = await claimNextJob(workerId, TYPES);
      if (job) {
        logger.info("Running job", { jobId: job.id, type: job.type, attempt: job.attempt });
        await runJob(job);
        continue;
      }
    } catch (error) {
      logger.error("Worker loop error", { error });
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (!current) process.exit(0);
    setTimeout(() => process.exit(0), 15_000).unref(); // give the running upload time to report back
  });
}

void main();
