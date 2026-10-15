import { AppError } from "@/server/errors";
import { handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import { getVideoMediaFile, MEDIA_VARIANTS, type MediaVariant } from "@/server/services/videos";

/**
 * GET /api/media/videos/{id}/{source|preview|poster|playback}[?download=1]
 * Streams a video file the signed-in user owns, with HTTP Range support so the
 * player can seek (SECURITY.md §4). Another user's ID gives 404, never the file.
 */
export function GET(request: Request, context: RouteContext<"/api/media/videos/[id]/[variant]">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id, variant } = await context.params;
    if (!MEDIA_VARIANTS.includes(variant as MediaVariant)) throw new AppError("NOT_FOUND", "Unknown file.");
    return fileResponse(request, await getVideoMediaFile(session.user.id, id, variant as MediaVariant));
  });
}
