import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { claimNextJob, completeJob } from "@/server/jobs/queue";
import {
  connectChannelsFromCode,
  disconnectChannel,
  getPublishForm,
  listChannels,
  listPublications,
  startPublication,
} from "@/server/services/youtube";
import { resolveStoragePath } from "@/server/storage";
import { beginAuthorization, getAccessToken, ReauthRequiredError, verifyAuthorization } from "@/server/youtube/oauth";
import { quotaDay, QuotaExceededError, reserveQuota } from "@/server/youtube/quota";
import { runYouTubeUpload, toUploadFailure } from "@/server/youtube/upload";
import { createFakeGoogle } from "../support/fake-google.mjs";
import { createTestUser, fakeMp4 } from "../support/fixtures";

const BASE = "http://127.0.0.1:3296";
let fake: ReturnType<typeof createFakeGoogle>;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let stranger: Awaited<ReturnType<typeof createTestUser>>;

/** Goes through the whole sign-in with the stand-in: start → "Allow" → callback values. */
async function connect(userId: string) {
  const { url, cookie } = beginAuthorization(userId);
  const consent = fake.handle({ method: "GET", url, headers: {} });
  const back = new URL(consent.headers.location);
  const { verifier } = verifyAuthorization(cookie, userId, back.searchParams.get("state"));
  const [channelId] = await connectChannelsFromCode(userId, back.searchParams.get("code")!, verifier);
  return channelId;
}

async function readyVideo(userId: string, bytes = 700 * 1024) {
  const video = await db.video.create({
    data: {
      userId,
      title: "Editing talk",
      originalFilename: "talk.mp4",
      sourcePath: "placeholder",
      sizeBytes: BigInt(bytes),
      container: "mp4",
      status: "ready",
      durationMs: 600_000,
      width: 1920,
      height: 1080,
      audioCodec: "aac",
    },
  });
  fs.mkdirSync(resolveStoragePath(`videos/${video.id}`), { recursive: true });
  fs.writeFileSync(resolveStoragePath(`videos/${video.id}/source.mp4`), fakeMp4(bytes));
  return db.video.update({ where: { id: video.id }, data: { sourcePath: `videos/${video.id}/source.mp4` } });
}

const publishInput = (videoId: string, channelId: string) => ({
  kind: "video" as const,
  targetId: videoId,
  channelId,
  title: "Edit faster with transcripts",
  description: "How it works.\n\n#editing",
  tags: ["editing", "video tips"],
  categoryId: "27",
  privacyStatus: "private" as const,
  publishAt: null,
  madeForKids: false,
  containsSyntheticMedia: false,
  thumbnailId: null,
});

beforeAll(async () => {
  owner = await createTestUser("yt-owner");
  stranger = await createTestUser("yt-stranger");
});

