import { readEncryptionKey } from "../crypto";
import { getEnv } from "../env";

/**
 * Google OAuth + YouTube Data API settings (TECHNICAL_SPEC.md §7.5). Official endpoints only; in tests,
 * GOOGLE_API_TEST_BASE_URL (localhost only) points them at a local stand-in.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

/** Least privilege (SECURITY.md §3.1): find the channel, and upload videos/thumbnails. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
] as const;

export type GoogleEndpoints = { auth: string; token: string; revoke: string; api: string; upload: string };

/**
 * The local Google stand-in for automated tests. Never honoured in a production run, so a forgotten
 * line in .env can't send the client secret or tokens to another program on this computer.
 */
function testBaseUrl(): string | undefined {
  const env = getEnv();
  return env.NODE_ENV === "production" ? undefined : env.GOOGLE_API_TEST_BASE_URL;
}

export function googleEndpoints(): GoogleEndpoints {
  const test = testBaseUrl();
  if (test) {
    return {
      auth: `${test}/o/oauth2/v2/auth`,
      token: `${test}/token`,
      revoke: `${test}/revoke`,
      api: `${test}/youtube/v3`,
      upload: `${test}/upload/youtube/v3`,
    };
  }
  return {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    api: "https://www.googleapis.com/youtube/v3",
    upload: "https://www.googleapis.com/upload/youtube/v3",
  };
}

export type YouTubeConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  audited: boolean;
  usingTestServer: boolean;
};

/** Everything needed to connect channels, or the list of what's missing (never the values). */
export function youtubeConfig(): { ok: true; config: YouTubeConfig } | { ok: false; problems: string[] } {
  const env = getEnv();
  const problems: string[] = [];
  if (!env.GOOGLE_CLIENT_ID) problems.push("GOOGLE_CLIENT_ID is not set.");
  if (!env.GOOGLE_CLIENT_SECRET) problems.push("GOOGLE_CLIENT_SECRET is not set.");
  if (!env.GOOGLE_REDIRECT_URI) problems.push("GOOGLE_REDIRECT_URI is not set.");
  else if (!env.GOOGLE_REDIRECT_URI.endsWith("/api/youtube/oauth/callback")) {
    problems.push("GOOGLE_REDIRECT_URI must end with /api/youtube/oauth/callback.");
  }
  if (env.NODE_ENV === "production" && env.GOOGLE_API_TEST_BASE_URL) {
    problems.push("GOOGLE_API_TEST_BASE_URL is only for automated tests — remove it from .env.");
  }
  const key = readEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  if ("problem" in key) problems.push(key.problem);
  if (problems.length > 0 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: env.GOOGLE_REDIRECT_URI,
      audited: env.YOUTUBE_API_AUDITED,
      usingTestServer: Boolean(testBaseUrl()),
    },
  };
}
