// Backs up the database and storage folder into backups/backup-<time>/ (git-ignored).
// Usage:
//   npm run backup                       database + all media
//   npm run backup -- --no-media         database + small files only (transcripts, thumbnails, narration…)
//   npm run backup -- --include-env      also copy .env (contains secrets — keep the backup private)
//   npm run backup -- --out D:\Backups   write somewhere else, e.g. an external drive
// Safe while the app is running: the database copy uses SQLite's online backup.
import "dotenv/config";
import path from "node:path";
import { createBackup, databaseFileFrom } from "./lib/backup.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 && args[outIndex + 1] ? path.resolve(args[outIndex + 1]) : path.resolve("backups");
const includeEnv = args.includes("--include-env");

try {
  const { dir, manifest } = await createBackup({
    databaseFile: databaseFileFrom(process.env.DATABASE_URL),
    storageDir: path.resolve(process.env.STORAGE_DIR || "./storage"),
    outDir,
    includeMedia: !args.includes("--no-media"),
    envFile: includeEnv ? path.resolve(".env") : null,
  });
  const megabytes = (manifest.storage.bytes / 1024 / 1024).toFixed(1);
  console.log(`Backup written to ${dir}`);
  console.log(`  Database: OK (integrity check passed, ${manifest.database.migrations.length} migrations)`);
  console.log(
    `  Storage: ${manifest.storage.files} files, ${megabytes} MB${manifest.storage.includesMedia ? "" : " (without videos)"}`,
  );
  if (includeEnv) {
    console.log("  .env copied as env.backup — it contains your secrets. Keep this backup private.");
  } else {
    console.log("  .env was NOT copied. Keep your own safe copy: without TOKEN_ENCRYPTION_KEY, YouTube channels");
    console.log("  must be reconnected after a restore.");
  }
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
