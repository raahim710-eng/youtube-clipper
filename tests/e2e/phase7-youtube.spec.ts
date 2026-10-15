import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { media, signIn } from "./helpers";

/**
 * Phase 7 acceptance tests (TESTING.md §3.7) against a test-only Google stand-in
 * (tests/support/fake-google.mjs): connect through the OAuth redirect → publish a video with the
 * required answers → progress → "Open on YouTube" → resume after a dropped connection → API error
 * with retry guidance → expired sign-in → reconnect → disconnect revokes access.
 * This does NOT prove that real YouTube publishing works; see the manual test in TESTING.md.
 */
test.describe.configure({ mode: "serial" });

const GOOGLE = "http://127.0.0.1:3297"; // FAKE_GOOGLE_PORT in playwright.config.ts
const TALK = media("Publish Talk.mp4");
test.skip(!fs.existsSync(media("Editing Talk.mp4")), "The speech sample is generated with the Windows speech engine");

let page: Page;
let videoUrl = "";

async function google(control: Record<string, unknown>) {
  const response = await page.request.post(`${GOOGLE}/__control`, { data: control });
  expect(response.ok()).toBe(true);
}
async function googleState() {
  return (await (await page.request.get(`${GOOGLE}/__state`)).json()) as {
    videos: { id: string; snippet: Record<string, unknown>; status: Record<string, unknown> }[];
    revoked: string[];
    chunksSeen: number;
  };
}

