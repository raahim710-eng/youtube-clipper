/**
 * YouTube metadata limits (PKG-02), shared by the editor (counters) and the server (validation before
 * saving). Mirrors media-worker/src/media_worker/packaging/checks.py.
 *
 * YouTube Data API (videos resource): title ≤ 100 characters, description ≤ 5,000 bytes; neither may
 * contain < or >.
 */

export const TITLE_MAX_CHARS = 100;
export const DESCRIPTION_MAX_BYTES = 5_000;
export const HASHTAGS_MAX = 15;
export const HASHTAG_MAX_CHARS = 30;
export const HOOK_MAX_CHARS = 200;
export const HEADLINE_MAX_WORDS = 5;

const encoder = new TextEncoder();

/** Characters as YouTube counts them (code points, so an emoji counts once). */
export function charCount(text: string): number {
  return [...text].length;
}

export function byteCount(text: string): number {
  return encoder.encode(text).length;
}

export function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, "");
}

/** A title YouTube will accept: one line, no < or >, at most 100 characters. */
export function cleanTitle(text: string): string {
  const line = stripAngleBrackets(text).replace(/\s+/g, " ").trim();
  return [...line].slice(0, TITLE_MAX_CHARS).join("").trim();
}

/** A description YouTube will accept: no < or >, at most 5,000 bytes (never cutting a character in half). */
export function cleanDescription(text: string): string {
  let value = stripAngleBrackets(text.replace(/\r\n?/g, "\n"));
  if (byteCount(value) <= DESCRIPTION_MAX_BYTES) return value;
  const chars = [...value];
  let bytes = 0;
  let end = 0;
  for (; end < chars.length; end += 1) {
    bytes += byteCount(chars[end]);
    if (bytes > DESCRIPTION_MAX_BYTES) break;
  }
  value = chars.slice(0, end).join("");
  return value;
}

/** "#Video Editing!" → "VideoEditing"; null when nothing usable is left. */
export function normalizeHashtag(raw: string): string | null {
  const parts = raw.replace(/#/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  const tag = parts.map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1))).join("");
  if (!tag || /^\d+$/.test(tag) || charCount(tag) > HASHTAG_MAX_CHARS) return null;
  return tag;
}

/** Normalised, without duplicates (case-insensitive), at most 15. */
export function cleanHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = normalizeHashtag(raw);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    result.push(tag);
  }
  return result.slice(0, HASHTAGS_MAX);
}

export function cleanHeadline(text: string): string {
  return stripAngleBrackets(text).split(/\s+/).filter(Boolean).slice(0, HEADLINE_MAX_WORDS).join(" ");
}

/** What "Copy all" puts on the clipboard: title, blank line, description, blank line, hashtags. */
export function packagingText(title: string, description: string, hashtags: string[]): string {
  return [title, description, hashtags.map((tag) => `#${tag}`).join(" ")]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}
