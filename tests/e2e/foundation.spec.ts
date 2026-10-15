import { expect, type Page, test } from "@playwright/test";

/**
 * Phase 2 acceptance tests (TESTING.md §3.1). They run in order against a fresh database:
 * first-run setup → navigation → theme → logout/protection → login.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "E2E Owner", email: "e2e-owner@example.test", password: "e2e-test-password-only" };

const NAV_PAGES = [{ link: "Analytics", heading: "Analytics", phase: 8 }];

async function signIn(page: Page, password = OWNER.password) {
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("signed-out visitors are sent to first-run setup", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/setup$/, { timeout: 60_000 }); // the first dev-mode compile can be slow
  await expect(page.getByRole("heading", { name: "Create your owner account" })).toBeVisible();
});

test("setup validates input before creating anything", async ({ page }) => {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page.getByText("Enter your name.")).toBeVisible();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();

  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill("something-else-entirely");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page.getByText("Passwords don't match.")).toBeVisible();
});

test("creating the owner signs in and opens the dashboard", async ({ page }) => {
  await page.goto("/setup");
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create owner account" }).click();

  // The dev server compiles the dashboard on its first visit, which takes a while on slow PCs.
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Welcome back, E2E" })).toBeVisible();
  await expect(page.getByText("Get started")).toBeVisible();
  await expect(page.getByText("No background jobs")).toBeVisible();
});

test("setup is closed once the owner exists", async ({ page, request }) => {
  await page.goto("/setup");
  await expect(page).not.toHaveURL(/\/setup$/);

  const response = await request.post("/api/auth/sign-up/email", {
    data: { name: "Intruder", email: "intruder@example.test", password: "another-long-password" },
    headers: { origin: "http://localhost:3200" },
  });
  expect(response.status()).toBe(403);
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    if (page.url().includes("/login")) {
      await signIn(page);
      await expect(page).toHaveURL(/\/dashboard$/);
    }
  });

  test("every navigation item opens a working, clearly labelled page", async ({ page }) => {
    await page.getByRole("link", { name: "Videos", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Videos" })).toBeVisible();
    await expect(page.getByText("Drag videos here, or choose files")).toBeVisible();
    await page.getByRole("link", { name: "AI Clip Finder", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "AI Clip Finder" })).toBeVisible();
    await page.getByRole("link", { name: "Shorts Editor", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Shorts Editor" })).toBeVisible();
    await expect(page.getByText(/Clips ready for editing/)).toBeVisible();
    await page.getByRole("link", { name: "AI Packaging", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "AI Packaging" })).toBeVisible();
    await expect(page.getByText("Nothing to package yet")).toBeVisible();
    await page.getByRole("link", { name: "YouTube", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "YouTube" })).toBeVisible();
    await expect(page.getByText("Today's YouTube quota")).toBeVisible();
    for (const item of NAV_PAGES) {
      await page.getByRole("link", { name: item.link, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: item.heading })).toBeVisible();
      await expect(page.getByText(`Not built yet — planned for Phase ${item.phase}`)).toBeVisible();
    }
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await page.getByRole("link", { name: "System status" }).click();
    await expect(page.getByText("Database (SQLite)")).toBeVisible();
    await expect(page.getByText("Connected and up to date.")).toBeVisible();

    // Theme choice persists after reload. (Kept in this test to stay under the 5 sign-ins/minute limit.)
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("logging out protects pages and returns to them after signing in", async ({ page }) => {
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/videos");
    await expect(page).toHaveURL(/\/login\?next=%2Fvideos$/);

    await signIn(page, "wrong-password-here");
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();

    await signIn(page);
    await expect(page).toHaveURL(/\/videos$/);
  });
});

test("API reveals no details without a session", async ({ request }) => {
  const response = await request.get("/api/health", { headers: { cookie: "" } });
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["checkedAt", "ok"]);
});
