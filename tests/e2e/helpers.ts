import path from "node:path";
import { expect, type Page } from "@playwright/test";

/** Test-only owner account for the throwaway E2E database. */
export const OWNER = { name: "E2E Owner", email: "e2e-owner@example.test", password: "e2e-test-password-only" };

export const E2E_MEDIA = path.join(__dirname, "..", "..", "data", "e2e-media");
export const media = (name: string) => path.join(E2E_MEDIA, name);

/** Signs in, creating the owner first if this spec runs on its own. */
export async function signIn(page: Page) {
  await page.goto("/login");
  // On a fresh database /login sends you to /setup; wait for whichever form actually appears.
  const submit = page.getByRole("button", { name: /^(Create owner account|Sign in)$/ });
  await expect(submit.or(page.getByRole("heading", { name: "Dashboard" })).first()).toBeVisible({ timeout: 60_000 });
  // Typing before React has hydrated would submit the form natively (a GET with the fields in the URL).
  await page.waitForLoadState("networkidle");
  if (await page.getByRole("button", { name: "Create owner account" }).isVisible()) {
    await page.getByLabel("Your name").fill(OWNER.name);
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
    await page.getByLabel("Confirm password").fill(OWNER.password);
    await page.getByRole("button", { name: "Create owner account" }).click();
  } else if (await page.getByRole("button", { name: "Sign in" }).isVisible()) {
    await page.getByLabel("Email").fill(OWNER.email);
    await page.getByLabel("Password").fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 90_000 }); // the first dev-mode compile can be slow
}
