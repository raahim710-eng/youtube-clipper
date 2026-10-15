import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveExistingStoragePath, resolveStoragePath, UnsafePathError } from "@/server/storage";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "storage-outside-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("resolveStoragePath (SECURITY.md §4)", () => {
  it("resolves normal relative paths inside the root", () => {
    expect(resolveStoragePath("videos/abc/source.mp4", root)).toBe(path.join(root, "videos", "abc", "source.mp4"));
  });

  it.each([
    "../secret.txt",
    "videos/../../secret.txt",
    "videos\\..\\..\\secret.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "C:relative.txt",
    "\\\\server\\share\\file",
    "file\0.mp4",
    "",
  ])("rejects %j", (input) => {
    expect(() => resolveStoragePath(input, root)).toThrow(UnsafePathError);
  });

  it("rejects a link inside storage that points outside it", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    // A directory junction works on Windows without admin rights; on other systems it's a symlink.
    fs.symlinkSync(outside, path.join(root, "escape"), "junction");
    await expect(resolveExistingStoragePath("escape/secret.txt", root)).rejects.toThrow(UnsafePathError);
  });

  it("accepts an existing file inside storage", async () => {
    fs.mkdirSync(path.join(root, "videos"), { recursive: true });
    fs.writeFileSync(path.join(root, "videos", "ok.txt"), "ok");
    await expect(resolveExistingStoragePath("videos/ok.txt", root)).resolves.toBe(
      fs.realpathSync(path.join(root, "videos", "ok.txt")),
    );
  });
});
