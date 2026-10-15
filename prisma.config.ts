// Prisma CLI configuration (migrate, generate, studio).
// The running app builds its own connection in src/server/db.ts using the same DATABASE_URL.
import "dotenv/config";
import { defineConfig } from "prisma/config";
import { DEFAULT_DATABASE_URL, ensureDatabaseDirectory, resolveSqliteFilePath } from "./src/server/database-url";

const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
const databaseFile = resolveSqliteFilePath(databaseUrl);
ensureDatabaseDirectory(databaseFile);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // An absolute path avoids Prisma 7 resolving relative paths from a different folder.
    url: `file:${databaseFile}`,
  },
});
