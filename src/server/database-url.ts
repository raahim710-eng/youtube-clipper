import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DATABASE_URL = "file:./data/app.db";

/**
 * Turns a SQLite URL like `file:./data/app.db` into an absolute file path.
 * Relative paths are resolved from the project root (the working directory of
 * `npm run ...`), so the Prisma CLI and the running app always use the same file.
 */
export function resolveSqliteFilePath(databaseUrl: string, cwd = process.cwd()): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error('DATABASE_URL must be a SQLite file URL, for example "file:./data/app.db".');
  }
  const filePath = databaseUrl.slice("file:".length);
  if (filePath.length === 0) {
    throw new Error("DATABASE_URL does not contain a file path.");
  }
  return path.resolve(cwd, filePath);
}

/** Creates the folder that will hold the database file (SQLite won't create folders itself). */
export function ensureDatabaseDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
