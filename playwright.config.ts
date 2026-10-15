import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run the real app (port 3200) and the real Python media worker against
 * a throwaway database and storage folder, so they never touch your `data/app.db`.
 * Requirements: FFmpeg on PATH and `npm run worker:setup` done once. Stop `npm run dev` first.
 */
const PORT = 3200;
const BASE_URL = `http://localhost:${PORT}`;
const DATA = path.join(__dirname, "data");
const E2E_DB = path.join(DATA, "e2e.db");
const E2E_STORAGE = path.join(DATA, "e2e-storage");
export const E2E_MEDIA = path.join(DATA, "e2e-media");
const FAKE_LLM_PORT = 3299;
export const FAKE_GOOGLE_PORT = 3297;

const shared = {
  STORAGE_DIR: E2E_STORAGE,
  WORKER_SHARED_SECRET: "e2e-only-worker-secret-".padEnd(48, "w"),
  LOG_LEVEL: "warn",
  // "tiny" keeps transcription quick in tests (E2E_WHISPER_MODEL overrides it, e.g. for the real-video check).
  // The real-AI test (E2E_REAL_AI=1) uses OLLAMA_MODEL from .env.
  WHISPER_MODEL: process.env.E2E_WHISPER_MODEL ?? "tiny",
  // Phase 6: a test-only fake AI server (tests/e2e/fixtures/fake-llm-server.mjs) behind the OpenAI-compatible
  // provider, so packaging can be tested end to end without a slow or paid model. Tests choose it explicitly.
  OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${FAKE_LLM_PORT}/v1`,
  OPENAI_COMPAT_MODEL: "e2e-fake-model",
  // Phase 7: a test-only Google stand-in (tests/support/fake-google.mjs); test credentials only. Real
  // channels are never contacted by the automated tests.
  GOOGLE_CLIENT_ID: "fake-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake-client-secret",
  GOOGLE_REDIRECT_URI: `${BASE_URL}/api/youtube/oauth/callback`,
  GOOGLE_API_TEST_BASE_URL: `http://127.0.0.1:${FAKE_GOOGLE_PORT}`,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  YOUTUBE_UPLOAD_CHUNK_KB: "256",
  // Phase 9: never call real stock providers from tests, even if .env has keys; narration uses Windows' voices.
  PEXELS_API_KEY: "",
  PIXABAY_API_KEY: "",
  TTS_PROVIDER: "sapi",
  TTS_VOICE: "",
};

/** Real encoded sample videos made with FFmpeg (moving test pattern + tone). */
function makeSamples() {
  fs.mkdirSync(E2E_MEDIA, { recursive: true });
  const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  // ~15 MB constant-bitrate H.264/AAC: two 10 MB chunks, so resuming can be tested.
  const interview =
    "-f lavfi -i testsrc2=size=1920x1080:rate=30:duration=10 -f lavfi -i sine=frequency=440:duration=10";
  const h264 =
    "-c:v libx264 -x264-params nal-hrd=cbr -b:v 12M -minrate 12M -maxrate 12M -bufsize 4M -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart";
  ffmpeg([...`${interview} ${h264}`.split(" "), path.join(E2E_MEDIA, "Interview Sample.mp4")]);
  // HEVC in MOV: browsers can't play it, so the worker must create a preview.
  const phone = "-f lavfi -i testsrc2=size=1280x720:rate=30:duration=4 -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p";
  ffmpeg([...phone.split(" "), path.join(E2E_MEDIA, "Phone Clip.mov")]);
  fs.writeFileSync(path.join(E2E_MEDIA, "Not A Video.mp4"), "These are notes saved with the wrong extension.");
  fs.writeFileSync(path.join(E2E_MEDIA, "notes.txt"), "plain text");

  // Phase 4: a ~100 s talk with real speech (Windows' built-in speech engine) over a test pattern.
  if (process.platform === "win32") {
    const wav = path.join(E2E_MEDIA, "talk.wav");
    execFileSync("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "tests", "e2e", "fixtures", "make-speech.ps1"),
      "-OutWav",
      wav,
      "-TextFile",
      path.join(__dirname, "tests", "e2e", "fixtures", "talk.txt"),
    ]);
    const picture = "-f lavfi -i testsrc2=size=640x360:rate=25".split(" ");
    const encode = "-shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -movflags +faststart".split(" ");
    ffmpeg([...picture, "-i", wav, ...encode, path.join(E2E_MEDIA, "Editing Talk.mp4")]);
  }
}

// Playwright also loads this file inside test workers (TEST_WORKER_INDEX is set there) —
// by then the servers have the database open, so only reset in the main process.
if (process.env.TEST_WORKER_INDEX === undefined) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${E2E_DB}${suffix}`, { force: true });
  fs.rmSync(E2E_STORAGE, { recursive: true, force: true });
  makeSamples();
}

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node tests/e2e/fixtures/fake-llm-server.mjs",
      url: `http://127.0.0.1:${FAKE_LLM_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_LLM_PORT: String(FAKE_LLM_PORT) },
    },
    {
      command: "node tests/support/run-fake-google.mjs",
      url: `http://127.0.0.1:${FAKE_GOOGLE_PORT}/`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_GOOGLE_PORT: String(FAKE_GOOGLE_PORT) },
    },
    {
      command: `npm run db:deploy && npx next dev --hostname localhost --port ${PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        ...shared,
        DATABASE_URL: `file:${E2E_DB}`,
        BETTER_AUTH_URL: BASE_URL,
        BETTER_AUTH_SECRET: "e2e-only-secret-".padEnd(48, "x"),
      },
    },
    {
      command: "uv run --directory media-worker python -m media_worker",
      wait: { stderr: /Worker .* ready/ },
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...shared, APP_INTERNAL_URL: BASE_URL, WORKER_POLL_INTERVAL_MS: "500", LOG_LEVEL: "info" },
    },
    {
      // Phase 7: the Node integration worker (YouTube uploads), on the same throwaway database.
      command: "npx tsx --conditions=react-server src/worker/index.ts",
      wait: { stdout: /Node integration worker ready/ },
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...shared, DATABASE_URL: `file:${E2E_DB}`, WORKER_POLL_INTERVAL_MS: "500", LOG_LEVEL: "info" },
    },
  ],
});
