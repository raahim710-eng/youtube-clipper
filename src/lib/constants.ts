import { z } from "zod";

/**
 * Status values stored as strings in SQLite (no native enums) — CLAUDE.md conventions.
 * Each union has a matching Zod schema for validation at boundaries.
 */

export const VIDEO_STATUSES = ["processing", "ready", "failed"] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];
export const videoStatusSchema = z.enum(VIDEO_STATUSES);

export const UPLOAD_STATUSES = ["in_progress", "completed", "cancelled", "expired", "failed"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running"];

/** Job types that exist so far (TECHNICAL_SPEC.md §6). */
export const JOB_TYPES = [
  "media.ingest",
  "media.transcribe",
  "ai.find_clips",
  "media.reframe",
  "media.render_short",
  "ai.package",
  "media.thumbnail_mockup",
  "yt.upload",
  "gen.script",
  "gen.narrate",
  "gen.footage",
  "gen.render",
] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const jobTypeSchema = z.enum(JOB_TYPES);

/** Human-readable job names for the activity drawer. */
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  "media.ingest": "Processing video",
  "media.transcribe": "Transcribing",
  "ai.find_clips": "Finding clips",
  "media.reframe": "Finding faces for framing",
  "media.render_short": "Exporting Short",
  "ai.package": "Writing packaging",
  "media.thumbnail_mockup": "Making thumbnail",
  "yt.upload": "Uploading to YouTube",
  "gen.script": "Writing a script",
  "gen.narrate": "Recording narration",
  "gen.footage": "Finding stock footage",
  "gen.render": "Rendering generated video",
};

