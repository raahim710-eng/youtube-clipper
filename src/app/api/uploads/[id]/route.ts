import { assertSameOrigin, handleRoute } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { cancelUpload, getUploadStatus } from "@/server/services/uploads";

/** GET /api/uploads/{id} — which chunks have arrived (used to resume). */
export function GET(_request: Request, context: RouteContext<"/api/uploads/[id]">) {
  return handleRoute(async () => {
    const session = await requireApiSession();
    const { id } = await context.params;
    return Response.json(await getUploadStatus(session.user.id, id), { headers: { "Cache-Control": "no-store" } });
  });
}

/** DELETE /api/uploads/{id} — abandon an upload and delete its partial data. */
export function DELETE(request: Request, context: RouteContext<"/api/uploads/[id]">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { id } = await context.params;
    await cancelUpload(session.user.id, id);
    return new Response(null, { status: 204 });
  });
}
