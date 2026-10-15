import { connection } from "next/server";
import { AppError } from "@/server/errors";
import { logger } from "@/server/logger";
import { getCurrentSession } from "@/server/session";
import { connectChannelsFromCode } from "@/server/services/youtube";
import { OAUTH_COOKIE, ReauthRequiredError, verifyAuthorization } from "@/server/youtube/oauth";

/**
 * GET /api/youtube/oauth/callback — Google sends the owner back here (GOOGLE_REDIRECT_URI). The flow
 * cookie must belong to the same signed-in user and match `state`; the code is exchanged server-side
 * with the PKCE verifier. Tokens never reach the browser.
 */
export async function GET(request: Request) {
  await connection();
  const url = new URL(request.url);
  const back = new URL("/settings/channels", request.url);
  const clearCookie = `${OAUTH_COOKIE}=; Path=/api/youtube/oauth; HttpOnly; SameSite=Lax; Max-Age=0`;
  const redirect = (params: Record<string, string>) => {
    for (const [key, value] of Object.entries(params)) back.searchParams.set(key, value);
    return new Response(null, {
      status: 303,
      headers: { Location: back.toString(), "Set-Cookie": clearCookie, "Cache-Control": "no-store" },
    });
  };

  const session = await getCurrentSession();
  if (!session) return redirect({ error: "Your session ended during the Google sign-in. Sign in and connect again." });
  const googleError = url.searchParams.get("error");
  if (googleError) {
    return redirect({
      error:
        googleError === "access_denied"
          ? "You didn't allow access, so no channel was connected."
          : `Google reported: ${googleError.slice(0, 80)}.`,
    });
  }
  const cookie = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${OAUTH_COOKIE}=`))
    ?.slice(OAUTH_COOKIE.length + 1);
  try {
    const { verifier } = verifyAuthorization(cookie, session.user.id, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    if (!code) throw new AppError("VALIDATION", "Google didn't send an authorisation code. Connect again.");
    const channels = await connectChannelsFromCode(session.user.id, code, verifier);
    return redirect({ connected: String(channels.length) });
  } catch (error) {
    if (!(error instanceof AppError) && !(error instanceof ReauthRequiredError)) {
      logger.error("YouTube connection failed", { error });
    }
    return redirect({
      error:
        error instanceof AppError || error instanceof ReauthRequiredError
          ? error.message
          : "Connecting the channel failed. Try again.",
    });
  }
}
