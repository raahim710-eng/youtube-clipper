/**
 * Expected, user-facing failures. The message must be safe to show in the UI;
 * put technical details in `cause` (logged server-side only).
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "CONFIGURATION"
  | "INTERNAL";

const HTTP_STATUS: Record<AppErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  CONFIGURATION: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Result shape returned by server actions to forms. */
export type ActionResult<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "Something went wrong. Please try again.";
}
