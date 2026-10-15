import "server-only";
import { db } from "../db";

/** True once the owner account exists (FND-01). After that, sign-up is closed. */
export async function isSetupComplete(): Promise<boolean> {
  return (await db.user.count()) > 0;
}
