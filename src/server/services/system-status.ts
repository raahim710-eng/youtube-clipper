import "server-only";
import { execFile } from "node:child_process";
import { CURRENT_PHASE } from "@/lib/app-config";
import { db } from "../db";
import { youtubeConfig } from "../youtube/config";
import { getAuthConfigProblems, getEnv, getWorkerSecretProblem, type ServerEnv } from "../env";
import { checkStorageWritable, getStorageRoot } from "../storage";
import { getProviderStatuses } from "./ai-providers";
import { WORKER_OFFLINE_AFTER_MS } from "./jobs";

/**
 * Dependency checks shown on Settings › System status and summarised on the
 * dashboard (FND-06, DASH-06). Results are cached briefly because some checks
 * start external programs.
 */

export type CheckStatus = "ok" | "warning" | "error" | "info";

export type StatusCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  summary: string;
  /** How to fix it, shown when status isn't "ok". */
  hint?: string;
  /** The roadmap phase that first needs this dependency. */
  neededFromPhase?: number;
};

export type StatusGroup = { title: string; checks: StatusCheck[] };

export type SystemStatus = {
  checkedAt: string;
  groups: StatusGroup[];
  counts: Record<CheckStatus, number>;
};

const CACHE_MS = 30_000;
let cached: { at: number; value: SystemStatus } | undefined;

export async function getSystemStatus(options: { fresh?: boolean } = {}): Promise<SystemStatus> {
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await runChecks();
  cached = { at: Date.now(), value };
  return value;
}

async function runChecks(): Promise<SystemStatus> {
  const env = getEnv();
  const [database, storage, ffmpeg, ffprobe, ollama, worker, transcription, shorts, youtubeWorker, narration] =
    await Promise.all([
      checkDatabase(),
      checkStorage(env),
      checkMediaBinary("ffmpeg", env.FFMPEG_PATH ?? "ffmpeg", "FFMPEG_PATH"),
      checkMediaBinary("ffprobe", env.FFPROBE_PATH ?? "ffprobe", "FFPROBE_PATH"),
      checkOllama(env),
      checkMediaWorker(),
      checkTranscription(env),
      checkShortsTools(),
      checkYouTubeWorker(),
      checkNarration(env),
    ]);

  const groups: StatusGroup[] = [
    { title: "Core", checks: [database, storage, checkAuthConfig()] },
    { title: "Media tools", checks: [ffmpeg, ffprobe, ...shorts] },
    {
      title: "AI",
      checks: [
        transcription,
        ollama,
        optionalKey("gemini", "Gemini API key (optional)", env.GEMINI_API_KEY, 4),
        narration,
      ],
    },
    { title: "Background workers", checks: [checkWorkerSecret(), worker, youtubeWorker] },
    {
      title: "Integrations",
      checks: [
        googleOAuthCheck(env),
        optionalKey(
          "pexels",
          "Pexels API key (stock footage, optional)",
          env.PEXELS_API_KEY,
          9,
          "Without it the video generator uses your library videos and uploaded clips. Free key: pexels.com/api — add `PEXELS_API_KEY` to .env and restart.",
        ),
        optionalKey(
          "pixabay",
          "Pixabay API key (optional)",
          env.PIXABAY_API_KEY,
          9,
          "More stock footage for the video generator. Free key: pixabay.com/api/docs — add `PIXABAY_API_KEY` to .env and restart.",
        ),
      ],
    },
  ];

  const counts: Record<CheckStatus, number> = { ok: 0, warning: 0, error: 0, info: 0 };
  for (const check of groups.flatMap((group) => group.checks)) counts[check.status] += 1;

  return { checkedAt: new Date().toISOString(), groups, counts };
}

