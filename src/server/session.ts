import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getAuth } from "./auth";
import { getAuthConfigProblems } from "./env";
import { AppError } from "./errors";

/**
 * Data Access Layer for the signed-in user (SECURITY.md §2).
 * Every page, server action and route handler must call one of these —
 * the proxy redirect is only a convenience, not the security boundary.
 */

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
};

export type CurrentSession = {
  sessionId: string;
  user: CurrentUser;
};

/** Reads the session from the request cookies. Returns null when signed out or misconfigured. */
export const getCurrentSession = cache(async (): Promise<CurrentSession | null> => {
  // Read the request first so this never gets evaluated (and baked in) at build time.
  const requestHeaders = await headers();
  if (getAuthConfigProblems().length > 0) return null;
  const result = await getAuth().api.getSession({ headers: requestHeaders });
  if (!result) return null;
  return {
    sessionId: result.session.id,
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
  };
});

/** For pages and server actions: redirects to /login when there is no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session.user;
}

/** For route handlers: throws an UNAUTHENTICATED AppError (mapped to HTTP 401). */
export async function requireApiSession(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) throw new AppError("UNAUTHENTICATED", "Please sign in.");
  return session;
}
