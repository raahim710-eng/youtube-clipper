import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileResponse } from "@/server/media/stream";

function tempFile(bytes: number) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stream-")), "data.bin");
  const data = Buffer.alloc(bytes, 7);
  for (let i = 0; i < bytes; i += 1) data[i] = i % 251;
  fs.writeFileSync(file, data);
  return { file, data };
}

describe("file responses", () => {
  it.each([10, 70_000, 1_000_000])("streams all %i bytes", async (size) => {
    const { file, data } = tempFile(size);
    const response = fileResponse(new Request("http://x/a"), {
      absolutePath: file,
      size,
      contentType: "application/octet-stream",
      downloadName: "a.bin",
    });
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(data)).toBe(true);
  });

  it("serves a byte range and survives the reader cancelling", async () => {
    const { file, data } = tempFile(500_000);
    const ranged = fileResponse(new Request("http://x/a", { headers: { range: "bytes=100-199" } }), {
      absolutePath: file,
      size: data.length,
      contentType: "application/octet-stream",
      downloadName: "a.bin",
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);

    const cancelled = fileResponse(new Request("http://x/a"), {
      absolutePath: file,
      size: data.length,
      contentType: "application/octet-stream",
      downloadName: "a.bin",
    });
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 50)); // no uncaught "Controller is already closed"
  });
});
