import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  isCommonPassword,
  loginSchema,
  passwordSchema,
  safeRedirectPath,
  setupSchema,
} from "@/lib/validation/auth";

describe("password rules (SECURITY.md §2)", () => {
  it("requires at least 12 characters", () => {
    expect(passwordSchema.safeParse("short-pass1").success).toBe(false);
    expect(passwordSchema.safeParse("long-enough-pass").success).toBe(true);
  });

  it("rejects common passwords regardless of case", () => {
    expect(isCommonPassword("Password1234")).toBe(true);
    expect(passwordSchema.safeParse("password1234").success).toBe(false);
  });

  it("rejects passwords over 128 characters", () => {
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
  });
});

describe("setup form", () => {
  const valid = {
    name: "Owner",
    email: "Owner@Example.test",
    password: "a-long-test-password",
    confirmPassword: "a-long-test-password",
  };

  it("accepts valid input and normalises the email", () => {
    const parsed = setupSchema.parse(valid);
    expect(parsed.email).toBe("owner@example.test");
  });

  it("reports mismatched passwords on the confirm field", () => {
    const result = setupSchema.safeParse({ ...valid, confirmPassword: "different-password" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["confirmPassword"]);
  });
});

describe("login and change-password forms", () => {
  it("requires a valid email and any password", () => {
    expect(loginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.test", password: "" }).success).toBe(false);
  });

  it("refuses a new password equal to the current one", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "a-long-test-password",
      newPassword: "a-long-test-password",
      confirmPassword: "a-long-test-password",
    });
    expect(result.success).toBe(false);
  });
});

describe("safeRedirectPath (prevents open redirects)", () => {
  it.each([
    ["/videos", "/videos"],
    ["/settings/system?tab=1", "/settings/system?tab=1"],
    ["https://evil.example", "/dashboard"],
    ["//evil.example", "/dashboard"],
    ["/\\evil.example", "/dashboard"],
    ["/login", "/dashboard"],
    ["/api/health", "/dashboard"],
    [null, "/dashboard"],
    ["", "/dashboard"],
  ])("%s → %s", (input, expected) => {
    expect(safeRedirectPath(input)).toBe(expected);
  });
});
