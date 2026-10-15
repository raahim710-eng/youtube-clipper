import { z } from "zod";
import { assertSameOrigin, handleRoute, readJson } from "@/server/http";
import { AppError } from "@/server/errors";
import { requireApiSession } from "@/server/session";
import { createUpload } from "@/server/services/uploads";

const createSchema = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
});

/** POST /api/uploads — start a chunked upload (LIB-01). */
export function POST(request: Request) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError("VALIDATION", "Send the file name and size.");
    const upload = await createUpload(session.user.id, parsed.data);
    return Response.json(upload, { status: 201 });
  });
}
