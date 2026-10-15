# Security & Privacy

Security requirements for the app. These rules apply to every phase; `CLAUDE.md` contains the short version. Tests for these rules are in `TESTING.md` §4.

## 1. Threat model (what we protect against)

The app runs on the owner's computer, but we still assume:
- Other devices on the same network may try to reach the app → **bind to localhost only**.
- Other websites open in the same browser may try CSRF or to read media → **cookies, origin checks, no permissive CORS**.
- The database file or a backup may be copied → **tokens encrypted; passwords hashed**.
- Uploaded or downloaded media may be malformed or malicious → **content validation, no shell, safe paths**.
- Secrets may leak through Git, logs or the browser → **`.env` only, redaction, server-only modules**.
- AI output may contain unsafe text (e.g. HTML or prompt-injection from a transcript) → **treated as untrusted data**.

Out of scope for v1: hardening for internet-facing deployment (TLS, WAF, multi-tenant isolation). If the app is ever exposed beyond localhost, this document must be revisited first.

## 2. Application authentication (Better Auth)

- Email + password only. Passwords: minimum 12 characters, checked against a small list of common passwords; hashed by Better Auth (scrypt by default). Never logged or returned.
- Sign-up allowed only while zero users exist (first-run setup); the setup route is closed afterwards on the server, not just hidden. Creating the owner also inserts a fixed-id `OwnerLock` row, so two simultaneous first-run sign-ups can't both succeed (Phase 10, D-059).
- Sessions are stored in the database and never cached (DECISIONS.md D-022); the cookie is `httpOnly`, `SameSite=Lax`, `Secure` when served over HTTPS; 7-day expiry, refreshed at most once a day; sessions can be listed and signed out in Settings › Profile & security; changing the password revokes other sessions — enforced on the server (a request without `revokeOtherSessions: true` is refused, Phase 10).
- Rate limiting (always on, D-025): sign-in 5/min, sign-up 3/min, change-password 5/min. All attempts share one bucket per endpoint: the auth route replaces the client-supplied `X-Forwarded-For` with `127.0.0.1` before Better Auth reads it, so a script can't get a fresh bucket by inventing an IP per guess (Phase 10, D-059; tested). Every failed login writes an `AuditLog` entry. Sign-in uses the same message for unknown email and wrong password.
- Authorisation: every route handler and server action calls `requireSession()` and filters every query by `userId`. Middleware redirects are a convenience, not the security boundary.
- `BETTER_AUTH_SECRET`: at least 32 random bytes, generated per installation.
- Password reset: `npm run auth:reset-password` (local CLI, requires shell access to the machine; the new password is typed at a prompt, never passed as an argument; all sessions are signed out). No email reset in v1.
- Missing or weak configuration (e.g. `BETTER_AUTH_SECRET` absent or < 32 characters): `/login` and `/setup` show a "Setup needed" screen, `/api/auth/*` returns 503, and no login form is shown.

## 3. Google OAuth & YouTube tokens

### 3.1 Scopes (least privilege)
| Scope | Why | Phase |
|---|---|---|
| `https://www.googleapis.com/auth/youtube.readonly` | Identify the channel, list videos and stats | 7 |
| `https://www.googleapis.com/auth/youtube.upload` | Upload videos, set thumbnails | 7 |
| `https://www.googleapis.com/auth/yt-analytics.readonly` | Analytics reports (added by incremental authorisation) | 8 |

Never request the broad `youtube` / `youtube.force-ssl` scopes or monetary analytics scopes unless a later decision in `DECISIONS.md` justifies it.

### 3.2 Flow protections (implemented Phase 7)
- Authorization Code flow with **PKCE** and a random `state` (≥ 32 bytes). Both are stored in a short-lived (10 min) `httpOnly`, `SameSite=Lax` cookie bound to the logged-in session and verified on callback.
- The redirect URI is fixed from `GOOGLE_REDIRECT_URI`; no user-controlled redirect targets.
- On callback: verify that the logged-in user started the flow, exchange the code server-side, check granted scopes, and fetch the channel with `channels.list?mine=true`.
- `access_type=offline` + `prompt=consent` to obtain a refresh token; `include_granted_scopes=true` for incremental authorisation.
- Implementation notes: the cookie holds `{state, verifier, userId, expiry}` sealed with AES-GCM (unreadable and tamper-proof), path `/api/youtube/oauth`; `state` is compared in constant time; both routes check the session (they redirect instead of answering 401 because the browser visits them). `GOOGLE_API_TEST_BASE_URL` (tests only) accepts only localhost addresses, so tokens can never be sent to another host by configuration.

