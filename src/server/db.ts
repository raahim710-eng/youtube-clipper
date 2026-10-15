import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { DEFAULT_DATABASE_URL, ensureDatabaseDirectory, resolveSqliteFilePath } from "./database-url";

/**
 * Prisma client singleton (SQLite via better-sqlite3).
 * Shared with the Node worker (Phase 3), so it must not import Next.js APIs.
 */

function createPrismaClient(): PrismaClient {
  const filePath = resolveSqliteFilePath(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
  ensureDatabaseDirectory(filePath);
  // `timeout`: wait up to 5 s for a write lock instead of failing immediately.
  const adapter = new PrismaBetterSqlite3({ url: filePath, timeout: 5000 });
  const client = new PrismaClient({ adapter });
  // WAL lets readers and the single writer work at the same time. The setting is stored in the file.
  void client.$queryRawUnsafe("PRAGMA journal_mode = WAL;").catch(() => undefined);
  return client;
}

// Reuse one client across hot reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
