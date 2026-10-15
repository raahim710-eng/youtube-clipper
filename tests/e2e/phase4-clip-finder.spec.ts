import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { media, signIn } from "./helpers";

/**
 * Phase 4 acceptance tests (TESTING.md §3.4): real speech, real local transcription (faster-whisper),
 * clip suggestions, review and hand-over to the Shorts Editor. The AI step with a real local model is
 * slow on CPUs, so it only runs with E2E_REAL_AI=1; everything else runs every time.
 */
test.describe.configure({ mode: "serial" });

const TALK = media("Editing Talk.mp4");
test.skip(!fs.existsSync(TALK), "The speech sample is generated with the Windows speech engine");

let page: Page;
let videoUrl = "";

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

const clipCards = () => page.getByTestId("clip-card");
const tab = (name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

test("a new upload is transcribed automatically with word timings", async () => {
  test.setTimeout(240_000);
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(TALK);
  const card = page.getByTestId("video-card").filter({ hasText: "Editing Talk" });
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 90_000 });
  videoUrl = (await card.getAttribute("href"))!;

  await page.goto(`${videoUrl}?tab=transcript`);
  const transcript = page.getByRole("list", { name: "Transcript" });
  await expect(transcript).toBeVisible({ timeout: 180_000 });
  await expect(transcript).toContainText(/transcript/i);
  await expect(page.getByText(/transcribed locally with faster-whisper \(tiny\)/)).toBeVisible();
});

test("the transcript is searchable and clicking a line seeks the player", async () => {
  await page.getByLabel("Search the transcript").fill("three seconds");
  const line = page.getByRole("list", { name: "Transcript" }).getByRole("button").first();
  await expect(line).toContainText(/three seconds/i);
  await line.click();
  const time = await page.locator("main video").evaluate((video: HTMLVideoElement) => video.currentTime);
  expect(time).toBeGreaterThan(30);
  await page.getByLabel("Search the transcript").fill("");
});

test("missing credentials are explained instead of faking AI results", async () => {
  await page.goto("/settings/ai");
  await page.getByLabel(/Google Gemini API/).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();

  await page.goto(`${videoUrl}?tab=clips`);
  await expect(page.getByText("Google Gemini API isn't ready: No API key.")).toBeVisible();
  await expect(page.getByText(/aistudio\.google\.com/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Find clips.*with AI/ })).toBeDisabled();

  await page.goto("/settings/ai");
  await page.getByLabel(/Ollama \(local AI\)/).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

test("speech-pattern ranking suggests real moments and says no AI was used", async () => {
  test.setTimeout(120_000);
  await page.goto(`${videoUrl}?tab=clips`);
  await page.getByRole("button", { name: "Speech patterns only (no AI)" }).click();
  await expect(clipCards().first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/ranked by speech patterns only — no AI was used/)).toBeVisible();
  const count = await clipCards().count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < count; i += 1) {
    await expect(clipCards().nth(i)).toContainText("Speech patterns (no AI)");
    await expect(clipCards().nth(i)).not.toContainText("AI ·");
  }
});

test("preview plays exactly the suggested section", async () => {
  const card = clipCards().first();
  const range = (await card.locator("p.font-mono").textContent())!;
  const start = range.split("–")[0]!.trim();
  const [m, s] = start.split(":");
  const startSeconds = Number(m) * 60 + Number(s);

  await card.getByRole("button", { name: "Preview" }).click();
  await page.waitForTimeout(1500);
  const state = await page
    .locator("main video")
    .evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused }));
  expect(state.paused).toBe(false);
  expect(state.t).toBeGreaterThanOrEqual(startSeconds);
  expect(state.t).toBeLessThan(startSeconds + 3);
  await card.getByRole("button", { name: "Stop preview" }).click();
});

test("adjusting the timing snaps to whole words", async () => {
  const card = clipCards().first();
  const before = await card.locator("p.font-mono").textContent();
  await card.getByRole("button", { name: "Adjust timing" }).click();
  await card.getByRole("button", { name: "end 0.5 s later" }).click();
  await card.getByRole("button", { name: "end 0.5 s later" }).click();
  await card.getByRole("button", { name: "end 0.5 s later" }).click();
  await card.getByRole("button", { name: "end 0.5 s later" }).click();
  await card.getByRole("button", { name: "Save timing" }).click();
  await expect(page.getByText("Saved — adjusted to whole words.")).toBeVisible();
  await expect(clipCards().first().locator("p.font-mono")).not.toHaveText(before!);
});

test("accepted clips reach the Shorts Editor queue; rejected ones move aside", async () => {
  const title = (await clipCards().first().locator("p.font-medium span").first().textContent())!;
  await clipCards().first().getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText("Accepted — sent to the Shorts Editor queue.")).toBeVisible();
  await clipCards().first().getByRole("button", { name: "Reject" }).click();
  await tab("Rejected").click();
  await expect(clipCards()).toHaveCount(1);

  await page.goto("/shorts");
  const queue = page.getByRole("list", { name: "Clips ready for editing" });
  await expect(queue).toContainText(title.trim());
  await expect(queue).toContainText("Editing Talk");
});

test("a clip can be picked by hand from the transcript", async () => {
  await page.goto(`${videoUrl}?tab=transcript`);
  await page.getByRole("button", { name: "Make a clip" }).click();
  const lines = page.getByRole("list", { name: "Transcript" }).getByRole("button");
  await lines.nth(1).click();
  await lines.nth(2).click();
  await page.getByRole("button", { name: "Create clip" }).click();
  await expect(page.getByText("Clip added. Review it in the Clips tab.")).toBeVisible();
  await expect(page).toHaveURL(/tab=clips/);
  await expect(clipCards().filter({ hasText: "Chosen by you" })).toHaveCount(1);
});

test("real local AI rates the moments and names the model", async () => {
  test.skip(process.env.E2E_REAL_AI !== "1", "Set E2E_REAL_AI=1 to run the slow real-AI check");
  test.setTimeout(900_000);
  await page.goto(`${videoUrl}?tab=clips`);
  await page.getByRole("button", { name: /Find clips.*with AI/ }).click();
  await expect(page.getByText(/Last suggestions were rated by AI/)).toBeVisible({ timeout: 840_000 });
  await expect(clipCards().filter({ hasText: /AI · / }).first()).toBeVisible();
});
