import { handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import { getThumbnailFile } from "@/server/services/packaging";

/** GET /api/media/thumbnails/{id}[?download=1] — a thumbnail image the signed-in user owns. */
export function GET(request: Request, context: RouteContext<"/api/media/thumbnails/[id]">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return fileResponse(request, await getThumbnailFile(session.user.id, id));
  });
}
