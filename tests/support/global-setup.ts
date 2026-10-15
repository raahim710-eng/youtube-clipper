import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Creates a fresh, migrated SQLite database and test-only settings for the test run.
 * Real `.env` values are never used by tests.
 */
export default function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-yt-employee-test-"));
  const databaseFile = path.join(dir, "test.db");

  process.env.DATABASE_URL = `file:${databaseFile}`;
  process.env.BETTER_AUTH_SECRET = "test-secret-".padEnd(48, "x");
  process.env.BETTER_AUTH_URL = "http://localhost:3999";
  process.env.WORKER_SHARED_SECRET = "test-worker-secret-".padEnd(48, "w");
  process.env.STORAGE_DIR = path.join(dir, "storage");
  process.env.FFMPEG_PATH = path.join(dir, "missing-ffmpeg.exe");
  process.env.FFPROBE_PATH = path.join(dir, "missing-ffprobe.exe");
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
  // A configured (but never contacted) OpenAI-compatible server, so "AI is ready" paths can be tested.
  process.env.OPENAI_COMPAT_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.OPENAI_COMPAT_MODEL = "test-model";
  // YouTube (Phase 7): a test-only Google stand-in replaces fetch in the YouTube tests; nothing leaves the machine.
  process.env.GOOGLE_CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3999/api/youtube/oauth/callback";
  process.env.GOOGLE_API_TEST_BASE_URL = "http://127.0.0.1:3296";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.YOUTUBE_UPLOAD_CHUNK_KB = "256";
  process.env.LOG_LEVEL = "error";

  execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