test.beforeAll(async ({ browser }) => {
  if (!fs.existsSync(TALK)) fs.copyFileSync(media("Editing Talk.mp4"), TALK);
  page = await browser.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

const rows = () => page.getByTestId("publication-row");

async function publish(title: string) {
  await page.goto(videoUrl);
  await page.getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(/\/youtube\/publish\/video\//, { timeout: 90_000 });
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("No, it's not made for kids").check();
  await page.getByRole("radiogroup", { name: "Altered or synthetic content" }).getByLabel("No").check();
  await page.getByTestId("publish-button").click();
  await expect(page).toHaveURL(/\/youtube\?publication=/, { timeout: 90_000 });
}

test("a channel is connected through Google's sign-in (YT-01)", async () => {
  test.setTimeout(180_000);
  await page.goto("/settings/channels");
  await expect(page.getByText("Test mode")).toBeVisible({ timeout: 60_000 }); // the stand-in is in use, and says so
  await page.getByRole("link", { name: "Connect a YouTube channel" }).click();
  await expect(page).toHaveURL(/\/settings\/channels\?connected=1/, { timeout: 60_000 });
  await expect(page.getByText("Channel connected")).toBeVisible();
  const row = page.getByTestId("channel-row");
  await expect(row).toContainText("Test Channel");
  await expect(row).toContainText("@testchannel");
  await expect(row).toContainText("See your channel, Upload videos");
  await expect(row.getByText("Connected", { exact: true })).toBeVisible();
});

test("a video is uploaded privately with the required answers, with progress and a link (YT-04, 06, 08)", async () => {
  test.setTimeout(240_000);
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(TALK);
  const card = page.getByTestId("video-card").filter({ hasText: "Publish Talk" });
  await expect(card.getByText("Ready")).toBeVisible({ timeout: 90_000 });
  videoUrl = (await card.getAttribute("href"))!;

  await page.goto(videoUrl);
  await page.getByRole("link", { name: "Publish", exact: true }).click();
  await expect(page).toHaveURL(/\/youtube\/publish\/video\//, { timeout: 90_000 });
  // Not audited: only private, no scheduling, and the page says why.
  await expect(page.getByLabel("Public")).toBeDisabled();
  await expect(page.getByLabel("Schedule (private until then)")).toBeDisabled();
  await expect(page.getByText(/Uploads are private until your Google Cloud project passes/)).toBeVisible();
  // Required answers first.
  await expect(page.getByTestId("publish-button")).toBeDisabled();
  await expect(page.getByText("Answer whether the video is made for kids (YouTube requires it).")).toBeVisible();
  await page.getByLabel("Title").fill("Editing with transcripts <test>");
  await expect(page.getByText(/Remove < and >/)).toBeVisible();
  await page.getByLabel("Title").fill("Editing with transcripts");
  await page.getByLabel("Tags (comma-separated)").fill("editing, video tips");
  await page.getByLabel("No, it's not made for kids").check();
  await page.getByRole("radiogroup", { name: "Altered or synthetic content" }).getByLabel("No").check();
  await page.getByTestId("publish-button").click();

  await expect(page).toHaveURL(/\/youtube\?publication=/, { timeout: 90_000 });
  const row = rows().first();
  await expect(row.getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(row.getByRole("link", { name: /Open on YouTube/ })).toHaveAttribute(
    "href",
    /youtube\.com\/watch\?v=vid_/,
  );
  await expect(row).toContainText("YouTube reports it as private.");
  const state = await googleState();
  expect(state.videos[0].snippet).toMatchObject({ title: "Editing with transcripts", tags: ["editing", "video tips"] });
  expect(state.videos[0].status).toMatchObject({
    privacyStatus: "private",
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: false,
  });
  await expect(page.getByText(/Uploads: 1 of 100/)).toBeVisible();
});

test("an upload survives a dropped connection (YT-06)", async () => {
  test.setTimeout(180_000);
  await google({ dropAfterChunks: 3, chunksSeen: 0 });
  await publish("Resumed upload");
  await expect(rows().first().getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 90_000 });
  expect((await googleState()).videos).toHaveLength(2);
  await google({ dropAfterChunks: 0 });
});

test("a YouTube error is shown with guidance, and Try again works (YT-06)", async () => {
  test.setTimeout(180_000);
  await google({ uploadError: { status: 403, reason: "forbidden" } });
  await publish("Refused upload");
  const row = rows().first();
  await expect(row.getByText("Failed", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(row).toContainText("YouTube refused the request for this channel");
  await expect(row).toContainText(/try again/i);
  await google({ uploadError: null });
  await row.getByRole("button", { name: "Try again" }).click();
  await expect(row.getByText("Uploaded", { exact: true })).toBeVisible({ timeout: 90_000 });
});

test("an expired sign-in asks to reconnect, and reconnecting fixes it (YT-03)", async () => {
  test.setTimeout(240_000);
  await google({ accessTokenLifetime: 30, failRefreshWithInvalidGrant: true });
  // Reconnect so the new (short-lived) token is stored; the next upload must refresh it and fails.
  await page.goto("/settings/channels");
  await page.getByRole("link", { name: "Connect another channel" }).click();
  await expect(page).toHaveURL(/connected=1/, { timeout: 60_000 });
  await publish("Needs reconnecting");
  const row = rows().first();
  await expect(row.getByText("Failed", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(row.getByRole("link", { name: "Settings › Channels" })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Test Channel needs reconnecting/)).toBeVisible();

  await google({ accessTokenLifetime: 3600, failRefreshWithInvalidGrant: false });
  await page.goto("/settings/channels");
  await expect(page.getByText("Needs reconnecting")).toBeVisible();
  await page.getByRole("link", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(/connected=1/, { timeout: 60_000 });
  await expect(page.getByTestId("channel-row").getByText("Connected", { exact: true })).toBeVisible();
});

test("disconnecting revokes access at Google and removes the channel (YT-02)", async () => {
  await page.goto("/settings/channels");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Disconnected. Access was revoked at Google.")).toBeVisible();
  await expect(page.getByText("No channels connected.")).toBeVisible();
  expect((await googleState()).revoked.length).toBeGreaterThan(0);
  await page.goto("/dashboard");
  await expect(page.getByRole("list", { name: "Uploads and scheduled videos" })).toContainText(
    "Editing with transcripts",
  );
});
