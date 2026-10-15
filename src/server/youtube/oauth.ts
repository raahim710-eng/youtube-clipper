import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { decryptSecret, encryptSecret, KEY_VERSION } from "../crypto";
import { db } from "../db";
import { AppError } from "../errors";
import { logger } from "../logger";
import { googleEndpoints, YOUTUBE_SCOPES, youtubeConfig } from "./config";

/**
 * Google OAuth for YouTube channels (SECURITY.md §3). Authorization code flow with PKCE and `state`;
 * tokens are encrypted before storage. This is the ONLY module that reads `OAuthCredential` or sees
 * decrypted tokens. Tokens never go to the browser, into job payloads or into logs.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

export class ReauthRequiredError extends Error {
  constructor(message = "Google no longer accepts this channel's sign-in. Reconnect the channel.") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function requireConfig() {
  const result = youtubeConfig();
  if (!result.ok) {
    throw new AppError(
      "CONFIGURATION",
      `YouTube isn't set up yet: ${result.problems.join(" ")} See README › Google Cloud setup.`,
    );
  }
  return result.config;
}

// ---------------------------------------------------------------------------
// The sign-in flow
// ---------------------------------------------------------------------------

export const OAUTH_COOKIE = "yt_oauth";
export const OAUTH_FLOW_MS = 10 * 60 * 1000;

const flowSchema = z.object({ state: z.string(), verifier: z.string(), userId: z.string(), expiresAt: z.number() });
type Flow = z.infer<typeof flowSchema>;

/** Starts a flow: the Google URL to send the browser to, and the sealed cookie that remembers it. */
export function beginAuthorization(userId: string, now = Date.now()): { url: string; cookie: string } {
  const config = requireConfig();
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const flow: Flow = { state, verifier, userId, expiresAt: now + OAUTH_FLOW_MS };
  return { url: `${googleEndpoints().auth}?${params}`, cookie: encryptSecret(JSON.stringify(flow)) };
}

/** Checks the callback against the sealed cookie: same signed-in user, same `state`, not expired. */
export function verifyAuthorization(
  cookie: string | undefined,
  userId: string,
  state: string | null,
  now = Date.now(),
): { verifier: string } {
  const invalid = new AppError(
    "FORBIDDEN",
    "This sign-in link isn't valid any more. Start connecting the channel again.",
  );
  if (!cookie || !state) throw invalid;
  let flow: Flow;
  try {
    flow = flowSchema.parse(JSON.parse(decryptSecret(cookie)));
  } catch {
    throw invalid;
  }
  const expected = Buffer.from(flow.state);
  const actual = Buffer.from(state);
  if (
    flow.userId !== userId ||
    flow.expiresAt < now ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw invalid;
  }
  return { verifier: flow.verifier };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
  token_type: z.string().optional(),
});
export type TokenSet = { accessToken: string; refreshToken?: string; expiresAt: Date; scopes: string[] };

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(googleEndpoints().token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  } catch (error) {
    throw new AppError("INTERNAL", "Google couldn't be reached. Check the internet connection and try again.", {
      cause: error,
    });
  }
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = z.object({ error: z.string() }).safeParse(json);
    if (code.success && code.data.error === "invalid_grant") throw new ReauthRequiredError();
    logger.warn("Google token request failed", {
      status: response.status,
      error: code.success ? code.data.error : null,
    });
    throw new AppError(
      "INTERNAL",
      `Google refused the request (${code.success ? code.data.error : `HTTP ${response.status}`}).`,
    );
  }
  const parsed = tokenResponseSchema.parse(json);
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    scopes: parsed.scope.split(" ").filter(Boolean),
  };
}

export async function exchangeCode(code: string, verifier: string): Promise<TokenSet> {
  const config = requireConfig();
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
}

export function missingScopes(granted: string[]): string[] {
  return YOUTUBE_SCOPES.filter((scope) => !granted.includes(scope));
}

// ---------------------------------------------------------------------------
// Stored credentials
// ---------------------------------------------------------------------------

export async function storeCredential(
  tx: Prisma.TransactionClient,
  channelId: string,
  tokens: TokenSet,
): Promise<void> {
  const existing = await tx.oAuthCredential.findUnique({ where: { channelId }, select: { refreshTokenEnc: true } });
  // Google only returns a refresh token on consent; keep the stored one otherwise.
  const refreshTokenEnc = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : existing?.refreshTokenEnc;
  if (!refreshTokenEnc) {
    throw new AppError(
      "VALIDATION",
      "Google didn't grant offline access. Remove the app at myaccount.google.com/permissions and connect again.",
    );
  }
  const data = {
    accessTokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc,
    accessTokenExpiresAt: tokens.expiresAt,
    keyVersion: KEY_VERSION,
  };
  await tx.oAuthCredential.upsert({ where: { channelId }, create: { channelId, ...data }, update: data });
}

/** A valid access token for the channel, refreshed when it is about to expire (YT-03). */
export async function getAccessToken(channelId: string, now = Date.now()): Promise<string> {
  const credential = await db.oAuthCredential.findUnique({ where: { channelId } });
  if (!credential)
    throw new ReauthRequiredError("This channel isn't connected. Connect it again in Settings › Channels.");
  if (credential.accessTokenExpiresAt.getTime() - 60_000 > now) return decryptSecret(credential.accessTokenEnc);

  const config = requireConfig();
  try {
    const tokens = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: decryptSecret(credential.refreshTokenEnc),
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    await db.$transaction((tx) => storeCredential(tx, channelId, tokens));
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof ReauthRequiredError) {
      await db.youTubeChannel.update({ where: { id: channelId }, data: { status: "reauth_required" } });
    }
    throw error;
  }
}

/** YT-02: revokes the grant at Google (best effort — the owner may already have removed it) and deletes the tokens. */
export async function revokeAndDeleteCredential(channelId: string): Promise<{ revoked: boolean }> {
  const credential = await db.oAuthCredential.findUnique({ where: { channelId } });
  let revoked = false;
  if (credential) {
    try {
      const response = await fetch(googleEndpoints().revoke, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decryptSecret(credential.refreshTokenEnc) }),
      });
      // 400 invalid_token means it was already revoked or expired: nothing left to revoke.
      revoked = response.ok || response.status === 400;
    } catch (error) {
      logger.warn("Couldn't reach Google to revoke a channel's access", { channelId, error });
    }
    await db.oAuthCredential.delete({ where: { channelId } });
  }
  return { revoked };
}
