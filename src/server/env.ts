import { z } from "zod";
import type { UploadLimits } from "@/lib/uploads";
import { DEFAULT_DATABASE_URL } from "./database-url";

/**
 * Server environment variables, validated with Zod.
 * Documentation for each variable lives in `.env.example`.
 *
 * Validation is lazy (on first use) so that `next build` and pages that only
 * need to show a "configuration required" message never crash on a missing value.
 */

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_NAME: z.string().trim().min(1).default("Creator Studio Assistant"),
  DATABASE_URL: z.string().trim().min(1).default(DEFAULT_DATABASE_URL),
  BETTER_AUTH_SECRET: optionalString,
  BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  STORAGE_DIR: z.string().trim().min(1).default("./storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(1_000_000).default(4096),
  MAX_VIDEO_DURATION_MIN: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(180),
  FFMPEG_PATH: optionalString,
  FFPROBE_PATH: optionalString,
  WORKER_SHARED_SECRET: optionalString,
  // Transcription & clip analysis (Phase 4) — documented in .env.example
  TRANSCRIPTION_PROVIDER: z.enum(["faster-whisper"]).default("faster-whisper"),
  WHISPER_MODEL: z.string().trim().min(1).default("base"),
  CLIP_MIN_SEC: z.coerce.number().int().min(5).max(170).default(15),
  CLIP_MAX_SEC: z.coerce.number().int().min(10).max(180).default(60),
  CLIP_MAX_SUGGESTIONS: z.coerce.number().int().min(1).max(30).default(10),
  CLIP_AI_CANDIDATES: z.coerce.number().int().min(1).max(60).default(12),
  CLIP_AI_BATCH_SIZE: z.coerce.number().int().min(1).max(8).default(1),
  // Packaging (Phase 6): longer transcripts are summarised in parts of this many words first.
  PACKAGING_MAX_INPUT_WORDS: z.coerce.number().int().min(200).max(20_000).default(1500),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: optionalString,
  OPENAI_COMPAT_BASE_URL: optionalString,
  OPENAI_COMPAT_MODEL: optionalString,
  GEMINI_MODEL: optionalString,
  // Later phases — read here only to report "configured / not configured" on the status page.
  TOKEN_ENCRYPTION_KEY: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  // YouTube integration (Phase 7)
  GOOGLE_REDIRECT_URI: optionalString,
  YOUTUBE_API_AUDITED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  YOUTUBE_DAILY_UNITS: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
  YOUTUBE_DAILY_UPLOADS: z.coerce.number().int().min(1).max(10_000).default(100),
  YOUTUBE_UPLOAD_CHUNK_KB: z.coerce
    .number()
    .int()
    .min(256)
    .max(262_144)
    .refine((kb) => kb % 256 === 0, "must be a multiple of 256")
    .default(8_192),
  // Test-only: send every Google request to a local stand-in (tests/support/fake-google.mjs).
  // Only http://127.0.0.1 or http://localhost addresses are accepted, so tokens can't go anywhere else.
  GOOGLE_API_TEST_BASE_URL: optionalString.refine(
    (value) => !value || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(value),
    "must be http://127.0.0.1:<port> or http://localhost:<port>",
  ),
  GEMINI_API_KEY: optionalString,
  PEXELS_API_KEY: optionalString,
  PIXABAY_API_KEY: optionalString,
  // Original video generator (Phase 9): narration voice engine (media worker). sapi = Windows voices.
  TTS_PROVIDER: z.enum(["sapi", "kokoro"]).default("sapi"),
  // Housekeeping (Phase 10): how often the Node worker removes unused files, and how long an unused
  // stock clip stays cached.
  MAINTENANCE_INTERVAL_MIN: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(60),
  STOCK_CACHE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2000),
  TTS_VOICE: optionalString,
});

export type ServerEnv = z.infer<typeof envSchema>;

export const MIN_SECRET_LENGTH = 32;

let cachedEnv: ServerEnv | undefined;

/** Parses the environment. Throws only if a value has an invalid format (not if it's missing). */
export function getEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (source === process.env && cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${details}. See .env.example.`);
  }
  if (source === process.env) cachedEnv = parsed.data;
  return parsed.data;
}

export type ConfigProblem = {
  variable: string;
  message: string;
};

/**
 * Lists configuration that must be fixed before login can work.
 * Used by /login and /setup to show an honest "configuration required" screen
 * instead of pretending authentication is ready.
 */
export function getAuthConfigProblems(source: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  let env: ServerEnv;
  try {
    env = getEnv(source);
  } catch (error) {
    return [{ variable: ".env", message: error instanceof Error ? error.message : String(error) }];
  }

  if (!env.BETTER_AUTH_SECRET) {
    problems.push({
      variable: "BETTER_AUTH_SECRET",
      message: "Missing. Run `npm run setup:env` or generate a random value (see README).",
    });
  } else if (env.BETTER_AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    problems.push({
      variable: "BETTER_AUTH_SECRET",
      message: `Too short. Use at least ${MIN_SECRET_LENGTH} random characters.`,
    });
  }

  if (!env.DATABASE_URL.startsWith("file:")) {
    problems.push({
      variable: "DATABASE_URL",
      message: 'Must be a SQLite file URL such as "file:./data/app.db".',
    });
  }

  return problems;
}

/** Upload limits from MAX_UPLOAD_MB / MAX_VIDEO_DURATION_MIN (shown in the UI and enforced on the server). */
export function getUploadLimits(source: NodeJS.ProcessEnv = process.env): UploadLimits {
  const env = getEnv(source);
  return { maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024, maxDurationMinutes: env.MAX_VIDEO_DURATION_MIN };
}

/** Why the internal worker API can't be used, or null when WORKER_SHARED_SECRET is fine. */
export function getWorkerSecretProblem(source: NodeJS.ProcessEnv = process.env): string | null {
  const secret = getEnv(source).WORKER_SHARED_SECRET;
  if (!secret) return "WORKER_SHARED_SECRET is missing. Run `npm run setup:env` on a fresh install or add it to .env.";
  if (secret.length < MIN_SECRET_LENGTH)
    return `WORKER_SHARED_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`;
  return null;
}

/** Test helper: forget the cached environment. */
export function resetEnvCacheForTests(): void {
  cachedEnv = undefined;
}
