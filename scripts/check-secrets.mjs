// Security check (TESTING.md §4): after `npm run build`, makes sure no secret value from .env ended up
// in the files sent to the browser (.next/static), and that no secret-looking file is tracked by Git.
// Usage: npm run build && npm run check:secrets
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "WORKER_SHARED_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_SECRET",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
];

const problems = [];
const env = { ...(fs.existsSync(".env") ? parse(fs.readFileSync(".env")) : {}), ...process.env };
const secrets = SECRET_NAMES.map((name) => [name, env[name]]).filter(([, value]) => value && value.length >= 8);

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else yield full;
  }
}

const bundle = path.join(".next", "static");
if (!fs.existsSync(bundle)) {
  problems.push("No production build found (.next/static). Run `npm run build` first.");
} else {
  let scanned = 0;
  for (const file of files(bundle)) {
    if (!/\.(js|css|html|json|map|txt)$/.test(file)) continue;
    scanned += 1;
    const text = fs.readFileSync(file, "utf8");
    for (const [name, value] of secrets) {
      if (text.includes(value)) problems.push(`${name}'s value appears in ${file}`);
    }
  }
  console.log(`Scanned ${scanned} browser files for ${secrets.length} configured secret values.`);
}

try {
  // Tracked files plus new files `git add .` would pick up (everything that isn't ignored).
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const risky = tracked.filter(
    (file) =>
      /(^|\/)\.env($|\.(?!example$))/.test(file) ||
      /\.(db|sqlite3?|pem|key)$/.test(file) ||
      /(^|\/)(data|storage|backups|models)\//.test(file) ||
      /(client_secret|credentials|service-account|oauth-token)[^/]*\.json$/.test(file),
  );
  for (const file of risky) problems.push(`Git would include a file that must stay private: ${file}`);
  console.log(`Checked ${tracked.length} files that Git tracks or would add.`);
} catch {
  console.log("Git isn't available here; skipped the tracked-files check.");
}

if (problems.length > 0) {
  console.error(`\nSecret check FAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("Secret check passed: no secrets in the browser bundle or in Git.");
