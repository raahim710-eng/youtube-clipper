// Test-only stand-in for Google OAuth + the YouTube Data API (never used by the app outside tests).
// It follows the documented protocols closely enough to test the app's side: authorization code + PKCE,
// token refresh and revocation, channels.list, resumable uploads (308/Range, status queries) and
// thumbnails.set. Switches simulate failures: a dropped connection mid-upload, invalid_grant, quota errors.
//
// Used two ways: as a `fetch` replacement in Vitest (createFakeGoogle().fetch) and as a local HTTP
// server for Playwright (`node tests/support/fake-google.mjs`, port FAKE_GOOGLE_PORT).
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

export const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
export const CLIENT_SECRET = "fake-client-secret";

export function createFakeGoogle(base) {
  const state = {
    base,
    codes: new Map(), // code → { challenge, redirectUri, scope }
    accessTokens: new Map(), // token → { refreshToken, expires }
    refreshTokens: new Set(),
    revoked: new Set(),
    sessions: new Map(), // id → { metadata, total, received, done, video }
    videos: [],
    thumbnails: [],
    requests: [],
    // Switches (tests flip these):
    grantScopes: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload",
    channels: [
      {
        id: "UC_fake_channel_1",
        snippet: {
          title: "Test Channel",
          customUrl: "@testchannel",
          thumbnails: { default: { url: "https://yt3.ggpht.com/fake-avatar=s88" } },
        },
        contentDetails: { relatedPlaylists: { uploads: "UU_fake_channel_1" } },
      },
    ],
    failRefreshWithInvalidGrant: false,
    dropAfterChunks: 0, // >0: the Nth chunk is received, then the connection drops before the reply
    chunksSeen: 0,
    forcePrivate: false, // simulate YouTube locking uploads of unaudited projects to private
    thumbnailError: null, // e.g. 403
    uploadError: null, // e.g. { status: 403, reason: "quotaExceeded" }
    accessTokenLifetime: 3600,
  };

  const json = (status, body, headers = {}) => ({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const error = (status, reason, message = reason) =>
    json(status, { error: { code: status, message, errors: [{ reason, message }] } });
  const bearer = (headers) => {
    const value = headers.authorization ?? "";
    const token = value.startsWith("Bearer ") ? value.slice(7) : null;
    const entry = token ? state.accessTokens.get(token) : null;
    return entry && entry.expires > Date.now() && !state.revoked.has(entry.refreshToken) ? token : null;
  };
  const issue = (refreshToken) => {
    const accessToken = `ya29.fake-${randomBytes(8).toString("hex")}`;
    state.accessTokens.set(accessToken, { refreshToken, expires: Date.now() + state.accessTokenLifetime * 1000 });
    return accessToken;
  };

  function handle({ method, url, headers, body }) {
    const u = new URL(url);
    state.requests.push({
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      bodyLength: body?.length ?? 0,
    });

    if (method === "GET" && u.pathname === "/o/oauth2/v2/auth") {
      const p = u.searchParams;
      if (
        p.get("client_id") !== CLIENT_ID ||
        p.get("code_challenge_method") !== "S256" ||
        !p.get("code_challenge") ||
        !p.get("state")
      ) {
        return json(400, { error: "invalid_request" });
      }
      const code = `4/fake-${randomBytes(6).toString("hex")}`;
      state.codes.set(code, {
        challenge: p.get("code_challenge"),
        redirectUri: p.get("redirect_uri"),
        scope: state.grantScopes,
      });
      // Simulates the user pressing "Allow" on Google's consent screen.
      const back = new URL(p.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", p.get("state"));
      return { status: 302, headers: { location: back.toString() }, body: "" };
    }

    if (method === "POST" && u.pathname === "/token") {
      const p = new URLSearchParams(body?.toString() ?? "");
      if (p.get("client_id") !== CLIENT_ID || p.get("client_secret") !== CLIENT_SECRET)
        return json(401, { error: "invalid_client" });
      if (p.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(p.get("code"));
        state.codes.delete(p.get("code"));
        const challenge = createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url");
        if (!entry || entry.redirectUri !== p.get("redirect_uri") || entry.challenge !== challenge) {
          return json(400, { error: "invalid_grant" });
        }
        const refreshToken = `1//fake-refresh-${randomBytes(8).toString("hex")}`;
        state.refreshTokens.add(refreshToken);
        return json(200, {
          access_token: issue(refreshToken),
          refresh_token: refreshToken,
          expires_in: state.accessTokenLifetime,
          scope: entry.scope,
          token_type: "Bearer",
        });
      }
      if (p.get("grant_type") === "refresh_token") {
        const refreshToken = p.get("refresh_token");
        if (
          state.failRefreshWithInvalidGrant ||
          !state.refreshTokens.has(refreshToken) ||
          state.revoked.has(refreshToken)
        ) {
          return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        }
        return json(200, {
          access_token: issue(refreshToken),
          expires_in: state.accessTokenLifetime,
          scope: state.grantScopes,
          token_type: "Bearer",
        });
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (method === "POST" && u.pathname === "/revoke") {
      const token = new URLSearchParams(body?.toString() ?? "").get("token");
      if (!token || !state.refreshTokens.has(token)) return json(400, { error: "invalid_token" });
      state.revoked.add(token);
      return { status: 200, headers: {}, body: "" };
    }

    if (method === "GET" && u.pathname === "/youtube/v3/channels") {
      if (!bearer(headers)) return error(401, "authError", "Invalid Credentials");
      return json(200, { kind: "youtube#channelListResponse", items: state.channels });
    }

    if (
      method === "POST" &&
      u.pathname === "/upload/youtube/v3/videos" &&
      u.searchParams.get("uploadType") === "resumable"
    ) {
      if (!bearer(headers)) return error(401, "authError", "Invalid Credentials");
      if (state.uploadError) return error(state.uploadError.status, state.uploadError.reason);
      const id = randomBytes(6).toString("hex");
      state.sessions.set(id, {
        metadata: JSON.parse(body?.toString() ?? "{}"),
        total: Number(headers["x-upload-content-length"]),
        received: 0,
        done: false,
        video: null,
      });
      return { status: 200, headers: { location: `${state.base}/upload/session/${id}` }, body: "" };
    }

    const sessionMatch = u.pathname.match(/^\/upload\/session\/([a-f0-9]+)$/);
    if (method === "PUT" && sessionMatch) {
      if (!bearer(headers)) return error(401, "authError", "Invalid Credentials");
      const session = state.sessions.get(sessionMatch[1]);
      if (!session) return json(404, { error: { code: 404, message: "Not Found" } });
      const range = headers["content-range"] ?? "";
      const status = () =>
        session.done
          ? json(201, session.video)
          : {
              status: 308,
              headers: session.received > 0 ? { range: `bytes=0-${session.received - 1}` } : {},
              body: "",
            };
      if (range.startsWith("bytes */")) return status();
      const m = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!m) return json(400, { error: { code: 400, message: "Bad Content-Range" } });
      const [start, end] = [Number(m[1]), Number(m[2])];
      if (start !== session.received || (body?.length ?? 0) !== end - start + 1) return status();
      session.received = end + 1;
      state.chunksSeen += 1;
      if (session.received >= session.total) {
        const meta = session.metadata;
        const privacyStatus = state.forcePrivate ? "private" : (meta.status?.privacyStatus ?? "public");
        session.done = true;
        session.video = {
          kind: "youtube#video",
          id: `vid_${randomBytes(4).toString("hex")}`,
          snippet: meta.snippet,
          status: { ...meta.status, privacyStatus, uploadStatus: "uploaded" },
        };
        state.videos.push(session.video);
      }
      if (state.dropAfterChunks > 0 && state.chunksSeen === state.dropAfterChunks) return { drop: true };
      return status();
    }

    if (method === "POST" && u.pathname === "/upload/youtube/v3/thumbnails/set") {
      if (!bearer(headers)) return error(401, "authError", "Invalid Credentials");
      if (state.thumbnailError)
        return error(
          state.thumbnailError,
          "forbidden",
          "The authenticated user doesn't have permissions to upload and set custom video thumbnails.",
        );
      state.thumbnails.push({ videoId: u.searchParams.get("videoId"), bytes: body?.length ?? 0 });
      return json(200, { items: [{ default: { url: "https://i.ytimg.com/vi/x/default.jpg" } }] });
    }

    return json(404, { error: "not_found", path: u.pathname });
  }

  /** `fetch` replacement for Vitest. A simulated drop throws like a real network failure. */
  async function fakeFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    const headers = {};
    new Headers(init.headers ?? {}).forEach((value, key) => (headers[key] = value));
    let body = init.body;
    if (body instanceof URLSearchParams) body = Buffer.from(body.toString());
    else if (typeof body === "string") body = Buffer.from(body);
    else if (body instanceof Uint8Array) body = Buffer.from(body);
    const result = handle({ method: (init.method ?? "GET").toUpperCase(), url, headers, body });
    if (result.drop) throw new TypeError("fetch failed (simulated connection drop)");
    const status = result.status === 308 ? 308 : result.status;
    return new Response(status === 204 || result.body === "" ? null : result.body, { status, headers: result.headers });
  }

  return { state, handle, fetch: fakeFetch };
}

/** Runs the stand-in as a local server (Playwright). */
export function startFakeGoogleServer(port) {
  const fake = createFakeGoogle(`http://127.0.0.1:${port}`);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/__control") {
        Object.assign(fake.state, JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (req.method === "GET" && req.url === "/__state") {
        const { videos, thumbnails, revoked, chunksSeen } = fake.state;
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ videos, thumbnails, revoked: [...revoked], chunksSeen }));
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200).end("fake google");
        return;
      }
      const headers = {};
      for (const [key, value] of Object.entries(req.headers))
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      const result = fake.handle({
        method: req.method,
        url: `http://127.0.0.1:${port}${req.url}`,
        headers,
        body: Buffer.concat(chunks),
      });
      if (result.drop) {
        req.socket.destroy();
        return;
      }
      res.writeHead(result.status, result.headers).end(result.body);
    });
  });
  server.listen(port, "127.0.0.1", () => console.log(`Fake Google listening on ${port}`));
  return { server, fake };
}
