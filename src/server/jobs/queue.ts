import type { Prisma } from "@/generated/prisma/client";
import { ACTIVE_JOB_STATUSES, type JobType } from "@/lib/constants";
import { db } from "../db";
import { AppError } from "../errors";
import { logger } from "../logger";
import { getJobHandler } from "./handlers";

/**
 * Database-backed job queue (DECISIONS.md D-006, ARCHITECTURE.md §3).
 * Shared with future Node workers, so it must not import Next.js APIs.
 *
 * Lifecycle: queued → running (claimed with a lease) → succeeded | failed | cancelled.
 * Crashed workers are recovered when their lease expires.
 */

export const LEASE_MS = 60_000;
const RETRY_BACKOFF_MS = 15_000;

type Tx = Prisma.TransactionClient;

export type EnqueueInput = {
  userId: string;
  type: JobType;
  payload: Record<string, unknown>;
  entityType?: string;
  entityId?: string;
  priority?: number;
  maxAttempts?: number;
};

/**
 * Refuses to queue a second active job of the same type for the same item. Call it inside the transaction
 * that queues the job: Prisma's SQLite adapter runs transactions one at a time, so two simultaneous
 * requests (a double click) can't both pass — the check before the transaction is only for a quick answer.
 */
export async function assertNoActiveJob(
  tx: Tx,
  where: { entityType: string; entityId: string; type: JobType },
  message: string,
): Promise<void> {
  const active = await tx.job.count({ where: { ...where, status: { in: [...ACTIVE_JOB_STATUSES] } } });
  if (active > 0) throw new AppError("CONFLICT", message);
}

export async function enqueueJob(input: EnqueueInput, tx: Tx = db) {
  return tx.job.create({
    data: {
      userId: input.userId,
      type: input.type,
      payloadJson: JSON.stringify(input.payload),
      entityType: input.entityType,
      entityId: input.entityId,
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? 3,
    },
  });
}

export type ClaimedJob = {
  id: string;
  type: string;
  attempt: number;
  payload: unknown;
  leaseExpiresAt: string;
};

/**
 * Atomically claims the next runnable job of the given types for `workerId`.
 * The conditional update (status still "queued") is the compare-and-set that stops
 * two workers from claiming the same job.
 */
export async function claimNextJob(workerId: string, types: string[]): Promise<ClaimedJob | null> {
  await recoverExpiredLeases();
  for (let tries = 0; tries < 5; tries += 1) {
    const now = new Date();
    const candidate = await db.job.findFirst({
      where: { status: "queued", type: { in: types }, runAfter: { lte: now }, cancelRequested: false },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;

    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const { count } = await db.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: {
        status: "running",
        lockedBy: workerId,
        leaseExpiresAt,
        attempts: { increment: 1 },
        progress: 0,
        progressMessage: "Starting…",
        startedAt: now,
      },
    });
    if (count === 0) continue; // another worker won the race; try the next job

    const job = await db.job.findUniqueOrThrow({ where: { id: candidate.id } });
    return {
      id: job.id,
      type: job.type,
      attempt: job.attempts,
      payload: JSON.parse(job.payloadJson) as unknown,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  }
  return null;
}

async function getOwnedRunningJob(jobId: string, workerId: string) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) throw new AppError("NOT_FOUND", "Job not found.");
  if (job.status !== "running" || job.lockedBy !== workerId) {
    throw new AppError("CONFLICT", "This worker no longer holds the job.");
  }
  return job;
}

/** Progress report + lease extension. Tells the worker whether the user asked to cancel. */
export async function heartbeatJob(
  jobId: string,
  workerId: string,
  progress: number,
  message?: string,
): Promise<{ cancelRequested: boolean; leaseExpiresAt: string }> {
  const job = await getOwnedRunningJob(jobId, workerId);
  const leaseExpiresAt = new Date(Date.now() + LEASE_MS);
  await db.job.update({
    where: { id: job.id },
    data: {
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      progressMessage: message?.slice(0, 200) ?? job.progressMessage,
      leaseExpiresAt,
    },
  });
  return { cancelRequested: job.cancelRequested, leaseExpiresAt: leaseExpiresAt.toISOString() };
}

/** A transient database problem (busy or locked): the worker should simply report again. */
function isTransientDbError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /SQLITE_BUSY|database is locked|P1008|P2034|Transaction already closed/i.test(text);
}

