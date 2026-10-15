import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, restoreBackup } from "../../scripts/lib/backup.mjs";

let root: string;

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeDatabase(file: string, note: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE _prisma_migrations (migration_name TEXT, finished_at TEXT); CREATE TABLE note (text TEXT);");
  db.prepare("INSERT INTO _prisma_migrations VALUES (?, ?)").run("20261013160627_init", "2026-10-13");
  db.prepare("INSERT INTO note VALUES (?)").run(note);
  return db; // left open, like the running app
}

function readNote(file: string): string {
  const db = new Database(file, { readonly: true });
  const row = db.prepare("SELECT text FROM note").get() as { text: string };
  db.close();
  return row.text;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("backup and restore (Phase 10)", () => {
  it("copies the live database consistently and the storage without temporary files", async () => {
    const dbFile = path.join(root, "data", "app.db");
    const live = makeDatabase(dbFile, "original");
    const storage = path.join(root, "storage");
    write(path.join(storage, "videos", "v1", "source.mp4"), "video");
    write(path.join(storage, "videos", "v1", "transcript.json"), "{}");
    write(path.join(storage, "uploads", "tmp", "u1", "data.bin"), "half an upload");
    write(path.join(storage, "shorts", "s1", "render-x.partial.mp4"), "unfinished");
    write(path.join(storage, "generator", "p1", "render", "seg_000.mp4"), "temp");
    write(path.join(storage, "stock-cache", "search", "pexels", "a.json"), "{}");

    const { dir, manifest } = await createBackup({
      databaseFile: dbFile,
      storageDir: storage,
      outDir: path.join(root, "backups"),
      now: new Date("2026-10-14T20:15:00Z"),
    });
    live.close();
    expect(path.basename(dir)).toBe("backup-20261014-201500");
    expect(manifest).toMatchObject({
      database: { integrity: "ok", migrations: ["20261013160627_init"] },
      storage: { files: 2, includesMedia: true },
      includesEnv: false,
    });
    expect(readNote(path.join(dir, "app.db"))).toBe("original");
    expect(fs.existsSync(path.join(dir, "storage", "videos", "v1", "source.mp4"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "storage", "uploads"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "storage", "shorts"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "env.backup"))).toBe(false);
  });

  it("can leave out the videos", async () => {
    const dbFile = path.join(root, "app.db");
    makeDatabase(dbFile, "x").close();
    const storage = path.join(root, "storage");
    write(path.join(storage, "videos", "v1", "source.mkv"), "video");
    write(path.join(storage, "videos", "v1", "poster.jpg"), "jpg");
    write(path.join(storage, "shorts", "s1", "render-abc.mp4"), "short");
    const { dir, manifest } = await createBackup({
      databaseFile: dbFile,
      storageDir: storage,
      outDir: path.join(root, "backups"),
      includeMedia: false,
    });
    expect(manifest.storage).toMatchObject({ files: 1, includesMedia: false });
    expect(fs.existsSync(path.join(dir, "storage", "videos", "v1", "poster.jpg"))).toBe(true);
  });

  it("restores a backup and keeps the replaced data aside", async () => {
    const dbFile = path.join(root, "data", "app.db");
    makeDatabase(dbFile, "backed up").close();
    const storage = path.join(root, "storage");
    write(path.join(storage, "thumbnails", "t1.jpg"), "old thumb");
    const { dir } = await createBackup({
      databaseFile: dbFile,
      storageDir: storage,
      outDir: path.join(root, "backups"),
    });

    // Things change after the backup…
    fs.rmSync(dbFile);
    makeDatabase(dbFile, "newer").close();
    write(path.join(storage, "thumbnails", "t2.jpg"), "new thumb");

    const park = path.join(root, "backups", "before-restore");
    restoreBackup({ backupDir: dir, databaseFile: dbFile, storageDir: storage, parkDir: park });
    expect(readNote(dbFile)).toBe("backed up");
    expect(fs.readdirSync(path.join(storage, "thumbnails"))).toEqual(["t1.jpg"]);
    expect(readNote(path.join(park, "data", "app.db"))).toBe("newer");
    expect(fs.existsSync(path.join(park, "storage", "thumbnails", "t2.jpg"))).toBe(true);
  });

  it("refuses a folder that isn't a backup", () => {
    expect(() =>
      restoreBackup({
        backupDir: root,
        databaseFile: path.join(root, "x.db"),
        storageDir: path.join(root, "s"),
        parkDir: path.join(root, "p"),
      }),
    ).toThrow(/isn't a backup/);
  });
});
