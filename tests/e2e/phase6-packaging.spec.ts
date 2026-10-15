import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { E2E_MEDIA, media, signIn } from "./helpers";

/**
 * Phase 6 acceptance tests (TESTING.md §3.6): generate packaging with a fake AI server (test-only, behind the
 * OpenAI-compatible provider) → pick and edit → save → copy → regenerate with notes keeps the old version →
 * thumbnails from a real frame and from an upload → missing credentials explained → packaging for a Short.
 */
test.describe.configure({ mode: "serial" });

const TALK = media("Packaging Talk.mp4");
const IMAGE = path.join(E2E_MEDIA, "my-thumbnail.png");
test.skip(!fs.existsSync(media("Editing Talk.mp4")), "The speech sample is generated with the Windows speech engine");

let page: Page;
let videoUrl = "";

test.beforeAll(async ({ browser }) => {
  if (!fs.existsSync(TALK)) fs.copyFileSync(media("Editing Talk.mp4"), TALK);
  if (!fs.existsSync(IMAGE)) {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=orange:s=1600x900",
      "-frames:v",
      "1",
      IMAGE,
    ]);
  }
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.context().close();
});

async function chooseProvider(label: RegExp) {
  await page.goto("/settings/ai");
  await page.getByLabel(label).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
}

const versions = () => page.getByRole("tablist", { name: "Packaging versions" }).getByRole("tab");

