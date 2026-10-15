// Backup and restore of the app's data: the SQLite database and the storage folder.
// Used by scripts/backup.mjs and scripts/restore.mjs (and tested in tests/integration/backup.test.ts).
// Plain Node (no Next.js), so it works while the app is stopped — and the backup also while it runs.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const DEFAULT_DATABASE_URL = "file:./data/app.db";

/** Same rule as src/server/database-url.ts: relative paths are resolved from the project root. */
export function databaseFileFrom(databaseUrl, cwd = process.cwd()) {
  const url = databaseUrl || DEFAULT_DATABASE_URL;
  if (!url.startsWith("file:") || url.length <= 5) throw new Error('DATABASE_URL must look like "file:./data/app.db".');
  return path.resolve(cwd, url.slice(5));
}

/** Files that are only temporary or can be rebuilt: never worth backing up. */
function skipped(relative) {
  const p = relative.split(path.sep).join("/");
  return (
    p.startsWith("uploads/tmp") ||
    p.startsWith("stock-cache/search") ||
    /(^|\/)generator\/[^/]+\/render(\/|$)/.test(p) ||
    /\.partial(\.[a-z0-9]+)?$/i.test(p)
  );
}

function copyTree(from, to, filter) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(from)) return { files, bytes };
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow links out of the folder
    if (!filter(source)) continue;
    if (entry.isDirectory()) {
      const sub = copyTree(source, target, filter);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      files += 1;
      bytes += fs.statSync(source).size;
    }
  }
  return { files, bytes };
}

function integrityCheck(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    const migrations = db
      .prepare("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name")
      .all()
      .map((row) => row.migration_name);
    return { ok: result === "ok", result, migrations };
  } finally {
    db.close();
  }
}

export function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * Writes `<outDir>/backup-<time>/` with `app.db` (a consistent online copy — safe while the app runs),
 * `storage/` (without temporary files; without original videos and renders when `includeMedia` is false)
 * and `manifest.json`. Secrets (.env) are only copied when asked for.
 */
export async function createBackup({
  databaseFile,
  storageDir,
  outDir,
  includeMedia = true,
  envFile = null,
  now = new Date(),
}) {
  if (!fs.existsSync(databaseFile)) throw new Error(`No database at ${databaseFile}.`);
  const dir = path.join(outDir, `backup-${timestamp(now)}`);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists.`);
  fs.mkdirSync(dir, { recursive: true });

  const source = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(path.join(dir, "app.db"));
  } finally {
    source.close();
  }
  const check = integrityCheck(path.join(dir, "app.db"));
  if (!check.ok) throw new Error(`The backup copy failed SQLite's integrity check: ${check.result}`);

  const root = path.resolve(storageDir);
  const media =
    /(^|\/)(videos\/[^/]+\/(source|preview)\.[a-z0-9]+|shorts\/[^/]+\/render-[^/]+\.mp4|stock-cache\/[^/]+\/[^/]+\.mp4)$/i;
  const copied = copyTree(root, path.join(dir, "storage"), (file) => {
    const relative = path.relative(root, file);
    if (skipped(relative)) return false;
    return includeMedia || !media.test(relative.split(path.sep).join("/"));
  });

  if (envFile) fs.copyFileSync(envFile, path.join(dir, "env.backup"));
  const manifest = {
    format: 1,
    createdAt: now.toISOString(),
    database: { file: "app.db", migrations: check.migrations, integrity: check.result },
    storage: { files: copied.files, bytes: copied.bytes, includesMedia: includeMedia },
    includesEnv: Boolean(envFile),
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

function moveAside(target, parkDir) {
  if (!fs.existsSync(target)) return;
  fs.mkdirSync(parkDir, { recursive: true });
  const destination = path.join(parkDir, path.basename(target));
  try {
    fs.renameSync(target, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    fs.cpSync(target, destination, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Restores a backup made by createBackup. Nothing is deleted: the current database and storage folder
 * are first moved to `<parkDir>` so a mistaken restore can be undone. The app must be stopped.
 */
export function restoreBackup({ backupDir, databaseFile, storageDir, parkDir }) {
  const manifestFile = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestFile) || !fs.existsSync(path.join(backupDir, "app.db"))) {
    throw new Error(`${backupDir} isn't a backup made by "npm run backup" (manifest.json or app.db missing).`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const check = integrityCheck(path.join(backupDir, "app.db"));
  if (!check.ok) throw new Error(`The backup's database is damaged: ${check.result}`);

  for (const suffix of ["", "-wal", "-shm", "-journal"])
    moveAside(`${databaseFile}${suffix}`, path.join(parkDir, "data"));
  moveAside(path.resolve(storageDir), parkDir);

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.copyFileSync(path.join(backupDir, "app.db"), databaseFile);
  fs.mkdirSync(storageDir, { recursive: true });
  const copied = copyTree(path.join(backupDir, "storage"), path.resolve(storageDir), () => true);
  return { manifest, storageFiles: copied.files };
}
