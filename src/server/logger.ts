/**
 * Minimal structured logger with secret redaction.
 * Shared with the Node worker (Phase 3), so it must not import Next.js APIs.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|cookie|verifier|uploadsession|sessionuri/i;
export const REDACTED = "[redacted]";

/** Secrets that can hide inside text, e.g. an error message that quotes a URL or a header. */
const SECRET_IN_TEXT: [RegExp, string][] = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [
    /\b(key|api_key|apikey|token|access_token|refresh_token|client_secret|code|password)=([^&\s'"]+)/gi,
    "$1=[redacted]",
  ],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, "[redacted]"],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted]"],
];

export function redactText(text: string): string {
  return SECRET_IN_TEXT.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/**
 * Returns a copy of `value` with sensitive-looking keys replaced by "[redacted]" and secrets inside text
 * masked. Errors keep their message, stack and cause (AppError causes hold the technical details).
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
      ...(value.cause !== undefined ? { cause: redact(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1);
  }
  return result;
}

function currentLevel(): LogLevel {
  const level = process.env.LOG_LEVEL;
  return level === "debug" || level === "warn" || level === "error" ? level : "info";
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(context ? { context: redact(context) } : {}),
  };
  const output = JSON.stringify(line);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => write("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => write("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => write("error", message, context),
};
