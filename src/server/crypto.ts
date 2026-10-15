import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors";

/**
 * AES-256-GCM encryption for OAuth tokens and other secrets stored in the database (SECURITY.md §3.3).
 * Format: `v1:<iv>:<tag>:<ciphertext>` (base64), with a random 96-bit IV per value; the auth tag is
 * verified on decrypt, so a changed value or a wrong key fails instead of returning garbage.
 * Shared with the Node worker, so it must not import Next.js APIs.
 */

export const KEY_VERSION = 1;
const PREFIX = "v1";

export class DecryptionError extends Error {
  constructor() {
    super("The stored secret couldn't be decrypted (wrong TOKEN_ENCRYPTION_KEY or damaged value).");
    this.name = "DecryptionError";
  }
}

/** The 32-byte key from TOKEN_ENCRYPTION_KEY, or null with the reason it can't be used. */
export function readEncryptionKey(raw = process.env.TOKEN_ENCRYPTION_KEY): { key: Buffer } | { problem: string } {
  const value = raw?.trim();
  if (!value) return { problem: "TOKEN_ENCRYPTION_KEY is not set." };
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    return { problem: "TOKEN_ENCRYPTION_KEY must be exactly 32 random bytes, base64-encoded (44 characters)." };
  }
  return { key };
}

function requireKey(key?: Buffer): Buffer {
  if (key) return key;
  const result = readEncryptionKey();
  if ("problem" in result) throw new AppError("CONFIGURATION", `${result.problem} Run \`npm run setup:env\`.`);
  return result.key;
}

export function encryptSecret(plaintext: string, key?: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requireKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(value: string, key?: Buffer): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new DecryptionError();
  const [, iv, tag, ciphertext] = parts.map((part, i) => (i === 0 ? Buffer.alloc(0) : Buffer.from(part, "base64")));
  if (iv.length !== 12 || tag.length !== 16) throw new DecryptionError();
  const secretKey = requireKey(key);
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}
