import "server-only";
import { createReadStream, type ReadStream } from "node:fs";
import { parseRange } from "./range";

export type StreamableFile = { absolutePath: string; size: number; contentType: string; downloadName: string };

/**
 * Streams a file the caller has already authorised, with HTTP Range support so players can seek.
 * `?download=1` asks the browser to save it instead of showing it.
 */
export function fileResponse(request: Request, file: StreamableFile): Response {
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers = new Headers({
    "Content-Type": file.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${file.downloadName}"`,
  });

  if (file.size === 0) {
    // createReadStream can't express an empty range; an empty file is simply an empty body.
    headers.set("Content-Length", "0");
    return new Response(null, { status: request.headers.get("range") ? 416 : 200, headers });
  }
  const range = parseRange(request.headers.get("range"), file.size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }

  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);

  return new Response(webStream(createReadStream(file.absolutePath, { start, end })), {
    status: range ? 206 : 200,
    headers,
  });
}

/**
 * Wraps a file stream for a Response. Players cancel range requests all the time (seeking);
 * `Readable.toWeb` can then throw "Controller is already closed" as an uncaught exception,
 * so cancellation and back-pressure are handled explicitly here.
 */
function webStream(file: ReadStream): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      file.on("data", (chunk) => {
        if (done) return;
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) file.pause();
      });
      file.on("end", () => {
        if (done) return;
        done = true;
        controller.close();
      });
      file.on("error", (error) => {
        if (done) return;
        done = true;
        controller.error(error);
      });
    },
    pull() {
      file.resume();
    },
    cancel() {
      done = true;
      file.destroy();
    },
  });
}
