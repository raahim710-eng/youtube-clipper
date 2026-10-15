import { z } from "zod";

/** Password rules from SECURITY.md §2. Shared by the browser forms and the server. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// A short list of very common passwords that meet the length rule. Not exhaustive —
// the length requirement does most of the work.
const COMMON_PASSWORDS = new Set([
  "password1234",
  "password12345",
  "password123456",
  "123456789012",
  "1234567890123",
  "qwertyuiop12",
  "qwerty123456",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "adminadmin12",
  "administrator",
  "passwordpassword",
  "youtube12345",
  "aaaaaaaaaaaa",
]);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((value) => !isCommonPassword(value), "This password is too common. Choose another.");

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address."));

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});

export const setupSchema = z
  .object({
    name: z.string().trim().min(1, "Enter your name.").max(80, "Use at most 80 characters."),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match.",
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match.",
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    path: ["newPassword"],
    message: "Choose a password different from your current one.",
  });

/** Turns a Zod error into `{ field: [messages] }` for form display. */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    (result[key] ??= []).push(issue.message);
  }
  return result;
}

/**
 * Only allow redirects to paths inside this app (prevents open redirects via ?next=).
 */
export function safeRedirectPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (value.startsWith("/login") || value.startsWith("/setup") || value.startsWith("/api")) {
    return fallback;
  }
  return value;
}