/**
 * Validates the worker's result and lets the job type persist it, in one transaction. The job is marked
 * done first, conditionally (still running, still this worker's) — so a duplicate report, a lease that
 * expired meanwhile or a cancellation can never apply a result twice (compare-and-set).
 */
export async function completeJob(jobId: string, workerId: string, rawResult: unknown): Promise<void> {
  const job = await getOwnedRunningJob(jobId, workerId);
  const handler = getJobHandler(job.type);
  const owned = { status: "running", lockedBy: workerId };
  const parsed = handler.resultSchema.safeParse(rawResult);
  if (!parsed.success) {
    logger.error("Worker returned an invalid job result", { jobId, type: job.type, issues: parsed.error.issues });
    await finishAsFailed(job.id, "INVALID_RESULT", "The worker returned an unexpected result.", owned);
    throw new AppError("VALIDATION", "Invalid job result.");
  }

  try {
    await db.$transaction(async (tx) => {
      const { count } = await tx.job.updateMany({
        where: { id: job.id, ...owned },
        data: {
          status: "succeeded",
          progress: 100,
          progressMessage: "Done",
          resultJson: JSON.stringify(parsed.data),
          lockedBy: null,
          leaseExpiresAt: null,
          finishedAt: new Date(),
          error: null,
          errorCode: null,
        },
      });
      if (count !== 1) throw new AppError("CONFLICT", "This worker no longer holds the job.");
      await handler.onSucceeded(tx, job, parsed.data);
    });
  } catch (error) {
    if (error instanceof AppError || isTransientDbError(error)) throw error; // the worker reports again
    // The result can't be saved (e.g. it names a file the app didn't ask for): retrying the whole job
    // would only fail again, so fail it now with a safe message and keep the details in the log.
    logger.error("Couldn't save a job result", { jobId, type: job.type, error });
    await finishAsFailed(job.id, "RESULT_REJECTED", "The result couldn't be saved. Try again.", owned);
    throw new AppError("VALIDATION", "The job result was rejected.");
  }
}

export type FailureReport = {
  code: string;
  message: string;
  retryable: boolean;
};

/** Worker reports a failure: retry later, mark cancelled, or fail for good. */
export async function failJob(jobId: string, workerId: string, failure: FailureReport): Promise<void> {
  const job = await getOwnedRunningJob(jobId, workerId);
  const owned = { status: "running", lockedBy: workerId };
  let applied: boolean;
  if (failure.code === "CANCELLED" || job.cancelRequested) applied = await finishAsCancelled(job.id, owned);
  else if (failure.retryable && job.attempts < job.maxAttempts)
    applied = await requeue(job.id, job.attempts, failure, owned);
  else applied = await finishAsFailed(job.id, failure.code, failure.message, owned);
  if (!applied) throw new AppError("CONFLICT", "This worker no longer holds the job.");
}

/** Conditions a transition requires, e.g. "still running and held by this worker" (compare-and-set). */
type Guard = Prisma.JobWhereInput;

async function requeue(jobId: string, attempts: number, failure: FailureReport, guard: Guard): Promise<boolean> {
  const { count } = await db.job.updateMany({
    where: { id: jobId, ...guard },
    data: {
      status: "queued",
      lockedBy: null,
      leaseExpiresAt: null,
      runAfter: new Date(Date.now() + RETRY_BACKOFF_MS * attempts),
      progress: 0,
      progressMessage: "Waiting to retry…",
      error: failure.message.slice(0, 500),
      errorCode: failure.code.slice(0, 50),
    },
  });
  return count === 1;
}

/** Marks the job failed if `guard` still holds, then lets its type update related records. */
async function finishAsFailed(jobId: string, code: string, message: string, guard: Guard): Promise<boolean> {
  const { count } = await db.job.updateMany({
    where: { id: jobId, ...guard },
    data: {
      status: "failed",
      lockedBy: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      error: message.slice(0, 500),
      errorCode: code.slice(0, 50),
    },
  });
  if (count !== 1) return false;
  await runOnFailed(jobId);
  return true;
}

async function finishAsCancelled(jobId: string, guard: Guard): Promise<boolean> {
  const { count } = await db.job.updateMany({
    where: { id: jobId, ...guard },
    data: {
      status: "cancelled",
      lockedBy: null,
      leaseExpiresAt: null,
      finishedAt: new Date(),
      progressMessage: "Cancelled",
      error: "Cancelled by you.",
      errorCode: "CANCELLED",
    },
  });
  if (count !== 1) return false;
  await runOnFailed(jobId);
  return true;
}