### 3.3 Token storage (implemented Phase 7)
- Encrypted with **AES-256-GCM** in `src/server/crypto.ts`: random 96-bit IV per encryption, auth tag verified on decrypt, format `v1:<iv>:<tag>:<ciphertext>` (base64), with `keyVersion` for rotation.
- Key: `TOKEN_ENCRYPTION_KEY` = 32 random bytes, base64. The app refuses to start YouTube features if it is missing or the wrong length.
- Tokens are decrypted only inside `src/server/youtube/oauth.ts` at the moment of use, are never sent to the browser, never included in API responses, job payloads or logs, and are excluded from Prisma `select`s by default.
- Refresh failures (`invalid_grant`) set the channel to `reauth_required` and show a reconnect prompt.
- The resumable-upload session URI (it allows uploading to that video for a while) is encrypted the same way. Job payloads contain only a publication id. The logger redacts keys matching token/secret/password/authorization/cookie/verifier/upload session. A test uploads, refreshes, revokes and disconnects with logging at debug level and checks that no token or session id appears in logs, job payloads, results or anything returned to the UI.
- Disconnecting revokes the token at Google (`oauth2.revokeToken`) and deletes the credential row.

### 3.4 Google Cloud project setup (owner's responsibility, documented in README)
- OAuth consent screen: External, Testing mode, owner's Google account added as a test user. Expect **7-day refresh-token expiry** in Testing mode.
- Keep `GOOGLE_CLIENT_SECRET` only in `.env`; never download the client-secret JSON into the repository folder (it is git-ignored anyway).
- Public/scheduled uploads need the YouTube API Services compliance audit, and publishing the consent screen with YouTube scopes needs Google verification (privacy policy and homepage). Both are free. Do not try to work around them.

## 4. File security

