import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getEnv, getWorkerSecretProblem } from "./env";
import { AppError } from "./errors";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Authenticates calls to /api/internal/* from our own workers (SECURITY.md §5): a shared secret in
 * `Authorization: Bearer …`, compared in constant time. The real "this computer only" control is that the
 * app binds to localhost; the `X-Forwarded-For` check below only catches requests relayed by a proxy
 * (route handlers can't see the socket address, and a client can set that header itself).
 */
export function requireWorker(request: Request): void {
  const problem = getWorkerSecretProblem();
  if (problem) throw new AppError("CONFIGURATION", problem);

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const client = forwardedFor.split(",")[0]?.trim() ?? "";
    if (!LOOPBACK.has(client)) throw new AppError("FORBIDDEN", "Workers must run on this computer.");
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const secret = getEnv().WORKER_SHARED_SECRET ?? "";
  if (!token || !safeEqual(token, secret)) {
    throw new AppError("UNAUTHENTICATED", "Invalid worker credentials.");
  }
}
