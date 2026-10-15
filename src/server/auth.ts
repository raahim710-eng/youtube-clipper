import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { isCommonPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/validation/auth";
import { recordAuditEvent } from "./audit";
import { db } from "./db";
import { getAuthConfigProblems, getEnv } from "./env";
import { AppError } from "./errors";

/**
 * Better Auth configuration (DECISIONS.md D-004, SECURITY.md §2).
 * Email + password only; sign-up is allowed only while no user exists (first-run setup).
 */

const SIGN_UP_CLOSED_MESSAGE = "Sign-up is closed. This app already has an owner account.";
const OWNER_LOCK_ID = "owner";

async function ownerExists(): Promise<boolean> {
  return (await db.user.count()) > 0;
}

function readBodyField(body: unknown, field: string): string | undefined {
  if (body && typeof body === "object" && field in body) {
    const value = (body as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function buildAuth() {
  const env = getEnv();

  return betterAuth({
    appName: env.NEXT_PUBLIC_APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: prismaAdapter(db, { provider: "sqlite" }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh expiry at most once a day
    },
    rateLimit: {
      // Better Auth only enables rate limiting in production by default; we want it always.
      enabled: true,
      storage: "memory",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    telemetry: { enabled: false },
    // Always check the Origin header on state-changing requests (CSRF protection).
    // Better Auth would otherwise skip this when it detects a test environment.
    advanced: { disableOriginCheck: false },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          if (await ownerExists()) {
            throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED_MESSAGE });
          }
          const password = readBodyField(ctx.body, "password");
          if (password && isCommonPassword(password)) {
            throw new APIError("BAD_REQUEST", { message: "This password is too common. Choose another." });
          }
        }
        if (ctx.path === "/change-password") {
          // Changing the password always signs out every other device (SECURITY.md §2) — not the browser's choice.
          if (
            !ctx.body ||
            typeof ctx.body !== "object" ||
            (ctx.body as Record<string, unknown>).revokeOtherSessions !== true
          ) {
            throw new APIError("BAD_REQUEST", { message: "Changing the password must sign out other devices." });
          }
          const newPassword = readBodyField(ctx.body, "newPassword");
          if (newPassword && isCommonPassword(newPassword)) {
            throw new APIError("BAD_REQUEST", { message: "This password is too common. Choose another." });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const failed = ctx.context.returned instanceof APIError;
        if (ctx.path === "/sign-in/email") {
          if (failed) {
            await recordAuditEvent({
              action: "auth.login_failed",
              details: { email: readBodyField(ctx.body, "email") ?? null },
            });
          } else if (ctx.context.newSession) {
            await recordAuditEvent({ action: "auth.login", userId: ctx.context.newSession.user.id });
          }
        }
        if (ctx.path === "/change-password" && !failed && ctx.context.session) {
          await recordAuditEvent({ action: "auth.password_changed", userId: ctx.context.session.user.id });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Defence in depth: refuse any second user, whichever endpoint tries to create it. The lock
          // row has a fixed primary key, so two simultaneous first-run sign-ups can't both succeed.
          before: async () => {
            if (await ownerExists()) {
              throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED_MESSAGE });
            }
            try {
              await db.ownerLock.create({ data: { id: OWNER_LOCK_ID } });
            } catch {
              throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED_MESSAGE });
            }
          },
          after: async (user) => {
            await db.userSettings.create({ data: { userId: user.id } });
            await recordAuditEvent({ action: "auth.setup_completed", userId: user.id });
          },
        },
      },
    },
    // Must be the last plugin: lets server actions set auth cookies.
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let authInstance: Auth | undefined;

/**
 * Returns the Better Auth instance, or throws a CONFIGURATION error when required
 * settings (e.g. BETTER_AUTH_SECRET) are missing. Callers decide how to show that.
 */
export function getAuth(): Auth {
  const problems = getAuthConfigProblems();
  if (problems.length > 0) {
    throw new AppError(
      "CONFIGURATION",
      `Authentication is not configured: ${problems.map((p) => p.variable).join(", ")}.`,
    );
  }
  authInstance ??= buildAuth();
  return authInstance;
}
