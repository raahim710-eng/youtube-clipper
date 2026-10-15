import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";
import { AppError } from "@/server/errors";

/**
 * Better Auth endpoints (/api/auth/*). The instance is created on first request so
 * a missing BETTER_AUTH_SECRET produces a clear 503 instead of a crash.
 */

/**
 * Rate limits are kept per client IP, which Better Auth reads from `X-Forwarded-For`. That header comes
 * from the client (Next.js only fills it in when missing), so a script could send a new fake IP with
 * every password guess. The app only serves this computer, so every request counts as one client.
 * (A fresh Request is built from its parts: Next.js's own request class can't be copied with
 * `new Request(request, init)`. Auth bodies are small JSON, so reading them here is fine.)
 */
async function withFixedClientIp(request: Request): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", "127.0.0.1");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    signal: request.signal,
  });
}

async function handle(request: Request, method: "GET" | "POST"): Promise<Response> {
  try {
    const handlers = toNextJsHandler(getAuth());
    return await handlers[method](await withFixedClientIp(request));
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFIGURATION") {
      return Response.json({ message: error.message }, { status: 503 });
    }
    throw error;
  }
}

export function GET(request: Request) {
  return handle(request, "GET");
}

export function POST(request: Request) {
  return handle(request, "POST");
}
