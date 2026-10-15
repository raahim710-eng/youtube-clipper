import { AppError } from "@/server/errors";
import { assertSameOrigin, handleRoute } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { writeChunk } from "@/server/services/uploads";

/** PUT /api/uploads/{id}/chunks/{index} — raw bytes of one chunk (streamed to disk, never buffered whole). */
export function PUT(request: Request, context: RouteContext<"/api/uploads/[id]/chunks/[index]">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { id, index } = await context.params;
    if (!/^\d{1,6}$/.test(index)) throw new AppError("VALIDATION", "Invalid chunk number.");
    const result = await writeChunk(session.user.id, id, Number(index), request.body);
    return Response.json(result);
  });
}
