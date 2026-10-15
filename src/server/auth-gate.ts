import "server-only";
import { connection } from "next/server";
import { type ConfigProblem, getAuthConfigProblems } from "./env";
import { logger } from "./logger";
import { getCurrentSession } from "./session";
import { isSetupComplete } from "./services/setup";

/**
 * Decides what /login and /setup should show:
 * - "config": required settings are missing → show how to fix them (no fake login form)
 * - "needs-setup": no owner account yet → /setup
 * - "signed-in": already signed in → go to the app
 * - "ready": show the form
 */
export type AuthGate =
  { kind: "config"; problems: ConfigProblem[] } | { kind: "needs-setup" } | { kind: "signed-in" } | { kind: "ready" };

export async function getAuthGate(): Promise<AuthGate> {
  // Always decide at request time — never prerender this answer at build time.
  await connection();
  const problems = getAuthConfigProblems();
  if (problems.length > 0) return { kind: "config", problems };

  let setupComplete: boolean;
  try {
    setupComplete = await isSetupComplete();
  } catch (error) {
    logger.error("Database check failed on auth page", { error });
    return {
      kind: "config",
      problems: [
        {
          variable: "Database",
          message: "The database isn't ready. Run `npm run db:migrate`, then restart the app.",
        },
      ],
    };
  }

  if (!setupComplete) return { kind: "needs-setup" };
  if (await getCurrentSession()) return { kind: "signed-in" };
  return { kind: "ready" };
}
