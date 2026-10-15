import { describe, expect, it } from "vitest";
import { detectContainer, contentMatchesExtension } from "@/server/media/sniff";
import { parseRange } from "@/server/media/range";
import {
  countChunks,
  expectedChunkLength,
  formatBytes,
  formatDuration,
  titleFromFilename,
  UPLOAD_CHUNK_SIZE,
  validateUploadFile,
} from "@/lib/uploads";

const limits = { maxUploadBytes: 100 * 1024 * 1024 };

describe("validateUploadFile (LIB-02, client and server)", () => {
  it.each(["clip.mp4", "CLIP.MOV", "a.mkv", "a.webm", "a.avi", "a.m4v", "my.holiday.video.mp4"])(
    "accepts %s",
    (name) => {
      expect(validateUploadFile({ name, size: 1000 }, limits)).toBeNull();
    },
  );

  it.each(["notes.txt", "image.png", "archive.zip", "noextension", "video.mp4.exe", "audio.mp3"])(
    "rejects %s",
    (name) => {
      expect(validateUploadFile({ name, size: 1000 }, limits)).toMatch(/isn't a supported video format/);
    },
  );

  it("rejects empty and oversized files with the limit in the message", () => {
    expect(validateUploadFile({ name: "a.mp4", size: 0 }, limits)).toMatch(/empty/);
    expect(validateUploadFile({ name: "a.mp4", size: limits.maxUploadBytes + 1 }, limits)).toMatch(/limit is 100 MB/);
    expect(validateUploadFile({ name: "a.mp4", size: limits.maxUploadBytes }, limits)).toBeNull();
  });

  it("rejects missing or very long names", () => {
    expect(validateUploadFile({ name: "", size: 10 }, limits)).not.toBeNull();
    expect(validateUploadFile({ name: `${"a".repeat(260)}.mp4`, size: 10 }, limits)).not.toBeNull();
  });
});

describe("chunk maths", () => {
  it("splits files into 10 MB chunks with a shorter last chunk", () => {
    const size = UPLOAD_CHUNK_SIZE * 2 + 123;
    expect(countChunks(size)).toBe(3);
    expect(expectedChunkLength(0, size)).toBe(UPLOAD_CHUNK_SIZE);
    expect(expectedChunkLength(2, size)).toBe(123);
    expect(countChunks(UPLOAD_CHUNK_SIZE)).toBe(1);
  });
});

describe("display helpers", () => {
  it("formats sizes and durations", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(4 * 1024 ** 3)).toBe("4.0 GB");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(null)).toBe("–");
  });

  it("derives a title from the file name", () => {
    expect(titleFromFilename("my_great_video.mp4")).toBe("my great video");
    expect(titleFromFilename(".mp4")).toBe("Untitled video");
  });
});

describe("content sniffing (magic bytes)", () => {
  const bytes = (...parts: (string | number[])[]) =>
    Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)));

  it("recognises MP4/MOV, Matroska/WebM and AVI", () => {
    expect(detectContainer(bytes([0, 0, 0, 0x20], "ftypisom"))).toBe("isobmff");
    expect(detectContainer(bytes([0, 0, 0, 8], "wide"))).toBe("isobmff");
    expect(detectContainer(bytes([0x1a, 0x45, 0xdf, 0xa3, 1, 2]))).toBe("matroska");
    expect(detectContainer(bytes("RIFF", [1, 2, 3, 4], "AVI LIST"))).toBe("avi");
  });

  it("rejects text, images and mismatched formats", () => {
    expect(detectContainer(bytes("this is not a video"))).toBeNull();
    expect(detectContainer(bytes([0x89], "PNG", [13, 10, 26, 10]))).toBeNull();
    expect(contentMatchesExtension(bytes([0x1a, 0x45, 0xdf, 0xa3]), "mp4")).toBe(false);
    expect(contentMatchesExtension(bytes([0x1a, 0x45, 0xdf, 0xa3]), "webm")).toBe(true);
  });
});

describe("parseRange (video seeking)", () => {
  it.each([
    [null, null],
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100, end: 999 }],
    ["bytes=-100", { start: 900, end: 999 }],
    ["bytes=500-5000", { start: 500, end: 999 }],
    ["bytes=1000-", "unsatisfiable"],
    ["bytes=50-10", "unsatisfiable"],
    ["bytes=0-1,5-9", null],
    ["items=0-1", null],
  ])("%s", (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });
});