async function checkDatabase(): Promise<StatusCheck> {
  const base = { id: "database", label: "Database (SQLite)", neededFromPhase: 2 };
  try {
    const tables = await db.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'session', 'audit_log')`;
    if (tables.length < 3) {
      return {
        ...base,
        status: "error",
        summary: "The database exists but its tables are missing.",
        hint: "Run `npm run db:migrate`.",
      };
    }
    return { ...base, status: "ok", summary: "Connected and up to date." };
  } catch {
    return {
      ...base,
      status: "error",
      summary: "Cannot open the database.",
      hint: "Check DATABASE_URL in .env, then run `npm run db:migrate`.",
    };
  }
}

async function checkStorage(env: ServerEnv): Promise<StatusCheck> {
  const base = { id: "storage", label: "Media storage folder", neededFromPhase: 2 };
  try {
    await checkStorageWritable(getStorageRoot(env.STORAGE_DIR));
    return { ...base, status: "ok", summary: "Writable." };
  } catch {
    return {
      ...base,
      status: "error",
      summary: "The storage folder can't be created or written to.",
      hint: "Check STORAGE_DIR in .env and folder permissions.",
    };
  }
}

function checkAuthConfig(): StatusCheck {
  const problems = getAuthConfigProblems();
  return problems.length === 0
    ? { id: "auth", label: "Login configuration", status: "ok", summary: "Configured.", neededFromPhase: 2 }
    : {
        id: "auth",
        label: "Login configuration",
        status: "error",
        summary: problems.map((p) => `${p.variable}: ${p.message}`).join(" "),
        hint: "Fix .env and restart the app.",
        neededFromPhase: 2,
      };
}

function runVersionCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Argument array, no shell (SECURITY.md §4).
    execFile(command, ["-hide_banner", "-version"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function checkMediaBinary(name: "ffmpeg" | "ffprobe", command: string, envVar: string): Promise<StatusCheck> {
  const base = { id: name, label: name === "ffmpeg" ? "FFmpeg" : "ffprobe", neededFromPhase: 3 };
  try {
    const output = await runVersionCommand(command);
    const version = /version\s+(\S+)/.exec(output)?.[1] ?? "unknown version";
    if (name === "ffmpeg" && !output.includes("--enable-libass")) {
      return {
        ...base,
        status: "warning",
        summary: `Found ${version}, but it was built without libass (needed for burned-in captions).`,
        hint: "Install a full build, e.g. `winget install Gyan.FFmpeg`.",
      };
    }
    return { ...base, status: "ok", summary: `Found ${version}.` };
  } catch {
    return {
      ...base,
      // Required from Phase 3: a problem now, not just a heads-up.
      status: CURRENT_PHASE >= base.neededFromPhase ? "error" : "warning",
      summary: "Not found.",
      hint: `Needed to process videos. Install with \`winget install Gyan.FFmpeg\` and restart the app (new terminals pick up the PATH), or set ${envVar} in .env.`,
    };
  }
}

async function checkOllama(env: ServerEnv): Promise<StatusCheck> {
  const base = { id: "ollama", label: "Ollama (local AI for clip analysis)", neededFromPhase: 4 };
  const ollama = (await getProviderStatuses()).find((provider) => provider.id === "ollama");
  if (ollama?.ready) return { ...base, status: "ok", summary: `Running with ${env.OLLAMA_MODEL}.` };
  return {
    ...base,
    // Optional: clips can also be ranked without AI, or with another provider.
    status: env.OLLAMA_MODEL ? "warning" : "info",
    summary: ollama?.problem ?? "Not available.",
    hint: `${ollama?.fix ?? ""} Without it, choose another provider or “speech patterns only” in Settings › AI & processing.`.trim(),
  };
}

/** Whether the media worker can transcribe (reported in its heartbeat). */
async function checkTranscription(env: ServerEnv): Promise<StatusCheck> {
  const base = { id: "transcription", label: "Transcription (speech to text)", neededFromPhase: 4 };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  if (!latest || Date.now() - latest.lastSeenAt.getTime() >= WORKER_OFFLINE_AFTER_MS) {
    return {
      ...base,
      status: "info",
      summary: "Unknown until the media worker runs.",
      hint: "Start the app with `npm run dev:all`.",
    };
  }
  const caps = JSON.parse(latest.capabilitiesJson) as { transcription?: string | null };
  if (caps.transcription) return { ...base, status: "ok", summary: `${caps.transcription}, runs on this computer.` };
  return {
    ...base,
    status: "error",
    summary: `The ${env.TRANSCRIPTION_PROVIDER} engine can't load.`,
    hint: "Run `npm run worker:setup`. On Windows also install the Visual C++ runtime: `winget install Microsoft.VCRedist.2015+.x64`. Then restart `npm run dev:all`.",
  };
}

/** Caption burning (FFmpeg with libass) and face tracking (OpenCV), as reported by the media worker. */
async function checkShortsTools(): Promise<StatusCheck[]> {
  const captionsBase = { id: "captions", label: "Caption rendering (libass)", neededFromPhase: 5 };
  const facesBase = { id: "face-tracking", label: "Face tracking (auto framing)", neededFromPhase: 5 };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  if (!latest || Date.now() - latest.lastSeenAt.getTime() >= WORKER_OFFLINE_AFTER_MS) {
    const unknown = { status: "info" as const, summary: "Unknown until the media worker runs." };
    return [
      { ...captionsBase, ...unknown },
      { ...facesBase, ...unknown },
    ];
  }
  const caps = JSON.parse(latest.capabilitiesJson) as { captions?: boolean; faceTracking?: string | null };
  return [
    caps.captions
      ? { ...captionsBase, status: "ok", summary: "FFmpeg can burn captions into Shorts." }
      : {
          ...captionsBase,
          status: "warning",
          summary: "This FFmpeg build can't draw captions.",
          hint: "Install the full build (`winget install Gyan.FFmpeg`) and restart. Shorts without captions still export.",
        },
    caps.faceTracking
      ? { ...facesBase, status: "ok", summary: `${caps.faceTracking}.` }
      : {
          ...facesBase,
          status: "warning",
          summary: "OpenCV couldn't load, so Auto framing won't work.",
          hint: "Run `npm run worker:setup` and restart `npm run dev:all`. Centre, Blur and Manual framing still work.",
        },
  ];
}

