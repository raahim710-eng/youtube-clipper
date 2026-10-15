import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { formatTimecode, parseTimecode } from "../../src/lib/time";
import { signIn } from "./helpers";

/**
 * Opt-in check with a real recording (TESTING.md §3.5 manual checks): face tracking on a real face,
 * a 60-second export timed against NFR-PERF-03, and preview vs export frames at three moments
 * (SHORT-06). Run with E2E_REAL_VIDEO=<path to an mp4 with a person talking>; outputs go to
 * test-results/.../phase5-real.
 */
const VIDEO = process.env.E2E_REAL_VIDEO ?? "";
test.skip(!VIDEO || !fs.existsSync(VIDEO), "Set E2E_REAL_VIDEO to a real talking-head video to run this check");

test("real video: auto framing, 60 s export, preview matches export", async ({ page }) => {
  test.setTimeout(1_800_000);
  const out = path.join(test.info().outputDir, "phase5-real");
  fs.mkdirSync(out, { recursive: true });
  const title = path.parse(VIDEO).name;

  await signIn(page);
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(VIDEO);
  const card = page.getByTestId("video-card").filter({ hasText: title });
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 300_000 });
  const videoUrl = (await card.getAttribute("href"))!;

  await page.goto(`${videoUrl}?tab=transcript`);
  await expect(page.getByRole("list", { name: "Transcript" })).toBeVisible({ timeout: 900_000 });
  await page.getByRole("button", { name: "Make a clip" }).click();
  const lines = page.getByRole("list", { name: "Transcript" }).getByRole("button");
  await lines.nth(2).click();
  await lines.nth(5).click();
  await page.getByRole("button", { name: "Create clip" }).click();
  const clip = page.getByTestId("clip-card").filter({ hasText: "Chosen by you" });
  await clip.getByRole("button", { name: "Accept" }).click();
  await page
    .getByRole("tablist", { name: "Filter clips" })
    .getByRole("tab", { name: /^Accepted/ })
    .click();
  await clip.getByRole("button", { name: "Create Short" }).click();
  await expect(page).toHaveURL(/\/shorts\/[^/]+$/, { timeout: 90_000 }); // the first dev-mode compile is slow

  // Make it exactly 60 s long (the end snaps out of a word, so it may grow slightly).
  const start = parseTimecode(await page.getByLabel("Start time").inputValue())!;
  await page.getByLabel("End time").fill(formatTimecode(start + 60_000));
  await page.getByLabel("End time").press("Enter");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 15_000 });

  await page.getByRole("tab", { name: "Framing" }).click();
  await expect(page.getByTestId("auto-framing-ready")).toBeVisible({ timeout: 300_000 });

  // Preview screenshots at three moments of the Short.
  const moments = [1_500, 20_000, 45_000];
  for (const [index, offset] of moments.entries()) {
    await page.locator("[data-testid=short-preview] video").evaluate(
      async (video: HTMLVideoElement, seconds) => {
        video.currentTime = seconds;
        await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
      },
      (start + offset) / 1000,
    );
    await page.waitForTimeout(500);
    await page.getByTestId("short-preview").screenshot({ path: path.join(out, `preview-${index + 1}.png`) });
  }

  await page.getByRole("tab", { name: "Export" }).click();
  const started = Date.now();
  await page.getByTestId("export-button").click();
  await expect(page.getByTestId("export-result")).toBeVisible({ timeout: 1_200_000 });
  const wallClockMs = Date.now() - started;
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("download-short").click()]);
  const file = path.join(out, "short.mp4");
  await download.saveAs(file);

  for (const [index, offset] of moments.entries()) {
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-ss", String(offset / 1000), "-i", file, "-frames:v", "1",
      path.join(out, `export-${index + 1}.png`),
    ]); // prettier-ignore
  }
  const duration = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }),
  );
  const summary = { start, wallClockMs, duration, resultText: await page.getByTestId("export-result").innerText() };
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("Phase 5 real-video export:", summary);
  expect(duration).toBeGreaterThan(59);
});
