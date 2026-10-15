import { AppError } from "@/server/errors";
import { assertSameOrigin, handleRoute } from "@/server/http";
import { fileResponse } from "@/server/media/stream";
import { requireApiSession } from "@/server/session";
import { getMusicFile, MUSIC_EXTENSIONS, MUSIC_UPLOAD_MAX_BYTES, uploadMusic } from "@/server/services/generator";

/** GET /api/generator/projects/{id}/music — the project's background music (GEN-05). */
export function GET(request: Request, context: RouteContext<"/api/generator/projects/[id]/music">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return fileResponse(request, await getMusicFile(session.user.id, id));
  });
}

/**
 * POST /api/generator/projects/{id}/music?ext=mp3 — music the creator has the rights to, as the raw body
 * (50 MB cap, checked by its first bytes). It is mixed under the narration and ducked while the voice speaks.
 */
export function POST(request: Request, context: RouteContext<"/api/generator/projects/[id]/music">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { id } = await context.params;
    const extension = new URL(request.url).searchParams.get("ext")?.toLowerCase() ?? "";
    const allowed = MUSIC_EXTENSIONS.find((item) => item === extension);
    if (!allowed) throw new AppError("VALIDATION", `Use an audio file: ${MUSIC_EXTENSIONS.join(", ")}.`);
    if (Number(request.headers.get("content-length") ?? "0") > MUSIC_UPLOAD_MAX_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE", "Music files can be up to 50 MB.");
    }
    await uploadMusic(session.user.id, id, allowed, request.body);
    return Response.json({ ok: true }, { status: 201 });
  });
}
