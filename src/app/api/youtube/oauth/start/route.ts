import { connection } from "next/server";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import { beginAuthorization, OAUTH_COOKIE, OAUTH_FLOW_MS } from "@/server/youtube/oauth";

/**
 * GET /api/youtube/oauth/start — sends the signed-in owner to Google's consent screen (YT-01,
 * SECURITY.md §3.2). The PKCE verifier and `state` go into a sealed, httpOnly, 10-minute cookie.
 */
export async function GET(request: Request) {
  await connection();
  const session = await getCurrentSession();
  const back = new URL("/settings/channels", request.url);
  if (!session) return Response.redirect(new URL("/login?next=%2Fsettings%2Fchannels", request.url), 303);
  try {
    const { url, cookie } = beginAuthorization(session.user.id);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return new Response(null, {
      status: 303,
      headers: {
        Location: url,
        "Set-Cookie": `${OAUTH_COOKIE}=${cookie}; Path=/api/youtube/oauth; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_FLOW_MS / 1000}${secure}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.cause !== undefined)
      logger.error("Couldn't start YouTube sign-in", { error });
    back.searchParams.set("error", error instanceof AppError ? error.message : "Couldn't start the Google sign-in.");
    return Response.redirect(back, 303);
  }
}
