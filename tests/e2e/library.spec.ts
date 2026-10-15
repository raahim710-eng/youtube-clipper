import { expect, type Page, test } from "@playwright/test";
import { media, signIn } from "./helpers";

/**
 * Phase 3 acceptance tests (TESTING.md §3.2–3.3): real uploads of FFmpeg-generated videos,
 * processed by the real Python media worker.
 */
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  // One shared, signed-in page keeps us under the 5 sign-ins/minute limit.
  page = await browser.newPage();
  await signIn(page);
});

test.afterAll(async () => {
  await page.close();
});

const card = (title: string) => page.getByTestId("video-card").filter({ hasText: title });

test("uploads a real video, processes it and shows it in the library", async () => {
  await page.goto("/videos");
  await expect(page.getByText("Your library is empty")).toBeVisible();

  await page.getByTestId("video-file-input").setInputFiles(media("Interview Sample.mp4"));
  const row = page.getByTestId("upload-row").filter({ hasText: "Interview Sample.mp4" });
  await expect(row.getByText("Uploaded — processing in the background")).toBeVisible({ timeout: 60_000 });

  await expect(card("Interview Sample").getByText("Ready")).toBeVisible({ timeout: 60_000 });
  await expect(card("Interview Sample").getByText("0:10")).toBeVisible();
  // The first media request compiles the route in dev mode, which can take a while on a slow PC.
  await expect(card("Interview Sample").locator("img")).toHaveJSProperty("naturalWidth", 640, { timeout: 60_000 });
});

test("the detail page plays the video and shows its details", async () => {
  await card("Interview Sample").click();
  // First visit compiles this page in dev mode — slow on a 2-core PC while transcription runs.
  await expect(page.getByRole("heading", { level: 1, name: "Interview Sample" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByText("1920 × 1080")).toBeVisible();
  await expect(page.getByText("h264")).toBeVisible();

  const canPlay = await page.locator("main video").evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return video.currentTime > 0 && video.videoWidth === 1920;
  });
  expect(canPlay).toBe(true);
});

test("an HEVC .mov gets a browser-friendly preview", async () => {
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles(media("Phone Clip.mov"));
  await expect(card("Phone Clip").getByText("Ready")).toBeVisible({ timeout: 90_000 });
  await card("Phone Clip").click();
  await page.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByText("Created (original isn't browser-friendly)")).toBeVisible();
  await expect(page.getByText("hevc")).toBeVisible();
  const decodes = await page.locator("main video").evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return video.videoWidth > 0 && !video.error;
  });
  expect(decodes).toBe(true);
});

test("rejects unsupported and fake files with clear messages", async () => {
  await page.goto("/videos");
  await page.getByTestId("video-file-input").setInputFiles([media("notes.txt"), media("Not A Video.mp4")]);
  await expect(page.getByText("“notes.txt” isn't a supported video format")).toBeVisible();
  await expect(page.getByText("“Not A Video.mp4” doesn't look like a real MP4 video")).toBeVisible({ timeout: 30_000 });
  await expect(card("Not A Video")).toHaveCount(0);
});

test("resumes an interrupted upload from where it stopped", async () => {
  await page.goto("/videos");
  // Simulate the connection dropping after the first 10 MB chunk: every attempt to send chunk 1 fails.
  await page.route("**/api/uploads/*/chunks/1", (route) => route.abort("connectionreset"));
  await page.getByTestId("video-file-input").setInputFiles(media("Interview Sample.mp4"));
  const row = page.getByTestId("upload-row").filter({ hasText: "Interview Sample.mp4" }).last();
  await expect(row.getByText(/connection dropped/)).toBeVisible({ timeout: 30_000 });
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.unroute("**/api/uploads/*/chunks/1");

  // After a reload the unfinished upload is offered for resuming; only the missing part is sent.
  await page.reload();
  const unfinished = page.getByRole("list", { name: "Unfinished uploads" }).getByRole("listitem").first();
  await expect(unfinished).toContainText("Interview Sample.mp4");
  await expect(unfinished).toContainText(/50% sent/);
  const sentChunks: string[] = [];
  page.on("request", (request) => {
    const match = /\/chunks\/(\d+)$/.exec(request.url());
    if (match) sentChunks.push(match[1]!);
  });
  const chooser = page.waitForEvent("filechooser");
  await unfinished.getByRole("button", { name: "Resume" }).click();
  await (await chooser).setFiles(media("Interview Sample.mp4"));
  await expect(page.getByText("Uploaded — processing in the background")).toBeVisible({ timeout: 60_000 });
  expect(sentChunks).toEqual(["1"]);
  await expect(page.getByTestId("video-card").filter({ hasText: "Interview Sample" })).toHaveCount(2);
});

test("search and filters narrow the library", async () => {
  await page.goto("/videos?q=phone");
  await expect(page.getByTestId("video-card")).toHaveCount(1);
  await page.goto("/videos?status=failed");
  await expect(page.getByText("No matching videos")).toBeVisible();
});

test("files are only available to the signed-in owner", async ({ request }) => {
  await page.goto("/videos");
  const href = await card("Phone Clip").getAttribute("href");
  const id = href!.split("/").pop()!;

  const asOwner = await page.request.get(`/api/media/videos/${id}/source`, { headers: { Range: "bytes=0-15" } });
  expect(asOwner.status()).toBe(206);

  const signedOut = await request.get(`/api/media/videos/${id}/source`, { headers: { cookie: "" } });
  expect(signedOut.status()).toBe(401);
  expect((await page.request.get(`/api/media/videos/not-a-real-id/source`)).status()).toBe(404);
  const otherOrigin = await page.request.post("/api/uploads", {
    data: { filename: "x.mp4", size: 10 },
    headers: { origin: "http://evil.example" },
  });
  expect(otherOrigin.status()).toBe(403);
});

test("deleting a video asks for confirmation and removes it", async () => {
  await page.goto("/videos?q=phone");
  await card("Phone Clip").click();
  await page.getByRole("tab", { name: "Details" }).click();
  await page.getByRole("button", { name: "Delete video" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Delete “Phone Clip”?");
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page).toHaveURL(/\/videos$/);
  await expect(card("Phone Clip")).toHaveCount(0);
});

test("the activity drawer lists finished jobs", async () => {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /Background jobs/ }).click();
  await expect(page.getByRole("dialog").getByText("Processing video").first()).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Done").first()).toBeVisible();
});
