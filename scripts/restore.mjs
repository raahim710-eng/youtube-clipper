// Restores a backup made by `npm run backup`.
// Usage: npm run restore -- backups\backup-20261014-201500 --yes
// Stop the app and workers first. Your current database and storage folder are not deleted: they are
// moved to backups/before-restore-<time>/ so you can undo the restore.
import "dotenv/config";
import path from "node:path";
import { databaseFileFrom, restoreBackup, timestamp } from "./lib/backup.mjs";

async function appIsRunning(appUrl) {
  try {
    const response = await fetch(new URL("/api/health", appUrl), { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const backupDir = args.find((arg) => !arg.startsWith("--"));
  if (!backupDir || !args.includes("--yes")) {
    console.log("Usage: npm run restore -- <backup folder> --yes");
    console.log("Stop the app first (Ctrl+C in the window running npm run start:all or dev:all).");
    console.log("Your current data is kept in backups/before-restore-<time>/, so a restore can be undone.");
    return 1;
  }
  const appUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
  if (await appIsRunning(appUrl)) {
    console.error(`The app is still running at ${appUrl}. Stop it (and its workers) before restoring.`);
    return 1;
  }
  try {
    const parkDir = path.resolve("backups", `before-restore-${timestamp()}`);
    const { manifest, storageFiles } = restoreBackup({
      backupDir: path.resolve(backupDir),
      databaseFile: databaseFileFrom(process.env.DATABASE_URL),
      storageDir: path.resolve(process.env.STORAGE_DIR || "./storage"),
      parkDir,
    });
    console.log(`Restored the backup from ${manifest.createdAt} (${storageFiles} storage files).`);
    console.log(`Your previous data was moved to ${parkDir} — delete it once everything works.`);
    if (!manifest.storage.includesMedia) {
      console.log("This backup had no videos: those library items will show their files as missing.");
    }
    console.log("Next: run `npm run db:deploy` (applies any newer migrations), then start the app.");
    return 0;
  } catch (error) {
    console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Setting exitCode (instead of process.exit) lets Node close its network handles cleanly on Windows.
process.exitCode = await main();