- **Uploads (implemented, Phase 3):** chunked uploads only to the signed-in user's own `Upload` record (every query filters by `userId`; another user's ID behaves like a missing one); each chunk's index and exact byte length are enforced while streaming (oversized chunks are cut off with 413); total size capped by `MAX_UPLOAD_MB`; idle uploads expire after 24 h and their data is deleted; cancelled or rejected uploads are deleted at once.
- **Validation by content:** on completion the file's magic bytes must match the claimed format (MP4/MOV family, Matroska/WebM or AVI); then the worker's ffprobe must find a real video stream within `MAX_VIDEO_DURATION_MIN`. The browser's MIME type is never trusted. Files that fail are deleted; the record keeps a plain-language reason.
- **Images** (thumbnail uploads, implemented Phase 6): the request body is capped at 10 MB while reading; the first bytes must be JPEG or PNG (the browser's type and file name are not trusted); the worker decodes it with Pillow (max 50 megapixels; damaged files fail), converts it to RGB, crops it and re-encodes it as JPEG (this removes metadata such as EXIF/GPS and embedded payloads), max 2 MB output; the original upload is deleted afterwards. The same-origin check (§5) applies.
- **Paths:** all files are named with generated IDs. `resolveStoragePath()` (TypeScript) and its Python mirror `resolve_storage_path()` reject anything outside `STORAGE_DIR` (`..`, absolute paths, drive letters, null bytes; symlinks/junctions out of root when serving). Paths a worker reports back are validated again and must lie inside that video's own folder; an exported Short must be exactly the `shorts/{id}/render-….mp4` path the app asked for (checked by the worker's payload model and again by the app). Original filenames are display-only.
- **Serving:** media is streamed through `/api/media/...` (videos and exported Shorts) after session + ownership checks, with `Content-Type` from our metadata, `Content-Disposition` for downloads, and `X-Content-Type-Options: nosniff`. Nothing user-generated is placed in `public/`.
- **Process execution:** FFmpeg/ffprobe and other tools are run with argument arrays, no shell, fixed executable paths (`FFMPEG_PATH` or `PATH`), timeouts, and inputs that are always our own resolved paths. Text that goes into FFmpeg filters (e.g. captions) is written to files (`.ass`) rather than passed as filter strings, to avoid filter-syntax injection; inside the `.ass` file user text is escaped so `{…}` override codes and `\N`-style escapes can't be injected, and control characters are removed (implemented Phase 5, tested with `{`, `\`, `:` and emoji). Exports run FFmpeg inside the Short's own folder, so file names in filters are fixed relative names.
- **Stock downloads (implemented Phase 9):** only https URLs returned by the provider API whose host is on an allowlist (`videos.pexels.com`, `player.vimeo.com`, `cdn.pixabay.com`) — checked in the worker before downloading and again by the app's Zod schema for every candidate; no redirects followed; capped at 200 MB while streaming to a partial file; stored under fixed names `stock-cache/{provider}/{numeric id}.mp4`; probed with ffprobe and motion-checked before rendering. API keys stay in `.env`, are sent only in the provider's documented header (Pexels) or query (Pixabay, its only option) and never reach the browser or logs.
- **Generator uploads (implemented Phase 9):** scene clips (MP4/MOV/M4V/WebM/MKV, at most 500 MB) and background music (MP3/WAV/M4A/OGG, at most 50 MB) are sent as the raw body to `POST /api/generator/...` (session + same-origin + ownership checks), streamed to disk with the size cap enforced while reading (nothing is held in memory), checked by their first bytes and stored under generated names in `generator/{projectId}/`; the extension comes from an allowlist, never from the file name. Clips are probed and motion-checked by the worker before use. Narration WAVs, clips and music are served only through authenticated routes. Worker results may only name the narration files and the `videos/{id}/source.mp4` output the app asked for.
- **Deletion and housekeeping (implemented Phase 10, D-057):** deleting a video, Short or generator project deletes its records at once and its files with a few retries (Windows file locks); a failed file deletion never fails the action. The housekeeping task (`src/server/maintenance.ts`, Node worker, hourly) then removes anything whose record is gone, old narration takes and replaced clips, uploaded thumbnail originals that are no longer being processed (they may contain EXIF/GPS data), expired search caches and unused stock clips — only inside `STORAGE_DIR`, only files older than an hour, never files of an item with an active job. A failed thumbnail check deletes its original at once.
- **Backups (Phase 10):** `npm run backup` copies the database (online, integrity-checked) and storage to `backups/` (git-ignored); `.env` is only included with `--include-env`, which makes the backup secret. Restores move the current data aside instead of deleting it (DEPLOYMENT.md §5).

## 5. Web security

