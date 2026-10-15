/**
 * Resets the owner's password from the command line (FND-07, SECURITY.md §2).
 * Requires access to this computer, which is the security boundary for a local app.
 *
 * Usage: npm run auth:reset-password
 * The new password is typed at a prompt (never passed as a command-line argument,
 * so it doesn't end up in shell history). All existing sessions are signed out.
 */
import "dotenv/config";
import { hashPassword } from "better-auth/crypto";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { db } from "../src/server/db";
import { emailSchema, passwordSchema } from "../src/lib/validation/auth";

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  try {
    const email = emailSchema.parse(await readline.question("Owner email: "));
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) {
      console.error("No account with that email exists.");
      process.exitCode = 1;
      return;
    }

    output.write("Note: the password will be visible while you type it.\n");
    const password = await readline.question("New password: ");
    const check = passwordSchema.safeParse(password);
    if (!check.success) {
      console.error(check.error.issues.map((issue) => issue.message).join(" "));
      process.exitCode = 1;
      return;
    }
    const confirmation = await readline.question("Repeat new password: ");
    if (confirmation !== password) {
      console.error("Passwords don't match. Nothing changed.");
      process.exitCode = 1;
      return;
    }

    const hashed = await hashPassword(password);
    const updated = await db.account.updateMany({
      where: { userId: user.id, providerId: "credential" },
      data: { password: hashed },
    });
    if (updated.count === 0) {
      console.error("This account has no password login to reset.");
      process.exitCode = 1;
      return;
    }
    const { count } = await db.session.deleteMany({ where: { userId: user.id } });
    await db.auditLog.create({
      data: { userId: user.id, action: "auth.password_changed", detailsJson: JSON.stringify({ via: "cli" }) },
    });
    console.log(`Password updated. Signed out ${count} session(s).`);
  } finally {
    readline.close();
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
