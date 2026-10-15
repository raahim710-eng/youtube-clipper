import { z } from "zod";
import type { Job } from "@/generated/prisma/client";
import {
  cleanDescription,
  cleanHashtags,
  cleanHeadline,
  cleanTitle,
  HOOK_MAX_CHARS,
  stripAngleBrackets,
} from "@/lib/packaging/limits";
import { db } from "../db";
import type { JobHandler } from "./handlers";

/**
 * ai.package — titles, description, hashtags, hooks, thumbnail concepts and chapters (PKG-01…07,
 * TECHNICAL_SPEC.md §7.4). The worker enforces YouTube's limits; they are enforced here again before saving.
 */
const flagged = z.object({ text: z.string().trim().min(1).max(300), flags: z.array(z.string().max(300)).max(5) });

export const aiPackageResultSchema = z.object({
  provider: z.string().min(1).max(50),
  model: z.string().min(1).max(100),
  format: z.enum(["long", "short"]),
  usedSummary: z.boolean(),
  sourceWords: z.number().int().nonnegative(),
  titles: z.array(flagged).min(1).max(10),
  hooks: z.array(flagged).max(6),
  description: z.string().max(20_000),
  descriptionFlags: z.array(z.string().max(300)).max(5),
  hashtags: z.array(z.string().max(60)).max(30),
  droppedHashtags: z.array(z.string().max(60)).max(30),
  concepts: z
    .array(
      z.object({
        headline: z.string().trim().min(1).max(80),
        composition: z.string().max(400),
        emotion: z.string().max(80),
        frameMs: z.number().int().nonnegative().nullable(),
        flags: z.array(z.string().max(300)).max(5),
      }),
    )
    .max(6),
  chapters: z.array(z.object({ startMs: z.number().int().nonnegative(), title: z.string().min(1).max(80) })).max(20),
  warnings: z.array(z.string().max(400)).max(10),
});
export type AiPackageResult = z.infer<typeof aiPackageResultSchema>;

/** The editable working copy stored on the set (also what "generatedJson" keeps for comparison). */
export function packagingFromResult(result: AiPackageResult) {
  return {
    titles: result.titles.map((t) => ({ text: cleanTitle(t.text), flags: t.flags, edited: false })),
    description: cleanDescription(result.description),
    descriptionFlags: result.descriptionFlags,
    hashtags: cleanHashtags(result.hashtags).map((tag) => ({ tag, selected: true })),
    hooks: result.hooks.map((h) => ({
      text: stripAngleBrackets(h.text).slice(0, HOOK_MAX_CHARS),
      flags: h.flags,
      edited: false,
    })),
    concepts: result.concepts.slice(0, 3).map((c) => ({ ...c, headline: cleanHeadline(c.headline) })),
    chapters: result.chapters,
    warnings: result.warnings,
  };
}

function setIdOf(job: Job): string | null {
  return job.entityType === "packaging" && job.entityId ? job.entityId : null;
}

export const aiPackageHandler: JobHandler<AiPackageResult> = {
  resultSchema: aiPackageResultSchema,

  async onSucceeded(tx, job, result) {
    const setId = setIdOf(job);
    if (!setId) return;
    const set = await tx.packagingSet.findUnique({ where: { id: setId }, select: { id: true } });
    if (!set) return; // deleted meanwhile
    const working = packagingFromResult(result);
    await tx.packagingSet.update({
      where: { id: setId },
      data: {
        status: "ready",
        error: null,
        provider: result.provider,
        model: result.model,
        titlesJson: JSON.stringify(working.titles),
        description: working.description,
        hashtagsJson: JSON.stringify(working.hashtags),
        hooksJson: JSON.stringify(working.hooks),
        thumbnailConceptsJson: JSON.stringify(working.concepts),
        chaptersJson: JSON.stringify(working.chapters),
        warningsJson: JSON.stringify(
          result.usedSummary
            ? [
                `The transcript (${result.sourceWords} words) was summarised first to fit the AI model.`,
                ...working.warnings,
              ]
            : working.warnings,
        ),
        generatedJson: JSON.stringify(working),
        selectedTitle: 0,
        selectedHook: 0,
      },
    });
  },

  async onFailed(job) {
    const setId = setIdOf(job);
    if (!setId) return;
    await db.packagingSet.updateMany({
      where: { id: setId },
      data: { status: "failed", error: job.status === "cancelled" ? "Cancelled by you." : (job.error ?? "Failed.") },
    });
  },

  async cannotRetryReason(job) {
    const setId = setIdOf(job);
    if (!setId) return "This job is no longer linked to packaging.";
    const set = await db.packagingSet.findUnique({ where: { id: setId }, select: { id: true } });
    return set ? null : "This packaging was deleted.";
  },

  async onRetry(tx, job) {
    const setId = setIdOf(job);
    if (setId) await tx.packagingSet.update({ where: { id: setId }, data: { status: "processing", error: null } });
  },
};
