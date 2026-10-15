"use server";

import { z } from "zod";
import { llmProviderSchema } from "@/lib/constants";
import type { ActionResult } from "@/server/errors";
import { getCurrentSession } from "@/server/session";
import { TRANSCRIPTION_LANGUAGES, updateAiSettings } from "@/server/services/ai-providers";

const settingsSchema = z.object({
  llmProvider: llmProviderSchema,
  autoTranscribe: z.boolean(),
  defaultLanguage: z
    .string()
    .refine((code) => TRANSCRIPTION_LANGUAGES.some((l) => l.code === code), "Unknown language"),
  channelStyleNotes: z
    .string()
    .trim()
    .max(1000)
    .transform((value) => value || null),
});

export async function updateAiSettingsAction(input: unknown): Promise<ActionResult> {
  const session = await getCurrentSession();
  if (!session) return { ok: false, error: "Your session has expired. Please sign in again." };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the settings and try again." };
  await updateAiSettings(session.user.id, parsed.data);
  return { ok: true, data: undefined };
}
