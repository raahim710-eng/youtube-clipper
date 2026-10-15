import fs from "node:fs/promises";

/**
 * Quick content check of an uploaded file's first bytes ("magic bytes") before it is
 * accepted. It catches renamed non-video files early; the media worker's ffprobe
 * check is the authoritative validation.
 */

export type ContainerFamily = "isobmff" | "matroska" | "avi";

/** Which container family each allowed extension must contain. */
export const EXTENSION_FAMILY: Record<string, ContainerFamily> = {
  mp4: "isobmff",
  m4v: "isobmff",
  mov: "isobmff",
  mkv: "matroska",
  webm: "matroska",
  avi: "avi",
};

// Top-level box types that can start an MP4/MOV file (older QuickTime files may not start with ftyp).
const ISO_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);

export function detectContainer(header: Uint8Array): ContainerFamily | null {
  if (header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) {
    return "matroska";
  }
  const ascii = (start: number, end: number) => String.fromCharCode(...header.slice(start, end));
  if (header.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return "avi";
  if (header.length >= 8 && ISO_BOXES.has(ascii(4, 8))) return "isobmff";
  return null;
}

export async function readHeader(absolutePath: string, length = 16): Promise<Uint8Array> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** True when the file's content matches the format its extension claims. */
export function contentMatchesExtension(header: Uint8Array, extension: string): boolean {
  const expected = EXTENSION_FAMILY[extension];
  return expected !== undefined && detectContainer(header) === expected;
}
