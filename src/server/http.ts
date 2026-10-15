import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { getEnv } from "./env";
import { AppError } from "./errors";
import { logger } from "./logger";

/** Helpers for route handlers (src/app/api/**). */

export function jsonError(error: unknown): Response {
  if (error instanceof AppError) {
    // Expected failures show their safe message; a technical cause, if any, goes to the log only.
    if (error.cause !== undefined) logger.warn("Request failed", { code: error.code, error });
    return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  logger.error("Unhandled error in route handler", { error });
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

/**
 * Wraps a handler so thrown AppErrors become JSON responses with the right status.
 * API routes always run per request (never prerendered at build time), and Next.js's
 * own control-flow errors are re-thrown instead of being turned into a 500.
 */
export async function handleRoute(run: () => Promise<Response>): Promise<Response> {
  await connection();
  try {
    return await run();
  } catch (error) {
    unstable_rethrow(error);
    return jsonError(error);
  }
}

/**
 * CSRF protection for custom state-changing route handlers (SECURITY.md §5):
 * the browser's Origin header must match this app's URL.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(getEnv().BETTER_AUTH_URL).origin;
  if (!origin || origin !== expected) {
    throw new AppError("FORBIDDEN", "This request didn't come from the app.");
  }
}

/** Parses a JSON body, turning malformed input into a 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("VALIDATION", "The request body must be valid JSON.");
  }
}