/** Clip analysis providers (Settings › AI & processing). "none" = speech patterns only, no AI. */
export const LLM_PROVIDERS = ["ollama", "gemini", "openai_compatible", "none"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export const llmProviderSchema = z.enum(LLM_PROVIDERS);

export const CLIP_STATUSES = ["suggested", "accepted", "rejected"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];
export const clipStatusSchema = z.enum(CLIP_STATUSES);

export const CLIP_ORIGINS = ["ai", "heuristic", "manual"] as const;
export type ClipOrigin = (typeof CLIP_ORIGINS)[number];

export const CLIP_CATEGORIES = [
  "explanation",
  "surprising_fact",
  "story",
  "strong_reaction",
  "engaging_statement",
  "other",
] as const;
export type ClipCategory = (typeof CLIP_CATEGORIES)[number];
export const CLIP_CATEGORY_LABELS: Record<ClipCategory, string> = {
  explanation: "Useful explanation",
  surprising_fact: "Surprising fact",
  story: "Story",
  strong_reaction: "Strong reaction",
  engaging_statement: "Engaging statement",
  other: "Other",
};

/** Shorts can be up to 3 minutes; clips shorter than 1 second make no sense. */
export const CLIP_MIN_MS = 1_000;
export const CLIP_MAX_MS = 180_000;

/** Shorts editor (Phase 5). */
export const SHORT_STATUSES = ["draft", "rendering", "ready", "failed"] as const;
export type ShortStatus = (typeof SHORT_STATUSES)[number];

/** auto = face tracking, center = centre crop, blur = whole frame over a blurred copy, manual = chosen position. */
export const REFRAME_MODES = ["auto", "center", "blur", "manual"] as const;
export type ReframeMode = (typeof REFRAME_MODES)[number];
export const REFRAME_MODE_LABELS: Record<ReframeMode, string> = {
  auto: "Auto (follow faces)",
  center: "Centre",
  blur: "Fit with blurred background",
  manual: "Manual position",
};

export const REFRAME_STATUSES = ["none", "processing", "ready", "failed"] as const;
export type ReframeStatus = (typeof REFRAME_STATUSES)[number];

export const EXPORT_QUALITIES = ["standard", "high"] as const;
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

/** AI packaging (Phase 6). */
export const PACKAGING_TARGET_KINDS = ["video", "short"] as const;
export type PackagingTargetKind = (typeof PACKAGING_TARGET_KINDS)[number];

/** Thumbnails are real frames, frames with a headline, or the creator's upload — never AI-generated images. */
export const THUMBNAIL_ORIGINS = ["frame", "mockup", "upload"] as const;
export type ThumbnailOrigin = (typeof THUMBNAIL_ORIGINS)[number];
export const THUMBNAIL_ORIGIN_LABELS: Record<ThumbnailOrigin, string> = {
  frame: "Video frame",
  mockup: "Mock-up: video frame + your text",
  upload: "Your image",
};

/** YouTube publishing (Phase 7). */
export const PRIVACY_STATUSES = ["private", "unlisted", "public"] as const;
export type PrivacyStatus = (typeof PRIVACY_STATUSES)[number];
export const PRIVACY_LABELS: Record<PrivacyStatus, string> = {
  private: "Private",
  unlisted: "Unlisted",
  public: "Public",
};

export const PUBLICATION_STATUSES = ["queued", "uploading", "uploaded", "scheduled", "failed", "cancelled"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];
export const PUBLICATION_STATUS_LABELS: Record<PublicationStatus, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  uploaded: "Uploaded",
  scheduled: "Scheduled",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * YouTube's assignable video categories (ids are stable across regions; titles shown in English).
 * A fixed list avoids spending quota on `videoCategories.list`.
 */
export const YOUTUBE_CATEGORIES = [
  { id: "1", label: "Film & Animation" },
  { id: "2", label: "Autos & Vehicles" },
  { id: "10", label: "Music" },
  { id: "15", label: "Pets & Animals" },
  { id: "17", label: "Sports" },
  { id: "19", label: "Travel & Events" },
  { id: "20", label: "Gaming" },
  { id: "22", label: "People & Blogs" },
  { id: "23", label: "Comedy" },
  { id: "24", label: "Entertainment" },
  { id: "25", label: "News & Politics" },
  { id: "26", label: "Howto & Style" },
  { id: "27", label: "Education" },
  { id: "28", label: "Science & Technology" },
  { id: "29", label: "Nonprofits & Activism" },
] as const;

/** Original video generator (Phase 9). */
export const GENERATOR_STATUSES = ["draft", "scripting", "editing", "rendering", "ready"] as const;
export type GeneratorStatus = (typeof GENERATOR_STATUSES)[number];

export const GENERATOR_NICHES = [
  { id: "education", label: "Education & explainers" },
  { id: "science", label: "Science" },
  { id: "technology", label: "Technology" },
  { id: "history", label: "History" },
  { id: "nature", label: "Nature & animals" },
  { id: "travel", label: "Travel & places" },
  { id: "food", label: "Food & cooking" },
  { id: "health", label: "Health & fitness (general information only)" },
  { id: "money", label: "Money & business (no financial advice)" },
  { id: "motivation", label: "Motivation & self-improvement" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "entertainment", label: "Entertainment & trivia" },
] as const;
export type GeneratorNiche = (typeof GENERATOR_NICHES)[number]["id"];
export const GENERATOR_NICHE_IDS = GENERATOR_NICHES.map((niche) => niche.id) as [GeneratorNiche, ...GeneratorNiche[]];

export const GENERATOR_TONES = ["friendly", "energetic", "calm", "serious", "humorous", "inspiring"] as const;
export type GeneratorTone = (typeof GENERATOR_TONES)[number];

/** Target lengths offered (seconds). 30 s–5 min (GEN-01); Shorts are at most 3 minutes. */
export const GENERATOR_DURATIONS = [30, 45, 60, 90, 120, 180, 240, 300] as const;
export const GENERATOR_RESOLUTIONS = [720, 1080] as const;
export const ASPECT_RATIOS = ["9:16", "16:9"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const FOOTAGE_SOURCES = ["stock", "library", "upload"] as const;
export type FootageSource = (typeof FOOTAGE_SOURCES)[number];
