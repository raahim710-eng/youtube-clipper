import { PACKAGING_TARGET_KINDS, type PackagingTargetKind } from "@/lib/constants";
import { AppError } from "@/server/errors";
import { assertSameOrigin, handleRoute } from "@/server/http";
import { requireApiSession } from "@/server/session";
import { THUMBNAIL_UPLOAD_MAX_BYTES, uploadThumbnail } from "@/server/services/packaging";

/**
 * POST /api/packaging/{video|short}/{id}/thumbnails — the creator's own thumbnail image as the raw request
 * body (PKG-06). Size is capped while reading; the content must be JPEG or PNG; the worker re-encodes it.
 */
export function POST(request: Request, context: RouteContext<"/api/packaging/[kind]/[id]/thumbnails">) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const session = await requireApiSession();
    const { kind, id } = await context.params;
    if (!PACKAGING_TARGET_KINDS.includes(kind as PackagingTargetKind)) throw new AppError("NOT_FOUND", "Not found.");
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > THUMBNAIL_UPLOAD_MAX_BYTES) throw new AppError("PAYLOAD_TOO_LARGE", "Images can be up to 10 MB.");
    const bytes = await readCapped(request, THUMBNAIL_UPLOAD_MAX_BYTES);
    const thumbnail = await uploadThumbnail(session.user.id, kind as PackagingTargetKind, id, bytes);
    return Response.json(thumbnail, { status: 201 });
  });
}

async function readCapped(request: Request, limit: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new AppError("PAYLOAD_TOO_LARGE", "Images can be up to 10 MB.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