- Server binds to `localhost` only (`next dev/start -H localhost`).
- Security headers via `next.config.ts`: `Content-Security-Policy` (`'self'` everywhere, `frame-ancestors 'none'`, `object-src 'none'`; scripts currently allow `'unsafe-inline'` for Next.js bootstrap scripts — a nonce-based CSP is still open (D-026) — acceptable for a localhost-only app with no third-party scripts; YouTube/Google image hosts are added to `img-src` in Phase 7, `images.pexels.com` for stock previews in Phase 9), `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/microphone/geolocation/payment off), `X-Content-Type-Options: nosniff`, no `X-Powered-By`.
- CSRF: Better Auth checks the `Origin` header on state-changing auth requests (forced on, D-025) and blocks cross-site navigation logins; server actions use Next.js's built-in origin check; custom POST/PUT/DELETE route handlers (the upload API) call `assertSameOrigin()` and reject requests whose `Origin` isn't `BETTER_AUTH_URL` (403); no CORS headers are sent.
- Output encoding: React escaping only; `dangerouslySetInnerHTML` is forbidden. AI-generated and transcript text is rendered as plain text.
- **Internal worker API** (`/api/internal/*`, implemented Phase 3): requires `Authorization: Bearer WORKER_SHARED_SECRET` (≥ 32 characters, constant-time comparison) and is excluded from session checks. "This computer only" is enforced by the localhost binding; the additional `X-Forwarded-For` loopback check only catches requests relayed by a proxy, because clients can set that header themselves (D-059). A worker can only report on jobs it currently holds. Workers receive only the data a job needs — never tokens or secrets.

## 6. Secrets management

- All secrets live in `.env` (git-ignored). `.env.example` contains only placeholders and generation instructions.
- Required secrets are generated with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (documented in README).
- The app validates env vars at startup with Zod and fails fast with a clear message.
- The Node logger redacts values of keys matching `/token|secret|password|authorization|api[_-]?key|cookie|verifier|uploadsession|sessionuri/i` and masks secrets inside text (`key=`, `code=`, `client_secret=`, `Bearer …`, Google token formats) in messages, stacks and error causes; the Python worker's log handler masks `key=`, `token=`, `Bearer …` the same way (Phase 10, D-060). FFmpeg's raw error output (it contains file paths) goes to the log, never to the user.
- `GOOGLE_API_TEST_BASE_URL` (automated tests only) is ignored in production runs and reported on System status (D-059).
- `npm run check:secrets` (after a build) fails if a configured secret value appears in the browser bundle or if Git would include `.env`, databases, storage, backups or credential files.
- Never paste secrets into issues, prompts, screenshots or AI provider requests.

## 7. AI & external-data safety

- LLM inputs (transcripts, notes, analytics) are untrusted. Prompts wrap excerpts in tags and tell the model to treat them as data, and **model output is only ever parsed as JSON against a schema** (pydantic in the worker, Zod in the app) — it never triggers actions, tool calls, file paths, shell commands or URLs. Clip timestamps never come from the AI; ids the AI invents are ignored; text fields are length-capped and rendered as plain text (implemented Phase 4). Packaging (Phase 6) follows the same rules: chapter times and thumbnail frame times come from the transcript, YouTube's limits are enforced in code, unrelated hashtags are dropped and unsupported numbers or sensational wording are flagged for the creator (D-043).
- Original video scripts (Phase 9) follow the same rules: the brief is wrapped in `<brief>` as data, output is schema-validated, and nothing is narrated or rendered until the creator approves the script (D-054). Footage keywords from the AI only become search queries to the stock provider.
- Nothing is uploaded to YouTube without an explicit user click; AI never chooses privacy settings by itself. For generated videos the synthetic-content answer is only pre-selected ("yes"), never sent without the creator seeing it (D-055).
- Gemini (optional): not used unless the owner picks it in Settings › AI & processing and sets `GEMINI_API_KEY`; choosing it shows a notice that transcript excerpts are sent to Google and that free-tier data may be used to improve Google products. The key is sent in a header, never in a URL, and never shown in the UI.
- Speech models are downloaded only from their official Hugging Face repositories (Systran/faster-whisper-*) into `models/whisper`; Ollama models only via `ollama pull` from the Ollama library. The face detection model (YuNet) is downloaded from the OpenCV Zoo repository on GitHub and used only if its SHA-256 matches the pinned value (Phase 5).

## 8. Privacy

- Data stored locally: account, videos, transcripts, generated content, analytics copies, encrypted tokens.
- Data leaving the machine: (a) uploads and metadata to YouTube when the user publishes; (b) API calls to YouTube/Google for channel info and analytics; (c) stock-search keywords to Pexels/Pixabay; (d) transcripts/prompts to Gemini only if the user enabled it.
- No telemetry, analytics trackers or third-party scripts in the UI.
- Disconnecting a channel deletes its tokens; synced analytics for that channel can be deleted from Settings.
- YouTube API data is handled per the YouTube API Services Terms (e.g. refresh or delete stored API data within the required periods; check the current terms in Phase 7). If the app is ever offered to other users, a privacy policy is required for Google verification.

## 9. Dependency & supply-chain hygiene

- Exact versions and lockfiles; `npm audit` and `uv` lock review before each phase completes. Phase 10: `npm audit` shows only the build-tool findings accepted in D-027; `pip-audit` on the worker's locked dependencies found no known vulnerabilities (2026-10-14).
- Prefer well-maintained packages with permissive licences; record significant additions in `DECISIONS.md`.
- Model files are downloaded only from their official sources (Hugging Face model repos named in `TECHNICAL_SPEC.md`, the OpenCV Zoo, the Ollama library).

## 10. Security checklist per phase

Before marking any phase complete:
- [ ] No secrets in the diff (`git diff` reviewed; `.env` untracked).
- [ ] New endpoints check the session and ownership; new inputs have Zod schemas.
- [ ] New file handling uses the storage module; new subprocesses use argument arrays.
- [ ] Security tests in `TESTING.md` §4 pass.
- [ ] `npm audit` shows no high/critical issues without a documented reason (current accepted findings: DECISIONS.md D-027); `uvx pip-audit -r <(uv export --no-dev)` for the worker.
- [ ] `npm run build && npm run check:secrets` passes.
