import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { media, signIn } from "./helpers";

/**
 * Phase 9 acceptance test (TESTING.md §3.9): brief → script (fake AI server, test-only) → edit → approve →
 * real narration with Windows' built-in voices → footage from the library and an uploaded clip (swap) →
 * a still picture is refused → real FFmpeg render → the video is in the library with its credits.
 * No stock provider key is configured in tests, so the missing-key guidance is checked too (GEN-08).
 */
test.describe.configure({ mode: "serial" });
test.skip(process.platform !== "win32", "Narration uses Windows' built-in voices");

const FOOTAGE = media("Generator Footage.mp4");
const STILL = media("Still Picture.mp4");
let page: Page;
let projectUrl = "";

test.beforeAll(async ({ browser }) => {
  if (!fs.existsSync(FOOTAGE)) fs.copyFileSync(media("Interview Sample.mp4"), FOOTAGE);
  if (!fs.existsSync(STILL)) {
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=steelblue:s=640x360:d=3:r=25"];
    execFileSync("ffmpeg", [...args, "-c:v", "libx264", "-pix_fmt", "yuv420p", STILL]);
  }
  page = await (await browser.newContext()).newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.context().close();
});

const scene = (n: number) => page.getByTestId("scene-card").nth(n - 1);

test("the generator explains its providers and the missing stock key (GEN-08)", async () => {
  await page.goto("/settings/ai");
  await page.getByLabel(/OpenAI-compatible/).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  await page.goto("/generator");
  const info = page.getByTestId("provider-info");
  await expect(info).toContainText("e2e-fake-model");
  await expect(info).toContainText("Windows voices");
  await expect(info.getByTestId("stock-missing")).toContainText("pexels.com/api");
  await expect(info).toContainText("Costs: none.");
});

test("brief → edited script → narration → footage → render → library (GEN-01…06)", async () => {
  test.setTimeout(900_000);
  // Footage from the creator's own library.
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(FOOTAGE);
  await expect(page.getByTestId("video-card").filter({ hasText: "Generator Footage" }).getByText("Ready")).toBeVisible({
    timeout: 120_000,
  });

  await page.goto("/generator");
  await page.getByLabel("Topic").fill("Why the ocean is salty");
  await page.getByLabel("Length").click();
  await page.getByRole("option", { name: "30 seconds" }).click();
  await page.getByRole("radio", { name: "720p" }).click();
  await page.getByTestId("brief-submit").click();
  await expect(page).toHaveURL(/\/generator\/[^/]+$/, { timeout: 60_000 });
  projectUrl = new URL(page.url()).pathname;

  // GEN-02: the script must be reviewed; edit a scene and approve.
  const editor = page.getByTestId("script-editor");
  await expect(editor).toBeVisible({ timeout: 120_000 });
  await expect(editor).toContainText("Check the facts before you continue");
  await expect(page.getByTestId("script-scene")).toHaveCount(3);
  await page.getByLabel("Title", { exact: true }).fill("Why is the sea salty?");
  await page
    .getByTestId("script-scene")
    .first()
    .getByLabel("Narration")
    .fill("Rain falls on mountains and wears down the rocks. Tiny bits of minerals wash away with every storm.");
  await page.getByTestId("approve-script").click();
  await expect(page.getByText(/No stock video provider is set up/).first()).toBeVisible();

  // GEN-03: real narration with the Windows voice.
  await expect(page.getByTestId("scene-counts")).toContainText("3 of 3 narrated", { timeout: 180_000 });
  await expect(scene(1).locator("audio")).toHaveCount(1);
  await expect(page.getByTestId("stock-guidance")).toBeVisible();

  // GEN-04: library footage for scenes 1 and 3, an uploaded clip for scene 2, then a swap.
  for (const n of [1, 3]) {
    await scene(n).getByRole("button", { name: "Use a library video" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Generator Footage/ })
      .click();
    await page.getByTestId("use-library-video").click();
    await expect(scene(n).getByTestId("scene-footage-label")).toContainText("From your library: Generator Footage");
  }
  await scene(2).getByTestId("scene-clip-input").setInputFiles(media("Phone Clip.mov"));
  await expect(scene(2).getByTestId("scene-footage-label")).toContainText("Your uploaded clip", { timeout: 60_000 });

  // A still picture is not footage: the render refuses it and names the scene.
  await scene(3).getByTestId("scene-clip-input").setInputFiles(STILL);
  await expect(scene(3).getByTestId("scene-footage-label")).toContainText("Your uploaded clip", { timeout: 60_000 });
  await page.getByRole("tab", { name: "4. Render" }).click();
  await page.getByTestId("render-button").click();
  await expect(page.getByTestId("project-error")).toContainText("scene 3: the footage doesn't move", {
    timeout: 120_000,
  });

  // Swap scene 3 back to library footage and render for real.
  await page.getByRole("tab", { name: "3. Voice & footage" }).click();
  await scene(3).getByRole("button", { name: "Use a library video" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Generator Footage/ })
    .click();
  await page.getByLabel("Start at (seconds)").fill("4");
  await page.getByTestId("use-library-video").click();
  await expect(scene(3).getByTestId("scene-footage-label")).toContainText("From your library");
  await page.getByRole("tab", { name: "4. Render" }).click();
  await expect(page.getByTestId("render-blocked")).toHaveCount(0);
  await page.getByTestId("render-button").click();
  await expect(page.getByTestId("generator-job")).toBeVisible();

  // GEN-05/06: the finished MP4, its credits and the library entry.
  const result = page.getByTestId("render-result");
  await expect(result).toBeVisible({ timeout: 600_000 });
  await expect(page.getByTestId("project-error")).toHaveCount(0);
  await expect(page.getByTestId("credits-text")).toContainText("Some footage is the creator's own.");
  await expect(page.getByTestId("credits-text")).toContainText("Narration: synthetic voice");
  const download = page.getByTestId("download-generated");
  await expect(download).toHaveAttribute("href", /\/api\/media\/videos\/.+\/source\?download=1$/);
  const response = await page.request.get((await download.getAttribute("href"))!);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("video/mp4");
  expect(Number(response.headers()["content-length"])).toBeGreaterThan(50_000);

  await page.goto("/videos");
  const card = page.getByTestId("video-card").filter({ hasText: "Why is the sea salty?" });
  await expect(card.getByTestId("generated-badge")).toBeVisible();
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 120_000 });
  await card.click();
  await page.getByRole("tab", { name: /Details/ }).click();
  await expect(page.getByTestId("video-credits")).toContainText("Narration: synthetic voice");
});

test("the project keeps its video when deleted", async () => {
  await page.goto(projectUrl);
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page).toHaveURL(/\/generator$/, { timeout: 30_000 });
  await page.goto("/videos");
  await expect(page.getByTestId("video-card").filter({ hasText: "Why is the sea salty?" })).toBeVisible();
});
