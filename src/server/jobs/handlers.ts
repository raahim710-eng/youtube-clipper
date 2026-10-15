import type { z } from "zod";
import type { Job, Prisma } from "@/generated/prisma/client";
import { aiFindClipsHandler } from "./ai-find-clips";
import { aiPackageHandler } from "./ai-package";
import { genFootageHandler } from "./gen-footage";
import { genNarrateHandler } from "./gen-narrate";
import { genRenderHandler } from "./gen-render";
import { genScriptHandler } from "./gen-script";
import { mediaIngestHandler } from "./media-ingest";
import { mediaReframeHandler } from "./media-reframe";
import { mediaRenderShortHandler } from "./media-render-short";
import { mediaThumbnailHandler } from "./media-thumbnail";
import { ytUploadHandler } from "./yt-upload";
import { mediaTranscribeHandler } from "./media-transcribe";

/**
 * What the app does with each job type's outcome. Workers only report results;
 * persisting them (and keeping related records consistent) happens here.
 */
export type JobHandler<Result> = {
  /** Validates what the worker sends to /complete. */
  resultSchema: z.ZodType<Result>;
  /** Persists a successful result (inside the same transaction that marks the job done). */
  onSucceeded: (tx: Prisma.TransactionClient, job: Job, result: Result) => Promise<void>;
  /** Called after the job ends as failed or cancelled. */
  onFailed: (job: Job) => Promise<void>;
  /** Returns a user-facing reason a retry isn't possible, or null. */
  cannotRetryReason: (job: Job) => Promise<string | null>;
  /** Resets related records when the user retries (inside a transaction). */
  onRetry: (tx: Prisma.TransactionClient, job: Job) => Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry of differently-typed handlers
const HANDLERS: Record<string, JobHandler<any>> = {
  "media.ingest": mediaIngestHandler,
  "media.transcribe": mediaTranscribeHandler,
  "ai.find_clips": aiFindClipsHandler,
  "media.reframe": mediaReframeHandler,
  "media.render_short": mediaRenderShortHandler,
  "ai.package": aiPackageHandler,
  "media.thumbnail_mockup": mediaThumbnailHandler,
  "yt.upload": ytUploadHandler,
  "gen.script": genScriptHandler,
  "gen.narrate": genNarrateHandler,
  "gen.footage": genFootageHandler,
  "gen.render": genRenderHandler,
};

export function getJobHandler(type: string): JobHandler<unknown> {
  const handler = HANDLERS[type];
  if (!handler) throw new Error(`No handler registered for job type "${type}"`);
  return handler;
}