beforeEach(async () => {
  fake = createFakeGoogle(BASE);
  vi.stubGlobal("fetch", fake.fetch);
  await db.job.deleteMany();
  await db.apiQuotaUsage.deleteMany();
  await db.publication.deleteMany();
  await db.youTubeChannel.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connecting a channel (YT-01, SECURITY.md §3.2)", () => {
  it("asks only for the needed scopes, with PKCE, state and offline access", () => {
    const { url, cookie } = beginAuthorization(owner.id);
    const params = new URL(url).searchParams;
    expect(url.startsWith(`${BASE}/o/oauth2/v2/auth?`)).toBe(true);
    expect(params.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
    );
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("state")!.length).toBeGreaterThanOrEqual(43); // 32 random bytes
    expect(params.get("redirect_uri")).toBe("http://localhost:3999/api/youtube/oauth/callback");
    expect(cookie).toMatch(/^v1:/); // sealed: the verifier isn't readable from the cookie
    expect(cookie).not.toContain(params.get("state")!);
  });

  it("rejects a wrong state, another user, an expired flow or a tampered cookie", () => {
    const { url, cookie } = beginAuthorization(owner.id, Date.now());
    const state = new URL(url).searchParams.get("state")!;
    expect(() => verifyAuthorization(cookie, owner.id, "wrong-state")).toThrow(/isn't valid any more/);
    expect(() => verifyAuthorization(cookie, stranger.id, state)).toThrow(/isn't valid any more/);
    expect(() => verifyAuthorization(cookie, owner.id, state, Date.now() + 11 * 60_000)).toThrow(/isn't valid/);
    expect(() => verifyAuthorization(`${cookie.slice(0, -4)}AAAA`, owner.id, state)).toThrow(/isn't valid/);
    expect(() => verifyAuthorization(undefined, owner.id, state)).toThrow(/isn't valid/);
    expect(verifyAuthorization(cookie, owner.id, state).verifier).toBeTruthy();
  });

  it("stores the channel and encrypted tokens, never returning them", async () => {
    const channelId = await connect(owner.id);
    const [channel] = await listChannels(owner.id);
    expect(channel).toMatchObject({
      id: channelId,
      youtubeChannelId: "UC_fake_channel_1",
      title: "Test Channel",
      handle: "@testchannel",
      thumbnailUrl: "https://yt3.ggpht.com/fake-avatar=s88",
      status: "active",
    });
    expect(JSON.stringify(channel)).not.toMatch(/ya29|1\/\/fake-refresh/);
    const credential = await db.oAuthCredential.findUniqueOrThrow({ where: { channelId } });
    expect(credential.accessTokenEnc).toMatch(/^v1:/);
    expect(credential.refreshTokenEnc).toMatch(/^v1:/);
    for (const token of [...fake.state.refreshTokens, ...fake.state.accessTokens.keys()]) {
      expect(credential.accessTokenEnc + credential.refreshTokenEnc).not.toContain(token);
    }
    expect(await listChannels(stranger.id)).toEqual([]);
    const settings = await db.userSettings.findUnique({ where: { userId: owner.id } });
    expect(settings?.defaultChannelId).toBe(channelId);
  });

  it("refuses a wrong PKCE verifier and missing permissions", async () => {
    const { url, cookie } = beginAuthorization(owner.id);
    const back = new URL(fake.handle({ method: "GET", url, headers: {} }).headers.location);
    verifyAuthorization(cookie, owner.id, back.searchParams.get("state"));
    await expect(connectChannelsFromCode(owner.id, back.searchParams.get("code")!, "not-the-verifier")).rejects.toThrow(
      /Reconnect|sign-in/i,
    );

    fake.state.grantScopes = "https://www.googleapis.com/auth/youtube.readonly";
    await expect(connect(owner.id)).rejects.toThrow(/didn't grant all the permissions/);
    expect(await db.youTubeChannel.count()).toBe(0);
  });

  it("explains an account without a YouTube channel", async () => {
    fake.state.channels = [];
    await expect(connect(owner.id)).rejects.toThrow(/has no YouTube channel/);
  });
});

describe("tokens over time (YT-02, YT-03)", () => {
  it("refreshes an expired access token", async () => {
    const channelId = await connect(owner.id);
    await db.oAuthCredential.update({
      where: { channelId },
      data: { accessTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const before = fake.state.accessTokens.size;
    const token = await getAccessToken(channelId);
    expect(fake.state.accessTokens.has(token)).toBe(true);
    expect(fake.state.accessTokens.size).toBe(before + 1);
  });

  it("marks the channel 'reconnect' when Google answers invalid_grant", async () => {
    const channelId = await connect(owner.id);
    await db.oAuthCredential.update({ where: { channelId }, data: { accessTokenExpiresAt: new Date(0) } });
    fake.state.failRefreshWithInvalidGrant = true;
    await expect(getAccessToken(channelId)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect((await listChannels(owner.id))[0].status).toBe("reauth_required");
    // Reconnecting makes it active again.
    fake.state.failRefreshWithInvalidGrant = false;
    await connect(owner.id);
    expect((await listChannels(owner.id))[0].status).toBe("active");
  });

  it("disconnect revokes at Google and deletes the tokens", async () => {
    const channelId = await connect(owner.id);
    await expect(disconnectChannel(stranger.id, channelId)).rejects.toThrow("Channel not found.");
    const result = await disconnectChannel(owner.id, channelId);
    expect(result.revoked).toBe(true);
    expect(fake.state.revoked.size).toBe(1);
    expect(await db.oAuthCredential.count({ where: { channelId } })).toBe(0);
    expect((await listChannels(owner.id, { includeRevoked: true }))[0].status).toBe("revoked");
    expect(await listChannels(owner.id)).toEqual([]);
  });
});

describe("publishing (YT-04…08)", () => {
  it("validates, queues a job without tokens, and uploads the exact metadata", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id);
    await expect(
      startPublication(owner.id, { ...publishInput(video.id, channelId), privacyStatus: "public" }),
    ).rejects.toThrow(/private only/);
    await expect(startPublication(stranger.id, publishInput(video.id, channelId))).rejects.toThrow("Not found.");

    const form = await getPublishForm(owner.id, "video", video.id);
    expect(form?.channels.map((c) => c.id)).toEqual([channelId]);

    const publicationId = await startPublication(owner.id, publishInput(video.id, channelId));
    const job = await claimNextJob("node-1", ["yt.upload"]);
    expect(job?.payload).toEqual({ publicationId });

    const progress: number[] = [];
    const result = await runYouTubeUpload(publicationId, async (fraction) => {
      progress.push(fraction);
      return false;
    });
    expect(progress.length).toBeGreaterThan(2); // 700 KB in 256 KB chunks
    const [uploaded] = fake.state.videos;
    expect(uploaded.snippet).toEqual({
      title: "Edit faster with transcripts",
      description: "How it works.\n\n#editing",
      tags: ["editing", "video tips"],
      categoryId: "27",
    });
    expect(uploaded.status).toMatchObject({
      privacyStatus: "private",
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    });
    expect(uploaded.status.publishAt).toBeUndefined();

    await completeJob(job!.id, "node-1", result);
    const [view] = await listPublications(owner.id);
    expect(view).toMatchObject({
      status: "uploaded",
      actualPrivacyStatus: "private",
      youtubeUrl: `https://www.youtube.com/watch?v=${uploaded.id}`,
    });
    const usage = await db.apiQuotaUsage.findMany({ where: { projectDate: quotaDay() } });
    expect(usage.find((u) => u.bucket === "videos.insert")?.units).toBe(1);
    expect(usage.find((u) => u.bucket === "default")?.units).toBe(1); // one channels.list when connecting
  });

  it("sends publishAt only together with private", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 300 * 1024);
    const publication = await db.publication.create({
      data: {
        userId: owner.id,
        channelId,
        videoId: video.id,
        sourceTitle: video.title,
        filePath: video.sourcePath,
        title: "Scheduled",
        description: "",
        categoryId: "22",
        privacyStatus: "public",
        publishAt: new Date("2030-01-01T10:00:00Z"),
        madeForKids: false,
        containsSyntheticMedia: true,
      },
    });
    await runYouTubeUpload(publication.id, async () => false);
    expect(fake.state.videos[0].status).toMatchObject({
      privacyStatus: "private",
      publishAt: "2030-01-01T10:00:00.000Z",
      containsSyntheticMedia: true,
    });
  });

  it("resumes after a dropped connection without re-sending what arrived", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 900 * 1024); // 4 chunks of 256 KB
    const publicationId = await startPublication(owner.id, publishInput(video.id, channelId));
    fake.state.dropAfterChunks = 2; // chunk 2 arrives, but the reply is lost
    const result = await runYouTubeUpload(publicationId, async () => false);
    expect(result.youtubeVideoId).toBe(fake.state.videos[0].id);
    const statusQueries = fake.state.requests.filter(
      (r) => r.method === "PUT" && r.headers["content-range"]?.startsWith("bytes */"),
    );
    expect(statusQueries).toHaveLength(1); // asked YouTube how much it had
    const chunkStarts = fake.state.requests
      .filter((r) => r.method === "PUT" && !r.headers["content-range"]?.startsWith("bytes */"))
      .map((r) => r.headers["content-range"].split(/[ -]/)[1]);
    expect(chunkStarts).toEqual(["0", "262144", "524288", "786432"]); // nothing sent twice
  }, 15_000);

  it("continues a stored session after a retried job", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 900 * 1024);
    const publicationId = await startPublication(owner.id, publishInput(video.id, channelId));
    // First attempt: stopped after the first chunk (like a crash or the worker being stopped).
    let calls = 0;
    await expect(runYouTubeUpload(publicationId, async () => ++calls > 2)).rejects.toThrow();
    const stored = await db.publication.findUniqueOrThrow({ where: { id: publicationId } });
    expect(stored.uploadSessionEnc).toMatch(/^v1:/);
    expect(Number(stored.bytesUploaded)).toBe(262144);
    fake.state.requests.length = 0;
    await runYouTubeUpload(publicationId, async () => false);
    expect(fake.state.requests.filter((r) => r.path === "/upload/youtube/v3/videos")).toHaveLength(0); // no new session
    expect(fake.state.videos).toHaveLength(1);
  });

  it("sets the chosen thumbnail, and a refusal is only a warning", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 300 * 1024);
    fs.mkdirSync(resolveStoragePath("thumbnails"), { recursive: true });
    const thumbnail = await db.thumbnail.create({
      data: {
        userId: owner.id,
        videoId: video.id,
        origin: "frame",
        status: "ready",
        width: 1280,
        height: 720,
        filePath: "thumbnails/t-yt.jpg",
      },
    });
    fs.writeFileSync(resolveStoragePath("thumbnails/t-yt.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const id = await startPublication(owner.id, { ...publishInput(video.id, channelId), thumbnailId: thumbnail.id });
    const ok = await runYouTubeUpload(id, async () => false);
    expect(ok.thumbnailSet).toBe(true);
    expect(fake.state.thumbnails).toEqual([{ videoId: ok.youtubeVideoId, bytes: 6 }]);

    await db.publication.update({ where: { id }, data: { status: "uploaded" } });
    fake.state.thumbnailError = 403;
    const id2 = await startPublication(owner.id, { ...publishInput(video.id, channelId), thumbnailId: thumbnail.id });
    const refused = await runYouTubeUpload(id2, async () => false);
    expect(refused.thumbnailSet).toBe(false);
    expect(refused.warnings[0]).toMatch(/thumbnail couldn't be set.*verified channel/);
  });

  it("reports YouTube's real privacy when it differs (e.g. locked to private)", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 300 * 1024);
    const publication = await db.publication.create({
      data: {
        userId: owner.id,
        channelId,
        videoId: video.id,
        sourceTitle: video.title,
        filePath: video.sourcePath,
        title: "Public please",
        description: "",
        categoryId: "22",
        privacyStatus: "public",
        madeForKids: false,
        containsSyntheticMedia: false,
      },
    });
    fake.state.forcePrivate = true;
    const result = await runYouTubeUpload(publication.id, async () => false);
    expect(result.privacyStatus).toBe("private");
    expect(result.warnings).toContain('YouTube set the video to "private" instead of "public".');
  });

  it("maps YouTube errors to clear, non-retryable failures", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 300 * 1024);
    const id = await startPublication(owner.id, publishInput(video.id, channelId));
    fake.state.uploadError = { status: 400, reason: "uploadLimitExceeded" };
    const failure = toUploadFailure(await runYouTubeUpload(id, async () => false).catch((e: unknown) => e));
    expect(failure).toMatchObject({ code: "YOUTUBE_uploadLimitExceeded", retryable: false });
    expect(failure.message).toMatch(/upload limit/);
  });
});