test("packaging is written from the transcript with a configured AI (PKG-01)", async () => {
  test.setTimeout(300_000);
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(TALK);
  const card = page.getByTestId("video-card").filter({ hasText: "Packaging Talk" });
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 90_000 });
  videoUrl = (await card.getAttribute("href"))!;
  await page.goto(`${videoUrl}?tab=transcript`);
  await expect(page.getByRole("list", { name: "Transcript" })).toBeVisible({ timeout: 180_000 });

  await chooseProvider(/OpenAI-compatible/);
  await page.goto(videoUrl);
  await page.getByRole("link", { name: "Packaging", exact: true }).click();
  await expect(page).toHaveURL(/\/packaging\/video\//, { timeout: 90_000 });
  await expect(page.getByTestId("packaging-provider")).toContainText("e2e-fake-model");

  await page.getByLabel("Notes for this version (optional)").fill("Audience: beginners");
  await page.getByRole("button", { name: "Write packaging" }).click();
  const set = page.getByTestId("packaging-set");
  await expect(set).toBeVisible({ timeout: 120_000 });
  await expect(set.getByLabel("Title 1", { exact: true })).toHaveValue(/^Fake title 1: /);
  for (const n of [2, 3, 4, 5]) await expect(set.getByLabel(`Title ${n}`, { exact: true })).toBeVisible();
  await expect(set.getByRole("textbox", { name: "Description" })).toHaveValue(/fake description/i);
  await expect(set.getByLabel("Hook 3", { exact: true })).toBeVisible();
  await expect(set.getByRole("list", { name: "Thumbnail concepts" }).getByRole("listitem")).toHaveCount(3);
  // Unrelated hashtags are left out, and the page says so.
  await expect(set.getByText(/Left out hashtags unrelated to the transcript: #UnrelatedCryptoTag/)).toBeVisible();
  await expect(set.getByRole("group", { name: "Hashtags" }).getByRole("button")).not.toContainText([
    "#UnrelatedCryptoTag",
  ]);
});

test("a title can be picked and edited, the description edited, and it's saved (PKG-02, 05)", async () => {
  const set = page.getByTestId("packaging-set");
  await set.getByRole("radio", { name: "Choose title 3" }).click();
  await set.getByLabel("Title 3", { exact: true }).fill("How transcripts <really> help editing");
  await expect(set.getByText("Edited by you")).toBeVisible();
  await set.getByRole("textbox", { name: "Description" }).fill("My own description.\n\nIt explains the workflow.");
  await set.getByRole("group", { name: "Hashtags" }).getByRole("button").first().click(); // leave one out
  await set.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await expect(set.getByLabel("Title 3", { exact: true })).toHaveValue("How transcripts really help editing"); // < > removed

  await page.reload();
  const reloaded = page.getByTestId("packaging-set");
  await expect(reloaded.getByLabel("Title 3", { exact: true })).toHaveValue("How transcripts really help editing");
  await expect(reloaded.getByRole("radio", { name: "Choose title 3" })).toBeChecked();
  await expect(reloaded.getByRole("textbox", { name: "Description" })).toHaveValue(
    "My own description.\n\nIt explains the workflow.",
  );
});

test("one click copies the chosen title, description and hashtags (PKG-05)", async () => {
  const set = page.getByTestId("packaging-set");
  await set.getByRole("button", { name: "Copy title, description and hashtags" }).click();
  await expect(page.getByText("Title, description and hashtags copied.")).toBeVisible();
  // Windows' clipboard stores line breaks as CR LF.
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(copied).toMatch(
    /^How transcripts really help editing\n\nMy own description\.\n\nIt explains the workflow\.\n\n#/,
  );
  expect(copied).not.toContain("UnrelatedCryptoTag");

  await set.getByRole("button", { name: "Copy title 2" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Fake title 2: /);
});

test("regenerating with notes keeps the earlier version (PKG-04) and one can be chosen", async () => {
  test.setTimeout(180_000);
  await page.getByLabel("Notes for this version (optional)").fill("More playful");
  await page.getByRole("button", { name: "Write a new version" }).click();
  await expect(versions()).toHaveCount(2);
  await expect(versions().first()).not.toContainText("Writing…", { timeout: 120_000 });
  await expect(page.getByTestId("packaging-set")).toContainText("Notes: “More playful”");

  await versions().last().click();
  const old = page.getByTestId("packaging-set");
  await expect(old.getByLabel("Title 3", { exact: true })).toHaveValue("How transcripts really help editing");
  await old.getByRole("button", { name: "Use this packaging" }).click();
  await expect(page.getByText("Saved as your packaging for this video.")).toBeVisible();
  await expect(old.getByText("Your packaging")).toBeVisible();
  await expect(versions().last()).toContainText("yours");

  await page.goto("/packaging");
  await expect(page.getByText("Chosen title: “How transcripts really help editing”")).toBeVisible();
});

test("thumbnails: a mock-up from a real frame and an uploaded image (PKG-06)", async () => {
  test.setTimeout(180_000);
  await page.goto(videoUrl.replace("/videos/", "/packaging/video/"));
  await page.getByRole("button", { name: "Make mock-up" }).first().click(); // from the first concept
  await expect(page.getByLabel("Headline (up to 5 words)")).toHaveValue(/idea 1$/);
  await page.getByRole("button", { name: "Make mock-up" }).last().click(); // in the thumbnail panel
  const cards = page.getByTestId("thumbnail-card");
  await expect(cards.first().locator("img")).toHaveJSProperty("naturalWidth", 1280, { timeout: 90_000 });
  await expect(cards.first()).toContainText("Mock-up: video frame + your text");

  await page.getByTestId("thumbnail-upload").setInputFiles(IMAGE);
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Your image");
  await expect(cards.first().locator("img")).toHaveJSProperty("naturalWidth", 1280, { timeout: 90_000 });
  await cards.first().getByRole("button", { name: "Use this" }).click();
  await expect(cards.first().getByText("Chosen", { exact: true }).first()).toBeVisible();

  const response = await page.request.get((await cards.first().locator("img").getAttribute("src"))!);
  expect(response.headers()["content-type"]).toBe("image/jpeg");
  expect((await response.body()).length).toBeLessThan(2 * 1024 * 1024);
});

test("missing credentials are explained and nothing is generated", async () => {
  await chooseProvider(/Google Gemini API/);
  await page.goto(videoUrl.replace("/videos/", "/packaging/video/"));
  await expect(page.getByText("Google Gemini API isn't ready: No API key.")).toBeVisible();
  await expect(page.getByText(/aistudio\.google\.com/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Write a new version" })).toBeDisabled();
  await chooseProvider(/OpenAI-compatible/);
});

test("a Short gets its own packaging from the Shorts Editor, with #Shorts", async () => {
  test.setTimeout(300_000);
  await page.goto(`${videoUrl}?tab=transcript`);
  await page.getByRole("button", { name: "Make a clip" }).click();
  const lines = page.getByRole("list", { name: "Transcript" }).getByRole("button");
  await lines.nth(1).click();
  await lines.nth(2).click();
  await page.getByRole("button", { name: "Create clip" }).click();
  const clip = page.getByTestId("clip-card").filter({ hasText: "Chosen by you" });
  await clip.getByRole("button", { name: "Accept" }).click();
  await page
    .getByRole("tablist", { name: "Filter clips" })
    .getByRole("tab", { name: /^Accepted/ })
    .click();
  await clip.getByRole("button", { name: "Create Short" }).click();
  await expect(page).toHaveURL(/\/shorts\/[^/]+$/, { timeout: 90_000 });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Write packaging" }).click();
  await expect(page).toHaveURL(/\/packaging\/short\//, { timeout: 90_000 });
  await expect(page.getByText(/Written from|the Short's captions/).first()).toBeVisible();
  await page.getByRole("button", { name: "Write packaging" }).click();
  const set = page.getByTestId("packaging-set");
  await expect(set).toBeVisible({ timeout: 120_000 });
  await expect(set.getByRole("group", { name: "Hashtags" })).toContainText("#Shorts");
  await expect(page.getByText(/720 × 1280/)).toBeVisible();
});
