import { z } from "zod";
import { PRIVACY_STATUSES, YOUTUBE_CATEGORIES } from "@/lib/constants";
import { byteCount, charCount, DESCRIPTION_MAX_BYTES, TITLE_MAX_CHARS } from "@/lib/packaging/limits";

/**
 * What the publish form sends, and the checks before anything is uploaded (YT-04, YT-05, YT-08).
 * Shared by the form (instant feedback) and the server (the real gate).
 */

export const TAGS_MAX_CHARS = 500;
export const SHORT_MAX_MS = 180_000;
/** YouTube needs the scheduled time in the future; a margin avoids it passing during the upload. */
export const SCHEDULE_MIN_LEAD_MS = 15 * 60 * 1000;

export const publishInputSchema = z.object({
  kind: z.enum(["video", "short"]),
  targetId: z.string().min(1).max(100),
  channelId: z.string().min(1).max(100),
  title: z.string().max(300),
  description: z.string().max(20_000),
  tags: z.array(z.string().max(200)).max(100),
  categoryId: z.string().max(5),
  privacyStatus: z.enum(PRIVACY_STATUSES),
  /** ISO 8601 (UTC) — set only when scheduling. */
  publishAt: z.string().datetime().nullable(),
  madeForKids: z.boolean().nullable(),
  containsSyntheticMedia: z.boolean().nullable(),
  thumbnailId: z.string().max(100).nullable(),
});
export type PublishInput = z.infer<typeof publishInputSchema>;

/**
 * Length of the tag list as YouTube counts it: commas between tags count, and a tag containing a space
 * counts as if it were wrapped in quotes (YouTube Data API, snippet.tags).
 */
export function tagsLength(tags: string[]): number {
  return tags.reduce((total, tag, i) => total + charCount(tag) + (tag.includes(" ") ? 2 : 0) + (i > 0 ? 1 : 0), 0);
}

export function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.replace(/[<>,]/g, "").replace(/^#/, "").replace(/\s+/g, " ").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result;
}

export type PublishTargetFacts = {
  kind: "video" | "short";
  fileReady: boolean;
  durationMs: number | null;
  width: number | null;
  height: number | null;
};

/** Plain-language problems that block the upload (empty = OK). */
export function publishProblems(
  input: PublishInput,
  facts: PublishTargetFacts,
  options: { audited: boolean; now?: number },
): string[] {
  const problems: string[] = [];
  const now = options.now ?? Date.now();
  if (!facts.fileReady) {
    problems.push(
      facts.kind === "short"
        ? "Export the Short first — there is no finished MP4 to upload."
        : "The video isn't ready (or its file is missing).",
    );
  }
  if (facts.kind === "short") {
    if (facts.durationMs !== null && facts.durationMs > SHORT_MAX_MS) {
      problems.push("A Short can be at most 3 minutes long. Trim it in the Shorts Editor.");
    }
    if (facts.width !== null && facts.height !== null && facts.width > facts.height) {
      problems.push("A Short must be vertical or square. Export it from the Shorts Editor.");
    }
  }
  const title = input.title.trim();
  if (!title) problems.push("Add a title.");
  if (charCount(title) > TITLE_MAX_CHARS) problems.push("The title is longer than 100 characters.");
  if (/[<>]/.test(input.title) || /[<>]/.test(input.description)) {
    problems.push("Remove < and > from the title and description — YouTube doesn't allow them.");
  }
  if (byteCount(input.description) > DESCRIPTION_MAX_BYTES)
    problems.push("The description is longer than 5,000 bytes.");
  if (tagsLength(cleanTags(input.tags)) > TAGS_MAX_CHARS)
    problems.push("The tags are longer than 500 characters in total.");
  if (!YOUTUBE_CATEGORIES.some((c) => c.id === input.categoryId)) problems.push("Choose a category.");
  if (input.madeForKids === null) problems.push("Answer whether the video is made for kids (YouTube requires it).");
  if (input.containsSyntheticMedia === null)
    problems.push("Answer whether the video contains realistic altered or AI-made content.");
  if (!options.audited) {
    if (input.privacyStatus !== "private") {
      problems.push("Until your Google Cloud project passes YouTube's API audit, uploads are private only.");
    }
    if (input.publishAt)
      problems.push("Scheduling is available after your Google Cloud project passes YouTube's API audit.");
  } else if (input.publishAt) {
    const at = Date.parse(input.publishAt);
    if (!Number.isFinite(at) || at < now + SCHEDULE_MIN_LEAD_MS) {
      problems.push("Schedule at least 15 minutes from now.");
    }
  }
  return problems;
}
