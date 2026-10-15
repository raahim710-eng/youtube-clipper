import { handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import { getShortMediaFile } from "@/server/services/shorts";

/**
 * GET /api/media/shorts/{id}[?download=1] — the exported MP4 of a Short the signed-in user owns
 * (SHORT-05). Range requests are supported for playback; another user's ID gives 404.
 */
export function GET(request: Request, context: RouteContext<"/api/media/shorts/[id]">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return fileResponse(request, await getShortMediaFile(session.user.id, id));
  });
}
