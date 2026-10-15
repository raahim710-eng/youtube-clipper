import { AppError } from "@/server/errors";
import { assertSameOrigin, handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import {
  CLIP_EXTENSIONS,
  CLIP_UPLOAD_MAX_BYTES,
  getSceneFootageFile,
  uploadSceneClip,
} from "@/server/services/generator";

/** GET /api/generator/scenes/{id}/footage — the scene's chosen stock or uploaded clip, for previewing (GEN-04). */
export function GET(request: Request, context: RouteContext<"/api/generator/scenes/[id]/footage">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return fileResponse(request, await getSceneFootageFile(session.user.id, id));
  });
}

/**
 * POST /api/generator/scenes/{id}/footage?ext=mp4 — the creator's own clip as the raw request body.
 * Streamed to disk with a 500 MB cap and checked by its first bytes; rendering checks it really moves.
 */
export function POST(request: Request, context: RouteContext<"/api/generator/scenes/[id]/footage">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { id } = await context.params;
    const extension = new URL(request.url).searchParams.get("ext")?.toLowerCase() ?? "";
    const allowed = CLIP_EXTENSIONS.find((item) => item === extension);
    if (!allowed) throw new AppError("VALIDATION", `Use a video file: ${CLIP_EXTENSIONS.join(", ")}.`);
    if (Number(request.headers.get("content-length") ?? "0") > CLIP_UPLOAD_MAX_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Clips can be up to 500 MB.");
    }
    await uploadSceneClip(session.user.id, id, allowed, request.body);
    return Response.json({ ok: true }, { status: 201 });
  });
}