function googleOAuthCheck(env: ServerEnv): StatusCheck {
  const result = youtubeConfig();
  const base = { id: "google", label: "Google OAuth client (YouTube)", neededFromPhase: 7 };
  if (!result.ok) {
    return {
      ...base,
      status: "info",
      summary: "Not set up — YouTube channels can't be connected yet.",
      hint: `${result.problems.join(" ")} See README › Google Cloud setup.`,
    };
  }
  if (result.config.usingTestServer) {
    return {
      ...base,
      status: "warning",
      summary: "GOOGLE_API_TEST_BASE_URL is set: Google requests go to a local test stand-in.",
      hint: "Remove GOOGLE_API_TEST_BASE_URL from .env to use real YouTube channels.",
    };
  }
  return {
    ...base,
    status: "ok",
    summary: `Configured. ${env.YOUTUBE_API_AUDITED ? "Marked as audited: public uploads and scheduling allowed." : "Not audited: uploads are private only."}`,
  };
}

/** The Node integration worker uploads to YouTube (Phase 7). */
async function checkYouTubeWorker(): Promise<StatusCheck> {
  const base = { id: "youtube-worker", label: "YouTube upload worker (Node)", neededFromPhase: 7 };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "node" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  if (latest && Date.now() - latest.lastSeenAt.getTime() < WORKER_OFFLINE_AFTER_MS) {
    return { ...base, status: "ok", summary: "Running." };
  }
  return {
    ...base,
    status: youtubeConfig().ok ? "warning" : "info",
    summary: latest ? "Not running." : "Hasn't run yet.",
    hint: "Start the app with `npm run dev:all` (or run `npm run worker:yt`). Uploads wait until it runs.",
  };
}

function optionalKey(
  id: string,
  label: string,
  value: string | undefined,
  phase: number,
  missingHint = `Used from Phase ${phase}. Add the key to .env when you get there.`,
): StatusCheck {
  return {
    id,
    label,
    status: value ? "ok" : "info",
    summary: value ? "Configured." : "Not configured.",
    hint: value ? undefined : missingHint,
    neededFromPhase: phase,
  };
}

/** Narration voices for the video generator, as reported by the media worker (Phase 9). */
async function checkNarration(env: ServerEnv): Promise<StatusCheck> {
  const base = { id: "narration", label: "Narration voices (video generator)", neededFromPhase: 9 };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  if (!latest || Date.now() - latest.lastSeenAt.getTime() >= WORKER_OFFLINE_AFTER_MS) {
    return { ...base, status: "info", summary: "Unknown until the media worker runs." };
  }
  const caps = JSON.parse(latest.capabilitiesJson) as { tts?: string | null };
  if (caps.tts) {
    const [engine, voices] = [caps.tts.slice(0, caps.tts.indexOf(":")), caps.tts.slice(caps.tts.indexOf(":") + 1)];
    const name = engine === "sapi" ? "Windows voices" : engine;
    return { ...base, status: "ok", summary: `${name}: ${voices.split("|").join(", ") || "default voice"}.` };
  }
  return {
    ...base,
    status: "warning",
    summary: `The ${env.TTS_PROVIDER === "sapi" ? "Windows voices" : env.TTS_PROVIDER} engine isn't available.`,
    hint:
      env.TTS_PROVIDER === "kokoro"
        ? "Install Kokoro: `uv pip install --python media-worker/.venv kokoro soundfile`, or set `TTS_PROVIDER=sapi`. Restart `npm run dev:all`."
        : "Windows voices need Windows PowerShell. Check the media worker log, then restart `npm run dev:all`.",
  };
}

function checkWorkerSecret(): StatusCheck {
  const problem = getWorkerSecretProblem();
  return problem
    ? { id: "worker-secret", label: "Worker connection secret", status: "error", summary: problem, neededFromPhase: 3 }
    : {
        id: "worker-secret",
        label: "Worker connection secret",
        status: "ok",
        summary: "Configured.",
        neededFromPhase: 3,
      };
}

/** The Python media worker checks in every 15 s (media-worker/src/media_worker/runner.py). */
async function checkMediaWorker(): Promise<StatusCheck> {
  const base = { id: "media-worker", label: "Media worker (Python)", neededFromPhase: 3 };
  const latest = await db.workerHeartbeat
    .findFirst({ where: { kind: "python" }, orderBy: { lastSeenAt: "desc" } })
    .catch(() => null);
  if (latest && Date.now() - latest.lastSeenAt.getTime() < WORKER_OFFLINE_AFTER_MS) {
    const caps = JSON.parse(latest.capabilitiesJson) as { ffmpeg?: string | null };
    const ffmpegNote = caps.ffmpeg ? `, FFmpeg ${caps.ffmpeg}` : ", but it can't find FFmpeg";
    return {
      ...base,
      status: caps.ffmpeg ? "ok" : "warning",
      summary: `Running (version ${latest.version}${ffmpegNote}).`,
    };
  }
  return {
    ...base,
    // Not an error: uploads still work and wait until the worker starts.
    status: "warning",
    summary: latest ? "Not running (last seen earlier)." : "Not started yet.",
    hint: "Videos wait in “Processing” until it runs. Start the app with `npm run dev:all` (first time: `uv sync --directory media-worker`).",
  };
}
