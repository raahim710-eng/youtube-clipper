import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client. Sign-in, sign-up and password changes go through
 * the HTTP endpoints so Better Auth's rate limiting applies (SECURITY.md §2).
 */
export const authClient = createAuthClient();

/** Turns a Better Auth client error into a friendly sentence. */
export function authErrorMessage(
  error: { status?: number; message?: string } | null | undefined,
  fallback: string,
): string {
  if (!error) return fallback;
  if (error.status === 429) return "Too many attempts. Wait a minute, then try again.";
  if (error.status === 503) return "Login isn't configured yet. Check Settings › System status or your .env file.";
  return error.message || fallback;
}