describe("quota guard (YT-07)", () => {
  it("blocks the 101st upload of the day and says when it resets", async () => {
    const channelId = await connect(owner.id);
    const video = await readyVideo(owner.id, 300 * 1024);
    await db.apiQuotaUsage.create({ data: { projectDate: quotaDay(), bucket: "videos.insert", units: 99 } });
    await reserveQuota("videos.insert", 1); // the 100th is fine
    const error = await reserveQuota("videos.insert", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect((error as QuotaExceededError).message).toMatch(/100 uploads.*midnight Pacific time/);
    await expect(startPublication(owner.id, publishInput(video.id, channelId))).rejects.toThrow(
      /upload limit \(100\) is used up/,
    );
    expect(await db.job.count({ where: { type: "yt.upload" } })).toBe(0);
  });

  it("stops before the daily unit quota runs out (thumbnails cost 50)", async () => {
    await db.apiQuotaUsage.create({ data: { projectDate: quotaDay(), bucket: "default", units: 9_960 } });
    await expect(reserveQuota("default", 50)).rejects.toBeInstanceOf(QuotaExceededError);
    await reserveQuota("default", 40);
    const row = await db.apiQuotaUsage.findFirstOrThrow({ where: { bucket: "default" } });
    expect(row.units).toBe(10_000);
  });
});

describe("no token ever leaks (SECURITY.md §3.3)", () => {
  it("keeps tokens out of logs, job payloads and anything returned to the app", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const channelId = await connect(owner.id);
      const video = await readyVideo(owner.id, 600 * 1024);
      const id = await startPublication(owner.id, publishInput(video.id, channelId));
      fake.state.dropAfterChunks = 1;
      await runYouTubeUpload(id, async () => false);
      fake.state.failRefreshWithInvalidGrant = true;
      await db.oAuthCredential.update({ where: { channelId }, data: { accessTokenExpiresAt: new Date(0) } });
      await getAccessToken(channelId).catch(() => undefined);
      await disconnectChannel(owner.id, channelId);

      const tokens = [...fake.state.refreshTokens, ...fake.state.accessTokens.keys()];
      const sessions = [...fake.state.sessions.keys()];
      expect(tokens.length).toBeGreaterThan(1);
      const jobs = await db.job.findMany();
      const haystack = [
        ...lines,
        ...jobs.map((j) => `${j.payloadJson} ${j.resultJson ?? ""} ${j.error ?? ""}`),
        JSON.stringify(await listChannels(owner.id, { includeRevoked: true })),
        JSON.stringify(await listPublications(owner.id)),
        JSON.stringify(await getPublishForm(owner.id, "video", video.id)),
        JSON.stringify(await db.publication.findMany(), (_key, value: unknown) =>
          typeof value === "bigint" ? String(value) : value,
        ),
      ].join("\n");
      for (const secret of [...tokens, ...sessions]) expect(haystack).not.toContain(secret);
      expect(lines.some((line) => line.includes("interrupted"))).toBe(true); // logging did happen
    } finally {
      process.env.LOG_LEVEL = level;
      for (const spy of spies) spy.mockRestore();
    }
  }, 15_000);
});
