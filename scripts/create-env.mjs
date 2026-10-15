// Creates `.env` from `.env.example` and fills in freshly generated secrets.
// Usage: npm run setup:env
// It never overwrites an existing `.env`.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplePath = path.join(root, ".env.example");
const envPath = path.join(root, ".env");

const GENERATED_SECRETS = ["BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET", "TOKEN_ENCRYPTION_KEY"];

if (existsSync(envPath)) {
  console.log(".env already exists — nothing changed. Delete it first if you really want a new one.");
  process.exit(0);
}

let content = readFileSync(examplePath, "utf8");
for (const name of GENERATED_SECRETS) {
  const secret = randomBytes(32).toString("base64");
  content = content.replace(new RegExp(`^${name}=""$`, "m"), `${name}="${secret}"`);
}

writeFileSync(envPath, content, { encoding: "utf8", flag: "wx" });
console.log(`Created .env with new values for: ${GENERATED_SECRETS.join(", ")}.`);
console.log("Keep this file private. It is ignored by Git.");
