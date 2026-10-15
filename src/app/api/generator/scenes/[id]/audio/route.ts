import { handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import { getSceneAudioFile } from "@/server/services/generator";

/** GET /api/generator/scenes/{id}/audio — a scene's narration WAV (GEN-03). Another user's scene gives 404. */
export function GET(request: Request, context: RouteContext<"/api/generator/scenes/[id]/audio">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return fileResponse(request, await getSceneAudioFile(session.user.id, id));
  });
}