async function runOnFailed(jobId: string): Promise<void> {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  try {
    await getJobHandler(job.type).onFailed(job);
  } catch (error) {
    // The job's own state is already final; a related record may need a retry by the user.
    logger.error("Couldn't update records after a failed job", { jobId, type: job.type, error });
  }
}

/**
 * Requeues (or fails) running jobs whose worker stopped sending heartbeats. Safe to run from several
 * processes at once: each transition only applies while the lease is still expired.
 */
export async function recoverExpiredLeases(now = new Date()): Promise<number> {
  const expired = await db.job.findMany({
    where: { status: "running", leaseExpiresAt: { lt: now } },
    select: { id: true, attempts: true, maxAttempts: true, cancelRequested: true },
  });
  let recovered = 0;
  for (const job of expired) {
    const guard: Guard = { status: "running", leaseExpiresAt: { lt: now } };
    let applied: boolean;
    if (job.cancelRequested) applied = await finishAsCancelled(job.id, guard);
    else if (job.attempts < job.maxAttempts) {
      applied = await requeue(
        job.id,
        job.attempts,
        { code: "WORKER_LOST", message: "The worker stopped responding; trying again.", retryable: true },
        guard,
      );
    } else applied = await finishAsFailed(job.id, "WORKER_LOST", "The worker stopped responding several times.", guard);
    if (applied) recovered += 1;
  }
  if (recovered > 0) logger.warn("Recovered jobs with expired leases", { count: recovered });
  return recovered;
}

/** User cancels a job: queued jobs stop immediately, running ones at the worker's next heartbeat. */
export async function cancelJob(userId: string, jobId: string): Promise<void> {
  const job = await db.job.findFirst({ where: { id: jobId, userId } });
  if (!job) throw new AppError("NOT_FOUND", "Job not found.");
  if (!ACTIVE_JOB_STATUSES.includes(job.status as (typeof ACTIVE_JOB_STATUSES)[number])) {
    throw new AppError("VALIDATION", "This job has already finished.");
  }
  if (job.status === "queued" && (await finishAsCancelled(job.id, { status: "queued" }))) return;
  // Running (or claimed a moment ago): the worker sees the request with its next heartbeat.
  await db.job.updateMany({
    where: { id: job.id, status: "running" },
    data: { cancelRequested: true, progressMessage: "Cancelling…" },
  });
}

/** User retries a failed or cancelled job (if its type allows it, e.g. the source file still exists). */
export async function retryJob(userId: string, jobId: string): Promise<void> {
  const job = await db.job.findFirst({ where: { id: jobId, userId } });
  if (!job) throw new AppError("NOT_FOUND", "Job not found.");
  if (job.status !== "failed" && job.status !== "cancelled") {
    throw new AppError("VALIDATION", "Only failed or cancelled jobs can be retried.");
  }
  const handler = getJobHandler(job.type);
  const reason = await handler.cannotRetryReason(job);
  if (reason) throw new AppError("VALIDATION", reason);

  await db.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        status: "queued",
        attempts: 0,
        cancelRequested: false,
        runAfter: new Date(),
        progress: 0,
        progressMessage: null,
        error: null,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    await handler.onRetry(tx, job);
  });
}

/**
 * Cancels every unfinished job for an entity (e.g. before deleting a video), or only jobs of one type
 * (e.g. face tracking that a newer request replaces).
 */
export async function cancelJobsForEntity(
  entityType: string,
  entityId: string,
  tx: Tx = db,
  type?: JobType,
): Promise<void> {
  const where = { entityType, entityId, ...(type ? { type } : {}) };
  await tx.job.updateMany({
    where: { ...where, status: "queued" },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
      error: type ? "Replaced by a newer request." : "Cancelled because the item was deleted.",
      errorCode: "CANCELLED",
    },
  });
  await tx.job.updateMany({
    where: { ...where, status: "running" },
    data: { cancelRequested: true },
  });
}

/** Worker liveness for Settings › System status. */
export async function recordWorkerHeartbeat(input: {
  workerId: string;
  kind: string;
  version: string;
  capabilities: Record<string, unknown>;
}): Promise<void> {
  const data = {
    kind: input.kind,
    version: input.version,
    capabilitiesJson: JSON.stringify(input.capabilities),
    lastSeenAt: new Date(),
  };
  await db.workerHeartbeat.upsert({
    where: { workerId: input.workerId },
    create: { workerId: input.workerId, ...data },
    update: data,
  });
}
