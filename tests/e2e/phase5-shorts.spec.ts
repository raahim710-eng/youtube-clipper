import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { media, signIn } from "./helpers";

/**
 * Phase 5 acceptance tests (TESTING.md §3.5): clip → Short → edit a caption → switch framing →
 * export with the real media worker and FFmpeg → download a real MP4 → edits mark it out of date.
 */
test.describe.configure({ mode: "serial" });

const TALK = media("Shorts Talk.mp4");
test.skip(!fs.existsSync(media("Editing Talk.mp4")), "The speech sample is generated with the Windows speech engine");

let page: Page;
let shortUrl = "";

test.beforeAll(async ({ browser }) => {
  if (!fs.existsSync(TALK)) fs.copyFileSync(media("Editing Talk.mp4"), TALK); // own title, separate from Phase 4
  page = await browser.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

const saved = () => expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });

test("an accepted clip becomes a Short with captions from the transcript (SHORT-01, 04)", async () => {
  test.setTimeout(300_000);
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(TALK);
  const card = page.getByTestId("video-card").filter({ hasText: "Shorts Talk" });
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 90_000 });
  const videoUrl = (await card.getAttribute("href"))!;

  await page.goto(`${videoUrl}?tab=transcript`);
  await expect(page.getByRole("list", { name: "Transcript" })).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Make a clip" }).click();
  const lines = page.getByRole("list", { name: "Transcript" }).getByRole("button");
  await lines.nth(1).click();
  await lines.nth(2).click();
  await page.getByRole("button", { name: "Create clip" }).click();
  await expect(page).toHaveURL(/tab=clips/);

  const clip = page.getByTestId("clip-card").filter({ hasText: "Chosen by you" });
  await clip.getByRole("button", { name: "Accept" }).click();
  await page
    .getByRole("tablist", { name: "Filter clips" })
    .getByRole("tab", { name: /^Accepted/ })
    .click();
  await clip.getByRole("button", { name: "Create Short" }).click();
  await expect(page).toHaveURL(/\/shorts\/[^/]+$/, { timeout: 90_000 }); // the first dev-mode compile is slow
  shortUrl = new URL(page.url()).pathname;

  await expect(page.getByTestId("short-preview")).toBeVisible();
  const captions = page.getByRole("list", { name: "Captions" }).getByRole("listitem");
  expect(await captions.count()).toBeGreaterThan(2);
});

test("a caption can be edited and the preview shows it (SHORT-04, 06)", async () => {
  const first = page.getByLabel("Caption 1 text", { exact: true });
  await first.fill("Edited {caption}: ok");
  await saved();
  await page.getByRole("button", { name: "Go to caption 1", exact: true }).click();
  await expect(page.getByTestId("preview-caption")).toHaveText("EDITED {CAPTION}: OK"); // "Bold white" uses capitals

  await page.getByRole("button", { name: "Boxed" }).click();
  await expect(page.getByTestId("preview-caption")).toHaveText("Edited {caption}: ok");
  await saved();
});

test("framing can be switched; auto framing explains when no face is found (SHORT-03)", async () => {
  test.setTimeout(180_000);
  await page.getByRole("tab", { name: "Framing" }).click();
  // The test pattern has no faces: face tracking finishes and says so instead of inventing a subject.
  await expect(page.getByText(/No faces were found/)).toBeVisible({ timeout: 150_000 });

  await page.getByLabel("Manual position").check();
  await expect(page.getByTestId("manual-framing")).toBeVisible();
  await page.getByLabel("Fit with blurred background").check();
  await saved();
});

let exportedBytes = 0;

test("the Short exports to a real 1080×1920 MP4 that can be downloaded (SHORT-05)", async () => {
  test.setTimeout(300_000);
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByText("1080 × 1920 (vertical 9:16)")).toBeVisible();
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-progress")).toBeVisible();
  await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText("Up to date")).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-short").click()]);
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const file = path.join(test.info().outputDir, "short.mp4");
  await download.saveAs(file);
  exportedBytes = fs.statSync(file).size;
  const probe = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], {
      encoding: "utf8",
    }),
  ) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
  const video = probe.streams.find((s) => s.codec_type === "video");
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  expect(video).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
  expect(audio).toMatchObject({ codec_name: "aac" });
});

test("editing after the export marks it out of date (SHORT-07)", async () => {
  expect(exportedBytes).toBeGreaterThan(10_000);
  await page.getByRole("tab", { name: "Captions" }).click();
  await page.getByLabel("Caption 2 text", { exact: true }).fill("Changed after export");
  await saved();
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByTestId("export-stale")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export again" })).toBeEnabled();

  await page.goto("/shorts");
  await expect(page.getByRole("list", { name: "Your Shorts" }).getByText("Out of date")).toBeVisible();
  await page.goto(shortUrl);
  await expect(page.getByLabel("Caption 2 text", { exact: true })).toHaveValue("Changed after export");
});
