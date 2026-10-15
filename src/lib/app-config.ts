/**
 * Public, non-secret app settings that client components may use.
 * NEXT_PUBLIC_* values are inlined at build time.
 * The display name must not contain "YouTube" (DECISIONS.md D-021).
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Creator Studio Assistant";

/** Phase currently being built (ROADMAP.md). Shown in the UI so placeholders make sense. */
export const CURRENT_PHASE = 9;
