import { assertSameOrigin, handleRoute } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { completeUpload } from "@/server/services/uploads";

/** POST /api/uploads/{id}/complete — verify, add to the library and queue processing. */
export function POST(request: Request, context: RouteContext<"/api/uploads/[id]/complete">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { id } = await context.params;
    return Response.json(await completeUpload(session.user.id, id), { status: 201 });
  });
}
