import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/server/db";

/** Creates a user directly in the database (bypasses the one-owner sign-up rule on purpose). */
export async function createTestUser(label: string) {
  return db.user.create({ data: { id: randomUUID(), name: label, email: `${label}-${randomUUID()}@example.test` } });
}

/** Bytes that pass the MP4 content check: an `ftyp` box followed by random data. */
export function fakeMp4(size: number): Buffer {
  const buffer = randomBytes(size);
  Buffer.from([0, 0, 0, 0x20, ...Buffer.from("ftypisom")]).copy(buffer, 0);
  return buffer;
}

export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([new Uint8Array(bytes)]).stream();
}
