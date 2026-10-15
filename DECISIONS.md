# Technical Decisions

Architecture Decision Record (ADR) log. Each entry: context → decision → reasons → consequences.
To change a decision, add a new entry that **supersedes** the old one (do not delete history).

Status values: `Accepted`, `Superseded by D-xxx`, `Proposed`.

---

## D-001 — Local-first, single-owner application
**Status:** Accepted (Phase 1)

- **Context:** Video processing and AI inference are expensive to host. The priority is near-zero cost.
- **Decision:** The app runs on the creator's own computer (`localhost`). One owner account per installation; the owner can connect several YouTube channels. Tables still carry `userId` so a multi-user version stays possible.
- **Reasons:** No hosting bills; media never leaves the machine unless published; the creator's own CPU/GPU does the heavy work.
- **Consequences:** The computer must be on for processing and uploads. Scheduled publishing relies on YouTube's own scheduler (D-012), not on our app staying online. Public SaaS hosting is out of scope.

## D-002 — Next.js (App Router) + TypeScript for the web app
**Status:** Accepted (Phase 1)

- **Decision:** One Next.js project provides UI, API route handlers and server actions. TypeScript strict mode. Node.js 24 LTS. npm as package manager.
- **Reasons:** One language for front and back end; huge ecosystem and documentation (beginner-friendly); file-based routing; npm ships with Node.
- **Consequences:** Long-running work must not run inside request handlers — it goes to workers (D-005, D-006).

## D-003 — SQLite + Prisma ORM
**Status:** Accepted (Phase 1)

- **Decision:** SQLite database file in `data/`, accessed via Prisma ORM 7 with the `better-sqlite3` driver adapter. WAL mode enabled.
- **Reasons:** No database server to install; single file is easy to back up; Prisma gives typed queries and migrations, which suits beginners.
- **Consequences:** No native enums (statuses are validated strings). One writer at a time — fine for a single-user app. Moving to PostgreSQL later means changing the provider and re-running migrations.

## D-004 — Better Auth for app login (email + password)
**Status:** Accepted (Phase 1)

- **Context:** Auth.js (NextAuth) moved to the Better Auth team in September 2025 and is in security-maintenance mode; its maintainers recommend Better Auth for new projects.
- **Decision:** Better Auth with the Prisma adapter, email/password only, sessions stored in the database. Sign-up is allowed only when no user exists (first-run owner setup).
- **Reasons:** Actively maintained, TypeScript-first, database sessions, built-in rate limiting; email/password works offline with no Google Cloud setup.
- **Consequences:** App login and YouTube channel connection are **separate** (D-013). No password-reset email in v1 (no mail service); reset is a documented CLI script.

## D-005 — Separate Python media worker
**Status:** Accepted (Phase 1)

- **Decision:** A Python 3.12 process (`media-worker/`, managed by `uv`) runs all media and AI jobs: FFmpeg orchestration, transcription, face detection, LLM calls, TTS, stock footage download.
- **Reasons:** The best free local AI/media libraries (faster-whisper, OpenCV, PySceneDetect, Kokoro) are Python. Keeping them out of the Next.js process keeps the web app responsive.
- **Consequences:** Two languages and two runtimes to set up. `uv` reduces this to one command and installs Python 3.12 automatically (3.12 is chosen over the installed 3.13 for wider ML wheel compatibility).

## D-006 — Database-backed job queue, accessed through an internal API
**Status:** Accepted (Phase 1)

- **Decision:** Jobs are rows in the `Job` table. Workers poll an internal HTTP API (`/api/internal/jobs/*`) authenticated by a shared secret. Only the Next.js app (and the Node worker, via Prisma) write to the database.
- **Reasons:** No Redis or broker to install; one source of truth for schema (Prisma); the Python worker stays stateless and testable.
- **Consequences:** Polling adds ~1–2 s latency (acceptable). The app must be running for the Python worker to work. Crash recovery uses leases and heartbeats (see `ARCHITECTURE.md`).

## D-007 — Node integration worker for Google/YouTube jobs
**Status:** Accepted (Phase 1); built in Phase 7 without `googleapis` (D-047)

- **Decision:** A small Node process (`src/worker/`, run with `tsx`) handles `yt.*` jobs (uploads, channel and analytics sync) using the official `googleapis` package.
- **Reasons:** OAuth tokens and their encryption stay in one language and one module; long uploads don't block web requests.
- **Consequences:** Three processes in development; `npm run dev:all` starts them together.

## D-008 — FFmpeg as the only video engine
**Status:** Accepted (Phase 1)

- **Decision:** The system FFmpeg/ffprobe binaries (installed separately, e.g. `winget install Gyan.FFmpeg`) do all decoding, cutting, cropping, caption burn-in (libass) and encoding. No npm/pip FFmpeg wrappers; we build argument arrays ourselves.
- **Reasons:** Free, reliable, industry standard; avoids unmaintained wrapper libraries.
- **Consequences:** Users must install FFmpeg; the health check verifies it and libass support. Builds with libx264 are GPL-licensed; we call the binary rather than bundling it, which is fine for local use. Revisit if the app is ever distributed with FFmpeg included.

## D-009 — faster-whisper for transcription
**Status:** Accepted (Phase 1)

- **Decision:** faster-whisper (MIT, CTranslate2-based Whisper) with word-level timestamps. Default model `small`, CPU `int8`; configurable.
- **Reasons:** Runs locally on CPU, optional NVIDIA GPU acceleration, multilingual, word timestamps needed for captions and clip boundaries.
- **Consequences:** CPU transcription of long videos can be slow; larger models are more accurate but slower. Model files download once (hundreds of MB to a few GB).

## D-010 — Ollama as default LLM, optional Gemini free tier
**Status:** Accepted (Phase 1)

- **Decision:** All LLM calls go through a provider interface in the media worker. Default provider: local Ollama with a 7–8B instruct model chosen in Phase 4 after testing on the owner's hardware. Optional provider: Google Gemini API free tier (key in `.env`, off by default).
- **Reasons:** Local = free and private. Gemini free tier can give better quality on weak hardware, but Google may use free-tier prompts to improve its products, its limits change, and it is not available in some regions — so it must be an explicit opt-in.
- **Consequences:** Output quality of small local models is acceptable for titles/hooks but imperfect for judging "interesting" moments; the UI always lets the user review and edit. Structured output uses JSON-schema-constrained generation, validated with pydantic, with one retry on invalid output.

## D-011 — Original videos use real stock footage, not generative video
**Status:** Accepted (Phase 1)

- **Context:** "Actual moving footage, not a slideshow" is required. Local text-to-video models need high-end GPUs and produce short, inconsistent clips; hosted video-generation APIs are paid.
- **Decision:** The generator writes a script (LLM), narrates it (Kokoro TTS — amended by D-051: Windows voices by default), finds matching **stock video clips** from the Pexels API (primary) and Pixabay API (optional), and assembles them with FFmpeg plus captions. Users can swap any scene's footage or upload their own clip.
- **Reasons:** Free (API keys only), real motion footage, licence terms that allow use in videos.
- **Consequences:** Footage relevance depends on keyword search; abstract topics may match poorly. Rate limits and attribution rules apply (`TECHNICAL_SPEC.md`). Generative video can be revisited as an optional experiment after v1.

## D-012 — Use YouTube's native scheduling (`status.publishAt`)
**Status:** Accepted (Phase 1)

- **Decision:** Scheduled videos are uploaded immediately as `private` with `status.publishAt`; YouTube makes them public at that time.
- **Reasons:** Works even when the creator's computer is off; no cron infrastructure.
- **Consequences:** Requires the Google Cloud project to pass the YouTube API compliance audit — uploads from unaudited projects are locked to private (see `SECURITY.md` and `TECHNICAL_SPEC.md`). Until then the app offers private uploads only (`YOUTUBE_API_AUDITED=false`).

## D-013 — Separate YouTube OAuth flow with encrypted tokens
**Status:** Accepted (Phase 1); implemented in Phase 7 over Google's REST endpoints (D-047)

- **Decision:** Channel connection uses Google OAuth 2.0 (authorization code + PKCE, offline access) via `google-auth-library`/`googleapis`, independent of app login. Refresh and access tokens are encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY` before being stored.
- **Reasons:** Least-privilege scopes, per-channel connections, tokens unreadable from a copied database file without the key.
- **Consequences:** Losing `TOKEN_ENCRYPTION_KEY` means reconnecting channels. While the Google project is in "Testing" mode, refresh tokens expire after 7 days, so the owner must reconnect weekly.

## D-014 — Kokoro-82M for narration (TTS)
**Status:** Accepted (Phase 1)

- **Decision:** Kokoro-82M (Apache-2.0 weights) via its Python package, running locally.
- **Reasons:** Good quality for its size, runs on CPU, permissive licence. Piper was considered but its maintained fork (`piper1-gpl`) is GPL-3.0 and depends on GPL espeak-ng.
- **Consequences:** Best quality in English; other languages are limited. Kokoro may need `espeak-ng` installed for some languages — verify in Phase 9. Pulls in PyTorch (large download).

## D-015 — Reframing with OpenCV YuNet + PySceneDetect
**Status:** Accepted (Phase 1); shot detection superseded by D-039 (Phase 5)

- **Decision:** Detect faces with OpenCV's built-in `FaceDetectorYN` (YuNet ONNX model from the OpenCV Zoo) on sampled frames, split shots with PySceneDetect, and compute a smoothed crop path per shot. Fallbacks: centre crop, or "fit with blurred background". Manual override always available.
- **Reasons:** Pure pip installs, CPU-friendly, permissive licences; avoids MediaPipe's Python-version wheel gaps.
- **Consequences:** Tracks faces, not general "subjects" (e.g. products, gameplay). Non-face content defaults to centre/blur modes.

## D-016 — Thumbnails: AI concepts + rendered mock-ups, no image generation
**Status:** Accepted (Phase 1)

- **Decision:** The LLM writes thumbnail concepts (composition, text, emotion). The worker renders 1280×720 mock-ups from real video frames with text overlays (Pillow + a bundled OFL font). No diffusion/image-generation models by default.
- **Reasons:** Free, fast, uses the creator's real footage; image models need a strong GPU or paid APIs.
- **Consequences:** Mock-ups are starting points; creators may finish thumbnails in their own editor and upload them.

## D-017 — UI kit: Tailwind CSS + shadcn/ui + Recharts
**Status:** Accepted (Phase 1)

- **Decision:** Tailwind CSS v4, shadcn/ui (copied Radix-based components), lucide-react icons, Recharts (via shadcn chart components), sonner toasts, TanStack Query only for client-side polling (jobs, uploads).
- **Reasons:** Professional look quickly, accessible primitives, components live in our repo (no lock-in).

## D-018 — Testing tools
**Status:** Accepted (Phase 1)

- **Decision:** Vitest (unit/integration), Playwright (end-to-end), pytest (worker). Test media generated on the fly with FFmpeg test sources instead of committing large files. External APIs are mocked in automated tests.
- **Reasons:** All free, fast, widely documented.

## D-019 — Local filesystem storage
**Status:** Accepted (Phase 1)

- **Decision:** Media lives in `STORAGE_DIR` (default `./storage`, git-ignored). The database stores paths **relative** to that directory; files use generated IDs, never original filenames.
- **Reasons:** Free, fast, simple backups; prevents path traversal and filename collisions.
- **Consequences:** Disk usage grows quickly (source videos + renders + models); the UI shows storage usage and allows cleanup of derived files.

## D-020 — Secrets only in `.env`, never in the database
**Status:** Accepted (Phase 1)

- **Decision:** API keys (Pexels, Pixabay, Gemini, Google client secret) are configured only in `.env`. The Settings page shows whether each is configured, never the value.
- **Reasons:** Smaller attack surface; no need to build a secret-editing UI in v1.
- **Consequences:** Changing a key requires editing `.env` and restarting.

## D-021 — User-facing product name must not use "YouTube"
**Status:** Accepted (Phase 1)

- **Context:** YouTube's API Services branding rules restrict using YouTube trademarks in the names of API clients, and Google's OAuth verification checks the app name and branding.
- **Decision:** "AI YouTube Employee" stays the internal project name. The displayed name comes from `NEXT_PUBLIC_APP_NAME` (default `Creator Studio Assistant`, changeable). YouTube logos appear only where the branding guidelines allow (e.g. the connect button, links to YouTube).
- **Consequences:** Re-check the current YouTube API Services Terms and branding guidelines before applying for the API audit (Phase 7/10).

## D-022 — Keep Next.js Cache Components; never cache the session
**Status:** Accepted (Phase 2)

- **Context:** Next.js 16.4 scaffolds with `cacheComponents` + `partialPrefetching` on (both become mandatory in the next major). Its "instant navigation" check wants session reads cached (`use cache: private`) so pages can be prefetched.
- **Decision:** Keep both flags. Do **not** cache session lookups: every signed-in page reads the session at request time behind `loading.tsx`/`<Suspense>`. Limit instant-navigation validation to segments that opt in (`experimental.instantInsights.validationLevel: "manual-warning"`), and set `instant = false` on the `(app)` and `(auth)` layouts.
- **Reasons:** A revoked or logged-out session must stop working immediately; a browser-side session cache could show pages for several minutes after revocation. Instant prefetching gives little benefit to a single-user localhost app.
- **Consequences:** Navigations wait for the server (fast on localhost). Server code that reads the database must run at request time (`requireUser()` or `connection()` first) or it may be prerendered at build time — see CLAUDE.md "Next.js 16 specifics". Revisit in Phase 10.

## D-023 — Navigation names and routes
**Status:** Accepted (Phase 2) — refines UI_UX.md naming from Phase 1

- **Decision:** Sidebar labels follow the owner's names: Dashboard `/dashboard`, Videos `/videos`, AI Clip Finder `/clip-finder`, Shorts Editor `/shorts`, AI Packaging `/packaging`, YouTube `/youtube`, Analytics `/analytics`, Original Video Generator `/generator`, Settings `/settings`. Every item links to a working page; unbuilt features show a clearly labelled placeholder with the phase that delivers them (single source: `src/lib/navigation.ts`).
- **Reasons:** Clearer names for creators; working links instead of disabled items make the roadmap visible and testable.
- **Consequences:** "YouTube" as a nav label is descriptive use only; the app name and logo stay unbranded (D-021).

## D-024 — UI building blocks chosen at scaffold time
**Status:** Accepted (Phase 2)

- **Decision:** shadcn/ui "radix-nova" preset (Radix primitives, Lucide icons) with its official `cn` class-merging package; Geist fonts from the `geist` npm package (bundled, no Google Fonts download); `next-themes` for light/dark/system; `sonner` toasts. TanStack Query is deferred to Phase 3 (no client polling exists yet).
- **Reasons:** Fonts load offline and builds don't need internet; all packages are MIT/OFL and maintained by the shadcn/Vercel ecosystem.

## D-025 — Explicit Better Auth security settings
**Status:** Accepted (Phase 2) — details for D-004

- **Decision:** Set explicitly in `src/server/auth.ts`: rate limiting **always on** (Better Auth enables it only in production by default) — sign-in 5/min, sign-up 3/min, change-password 5/min; origin check always on (`advanced.disableOriginCheck: false`, otherwise skipped in test environments); telemetry off; sessions 7 days. Sign-in, sign-up and password changes go from the browser through `/api/auth/*` so these protections apply.
- **Consequences:** On localhost Better Auth can't see a client IP, so all attempts share one rate-limit bucket per endpoint (it logs a one-time warning). That is acceptable for a single-owner local app.

## D-026 — Content Security Policy without nonces (for now)
**Status:** Accepted (Phase 2) — temporary deviation from SECURITY.md §5

- **Decision:** CSP is set in `next.config.ts` with `script-src 'self' 'unsafe-inline'` (plus `'unsafe-eval'` and websockets in development only).
- **Reasons:** Next.js injects inline bootstrap scripts; nonce-based CSP requires per-request nonces generated in the proxy, which conflicts with prerendered shells and adds complexity before there is any user-generated HTML.
- **Consequences:** XSS protection relies on React escaping and the no-`dangerouslySetInnerHTML` rule. Nonce-based CSP is a Phase 10 hardening task.

## D-027 — Dependency audit handling
**Status:** Accepted (Phase 2)

- **Decision:** Override `mysql2` to 3.24.6 (pulled in by the Prisma CLI and an optional Better Auth peer; we never use MySQL). Accept the remaining `npm audit` findings, which are all in build/CLI tooling with no non-breaking fix: `braces`/`micromatch`/`fast-glob` (ESLint and shadcn CLI glob matching of our own patterns) and `deepmerge-ts` (Prisma CLI config loader merging our own config file).
- **Reasons:** None of these process untrusted input in this app; the suggested "fixes" are major downgrades.
- **Consequences:** Re-run `npm audit` at the end of every phase (SECURITY.md §10) and drop this entry once upstream fixes ship.

## D-028 — Node integration worker deferred to Phase 7
**Status:** Accepted (Phase 3) — changes the timing in D-007 and ROADMAP Phase 3

- **Context:** The roadmap planned a Node worker skeleton in Phase 3, but no `yt.*` jobs exist before Phase 7.
- **Decision:** Build the Node integration worker in Phase 7 together with its first real job (`yt.upload`). The job queue (`src/server/jobs/queue.ts`) already avoids Next.js imports so that worker can reuse it.
- **Reasons:** A process with nothing to do is extra complexity and one more thing for the owner to start.

## D-029 — Upload design: chunks written in place, markers on disk
**Status:** Accepted (Phase 3)

- **Decision:** The browser sends 10 MB chunks (`PUT /api/uploads/{id}/chunks/{n}`) with XHR (for byte-level progress) and retries each chunk up to 4 times with back-off. The server streams each chunk straight to its offset in `uploads/tmp/{id}/data.bin` and then writes a `{n}.ok` marker. Markers on disk are the source of truth for resuming. Completing checks the size and the file's magic bytes, then *renames* `data.bin` to `videos/{videoId}/source.{ext}` (no copy) and creates the `Video` + `media.ingest` job in one transaction. Uploads expire after 24 h idle; a sweep (on new uploads and library loads) deletes expired data and orphaned temp folders older than 1 h.
- **Reasons:** No assembly step or extra disk space for large files; resuming survives app restarts; nothing is buffered whole in memory.
- **Consequences:** Resuming after a page reload needs the user to pick the same file again (browsers can't keep file access). Storage is local only; the storage module's relative paths keep it adaptable to other backends later.

## D-030 — Ingest outputs: poster always, preview only when needed
**Status:** Accepted (Phase 3)

- **Decision:** The worker validates with ffprobe (a real video stream, ≤ `MAX_VIDEO_DURATION_MIN`), extracts a 640 px-wide poster (at 10 % of the video, max 5 s in), and creates `preview.mp4` (H.264 CRF 23, AAC, longest side ≤ 1280 px, faststart) only when browsers can't play the original reliably: anything that isn't MP4/M4V with H.264/AV1/VP9 + AAC/MP3/Opus or WebM with VP8/VP9/AV1 + Opus/Vorbis, and any non-4:2:0 8-bit video (e.g. 10-bit). MOV, MKV and AVI always get a preview. The original is never modified.
- **Consequences:** Files that turn out not to be videos (or are too long) are marked failed with a reason and their source file is deleted; the record stays so the user sees what happened.

## D-031 — Simple polling instead of TanStack Query
**Status:** Accepted (Phase 3) — amends D-024

- **Decision:** The activity drawer polls `GET /api/jobs` (every 2 s while jobs are active or the drawer is open, otherwise 10 s), and pages showing processing videos call `router.refresh()` every 2–3 s. No TanStack Query dependency.
- **Reasons:** Two small polling loops don't justify another library; server components already render the data.

## D-032 — Job queue parameters
**Status:** Accepted (Phase 3) — details for D-006

- **Decision:** Claim = find the oldest queued job of the requested types, then a conditional `updateMany` (status still `queued`) as compare-and-set. Lease 60 s, extended by job heartbeats (the worker sends one at least every ~5 s, also while FFmpeg is busy). Retryable failures go back to `queued` with back-off 15 s × attempt; max 3 attempts. Expired leases are recovered on every claim. Workers must hold the job (`lockedBy`) to report progress or results. Results are validated per job type (Zod) and persisted in the same transaction that marks the job done.

## D-033 — Defaults chosen for low-end hardware (4 GB RAM, 2-core CPU, no GPU)
**Status:** Accepted (Phase 4) — resolves the model choice left open in D-009/D-010

- **Context:** The owner's PC has 3.9 GB RAM, an Intel i5-3210M (2012, AVX, no AVX2) and no dedicated GPU. A 7–8B model (~5 GB) can't run.
- **Decision:** Ollama with **qwen2.5:1.5b** (~1 GB, Apache-2.0) as the default clip-rating model, and faster-whisper **base** (int8, CPU) for transcription. Both are configurable in `.env`; `.env.example` lists bigger models for stronger machines.
- **Measured on this PC:** whisper `base` ≈ 1.9× real time (100 s of speech in ~52 s; `tiny` ≈ 3.7×); qwen2.5:1.5b ≈ 8 tokens/s output, about 30–40 s per rated moment, so 12 moments take ~4–6 minutes.
- **Consequences:** Suggestions are usable but the small model's judgement is rough (scores bunch together, categories are often "story", hooks may paraphrase). The UI says so and always names the model. Owners with 16 GB RAM should switch to an 8B model.

## D-034 — Clip finding: transcript-cut candidates, AI rates them
**Status:** Accepted (Phase 4)

- **Decision:** The worker cuts candidate windows only at real sentence boundaries from transcript word timings (sentence-ending punctuation or pauses ≥ 0.8 s), between `CLIP_MIN_SEC` and `CLIP_MAX_SEC`. Each gets an explainable speech-pattern score (pace vs the speaker's median, loudness vs the video's median, questions/exclamations/numbers, a clean start after a pause, length). A shortlist that covers the whole video evenly (`CLIP_AI_CANDIDATES`) is rated by the AI, which returns score, title, hook, reason and category as schema-validated JSON. Final score = 70 % AI + 30 % speech patterns; the best non-overlapping clips are kept (`CLIP_MAX_SUGGESTIONS`). Default one excerpt per AI request (`CLIP_AI_BATCH_SIZE=1`) because the 1.5B model mixed excerpts up in batches of four.
- **Reasons:** The AI can never invent timestamps; long videos are covered evenly; the cost (time) is bounded and configurable; every number shown is traceable.
- **Consequences:** The AI only sees text, not the picture, so visual-only moments are missed; the owner can always make a clip by hand from the transcript.

## D-035 — Providers are swappable; no silent fallback from AI
**Status:** Accepted (Phase 4) — replaces the automatic fallback in REQUIREMENTS CLIP-08

- **Decision:** Transcription (`TRANSCRIPTION_PROVIDER`, faster-whisper for now) and clip-rating AI (Ollama, Gemini, any OpenAI-compatible server) sit behind small provider interfaces in the worker. The owner picks the AI in Settings › AI & processing; keys and model names stay in `.env`. "Speech patterns only (no AI)" is an explicit choice, labelled everywhere as no-AI. If the chosen AI isn't ready (Ollama stopped, model not pulled, Gemini key missing), the app refuses to start and shows the fix; a failure during the job is reported with its reason — it never quietly substitutes non-AI results.
- **Reasons:** Results must never be presented as AI analysis when they aren't; providers can change later to control quality and cost.
- **Consequences:** Gemini and OpenAI-compatible providers are implemented and unit-tested against simulated HTTP, but not exercised live (no key/server here).

## D-036 — Windows runtime requirements for local speech recognition
**Status:** Accepted (Phase 4)

- **Decision:** faster-whisper's engine (CTranslate2) needs the Microsoft Visual C++ Redistributable 2015–2022 (x64) — installed with `winget install Microsoft.VCRedist.2015+.x64` (admin prompt). Audio is decoded by our own FFmpeg into 16 kHz WAV and passed to Whisper as samples, in 10-minute pieces, instead of using faster-whisper's bundled decoder (PyAV), whose newest release is incompatible with faster-whisper 1.2.1. Speech models download once from Hugging Face into `models/whisper` (git-ignored).
- **Consequences:** Long videos use little memory; the status page reports when the speech engine can't load and how to fix it.

## D-037 — Accepted clips are the Shorts Editor's input queue
**Status:** Accepted (Phase 4)

- **Decision:** Accepting a clip marks it `accepted`; the Shorts Editor page lists accepted clips as "ready for editing". Phase 5 creates `Short` records from them. No `Short` table yet.
- **Reasons:** Hands clips over without building Phase 5 early.

## D-038 — Heartbeats during long blocking steps
**Status:** Accepted (Phase 4) — extends D-032

- **Decision:** `JobContext.keepalive()` sends heartbeats from a background thread while a single step blocks (model loading/downloading, an AI reply that takes a minute), so the 60 s lease doesn't expire. Cancellation requested meanwhile is honoured when the step returns.

## D-039 — Shot cuts detected in the worker, not with PySceneDetect
**Status:** Accepted (Phase 5) — supersedes the PySceneDetect part of D-015

- **Decision:** `media.reframe` decodes the Short's range once (FFmpeg → 320 px frames at up to 15 fps) and uses those frames twice: a cut detector (average HSV change between consecutive frames on a 64×36 thumbnail, threshold 30, shots ≥ 1 s — the same measure as PySceneDetect's ContentDetector) and YuNet face detection on ~5 frames per second. Only `opencv-python-headless` is added.
- **Reasons:** PySceneDetect 0.7 hard-depends on the GUI build `opencv-python`; installing both OpenCV builds puts two copies of `cv2` in one environment, and removing either deletes the other's files (seen during setup). Reusing the already-decoded frames also halves decoding work on slow CPUs and gives cut times at the analysis frame rate.
- **Consequences:** Very gradual transitions (long fades) may not count as cuts; the crop then slides instead of jumping. Tested in `tests/test_tracking.py`.

## D-040 — Captions: bundled Geist fonts, one set of numbers for preview and export
**Status:** Accepted (Phase 5)

- **Decision:** Captions are drawn by libass from a generated `.ass` file (1080×1920 play resolution, centre-positioned with `\pos`). The fonts are Geist Bold, Geist Black and Geist Mono Bold (SIL OFL), copied from the `geist` npm package into `media-worker/assets/fonts/` with the licence; the editor preview uses the same family from the app's own font. `src/lib/shorts/caption-style.ts` turns a style into exact numbers (size, outline/box padding, position, alpha) used by both the export payload and the CSS preview, including libass's font-size convention (ascent + descent = size). User text is escaped so it can't inject ASS override codes. At least four presets; "highlight" (SHORT-04) is implemented as outline or box backgrounds — word-by-word karaoke highlighting is not built.
- **Reasons:** SHORT-06 (preview ≈ export) without a second rendering engine; no font downloads; licences allow redistribution.
- **Consequences:** Line wrapping can differ slightly (libass vs the browser's balanced wrapping) on long captions; captions are chunked to 1–4 words so this is rare. Emoji render as single-colour glyphs from a system font.

## D-041 — Export settings and "out of date" detection
**Status:** Accepted (Phase 5)

- **Decision:** One FFmpeg pass: accurate seek (`-ss` before `-i` with `-t`), crop or blur → 1080×1920, captions via the `ass` filter, `libx264` `yuv420p` + AAC 48 kHz 160 kbps stereo, `+faststart`, frame rate kept (capped at 60). Quality "Standard" = preset `veryfast` CRF 20 (default, quick on slow CPUs); "High" = `medium` CRF 18. Each export gets a new file name (`shorts/{id}/render-{n}.mp4`), older files are removed before the next export. The app hashes everything that affects the picture/sound (range, framing keyframes, captions, style, hook, quality) when queuing an export; a Short is "out of date" when the current hash differs from the exported one (SHORT-07) — renaming the title doesn't count, undoing an edit clears it.
- **Reasons:** Predictable speed on the owner's 2-core laptop (D-033); a new file name avoids replacing a file the browser is still streaming on Windows.
- **Consequences:** Exports are re-encoded even when nothing but captions changed (no smart rendering).

## D-042 — Face tracking runs ahead of time, a little beyond the Short
**Status:** Accepted (Phase 5)

- **Decision:** Auto framing is computed by a separate `media.reframe` job when a Short is created (or when its range leaves the analysed part, or Auto is chosen again). It analyses 10 s beyond each end and stores crop-centre keyframes in source-video time, so trims within that margin need no new analysis. The editor previews the path with CSS; the export turns the same keyframes into an FFmpeg `crop` expression. Shots without a face stay centred and the warnings say so. Export on Auto waits until the analysis covers the range.
- **Reasons:** Instant preview while editing; exports don't repeat face detection.
- **Consequences:** One main face per shot (largest and most consistently visible); switching between two speakers within a shot isn't followed.

## D-043 — Packaging: small steps, grounded in the transcript, checked in code
**Status:** Accepted (Phase 6)

- **Decision:** `ai.package` asks the configured provider (D-035) in separate small requests — titles + hooks, description + hashtags, thumbnail concepts, chapter names — each validated against a JSON schema with one retry. Input is the transcript (a Short uses its own, possibly corrected, captions); transcripts over `PACKAGING_MAX_INPUT_WORDS` (1,500) are summarised part by part first. The AI never produces times: chapter starts are transcript segment starts (first at 0:00, ≥ 3 chapters, ≥ 30 s apart, only for videos ≥ 3 min) and thumbnail frames are excerpts the AI picks by id. After generation, code enforces YouTube's limits (title ≤ 100 characters, description ≤ 5,000 bytes, no `<`/`>` — confirmed in the YouTube Data API videos resource), keeps at most 15 hashtags and drops hashtags none of whose words appear in the transcript, title or notes (reported to the user), and flags — without removing — numbers that aren't in the transcript, sensational phrases ("you won't believe", "shocking", …), all-capitals text, placeholders like "[Name]", and capitalised names in descriptions/hooks that aren't in the transcript (the local model once called the speaker "President Biden" in a 2009 address that never names him). Hooks that repeat a title are dropped; `#Shorts` is never added to long videos.
- **Reasons:** Small local models (qwen2.5:1.5b on the owner's laptop) follow small, concrete tasks far better than one large schema; checks in code catch what a prompt can't guarantee.
- **Consequences:** Generation makes 3–4 requests (more with summaries), ~1–4 minutes on the owner's CPU. The checks are simple word matching: a rephrased fact isn't flagged, and a legitimately general hashtag may be dropped (the creator can add it back).

## D-044 — Thumbnails are real frames, mock-ups or uploads (extends D-016)
**Status:** Accepted (Phase 6)

- **Decision:** `media.thumbnail_mockup` makes three kinds: a video frame, a frame with a headline drawn with Pillow in Geist Black (shrunk and wrapped to ≤ 3 lines, over a soft dark gradient), or the creator's uploaded JPEG/PNG (checked by content in the app, decoded and re-encoded by Pillow in the worker, which removes metadata; the original is deleted). All are cropped to 1280×720 for videos and **720×1280 for Shorts** (vertical; the spec only named 1280×720) and saved as JPEG under 2 MB. The UI labels them "Video frame", "Mock-up: video frame + your text" or "Your image" and says that no AI image generation is used; AI thumbnail concepts are shown as text only.
- **Reasons:** No paid image APIs or GPU; never present a concept as a generated image.
- **Consequences:** Whether YouTube shows a custom thumbnail for a Short depends on YouTube — to be checked when publishing is built (Phase 7).

## D-045 — Packaging versions are editable; one is "yours"
**Status:** Accepted (Phase 6)

- **Decision:** Each generation is a `PackagingSet`; regenerating (with optional notes) adds a new one and keeps the old ones (PKG-04). The set holds an editable working copy plus the generated original (`generatedJson`) so the UI can show "AI suggestion" vs "Edited by you"; edited items drop the AI's warnings. "Use this packaging" marks one set per video/Short as preferred — Phase 7 will prefill publishing from it and from the chosen thumbnail. Channel style notes (Settings › AI & processing) and the video's own notes are passed to every generation (PKG-07).
- **Reasons:** Creators compare and mix suggestions; nothing they wrote is overwritten.

## D-046 — A fake AI server for end-to-end tests
**Status:** Accepted (Phase 6)

- **Decision:** Playwright starts `tests/e2e/fixtures/fake-llm-server.mjs`, an OpenAI-compatible endpoint that answers packaging prompts with deterministic JSON built from words in the prompt's transcript, and points the app's `openai_compatible` provider at it (test environment only). Unit/integration tests configure the same provider without contacting it.
- **Reasons:** Exercises the real provider path, validation and UI in minutes; real local-model quality is checked manually (TESTING.md §3.6).

## D-047 — Official Google endpoints over `fetch` instead of the `googleapis` package
**Status:** Accepted (Phase 7) — refines D-007 and D-013

- **Decision:** OAuth (authorization endpoint, token, revoke) and the YouTube Data API v3 calls the app needs (`channels.list`, resumable `videos.insert`, `thumbnails.set`) are made with `fetch` against Google's documented endpoints, in `src/server/youtube/` (config, oauth, client, quota, upload). No Google SDK is added.
- **Reasons:** Only five endpoints are needed; the `googleapis` package is very large; plain `fetch` lets every call be tested against a local stand-in (D-050) and keeps token handling in one small module.
- **Consequences:** The resumable upload protocol (308 + `Range`, status queries, expiry) is implemented here and covered by tests; API changes must be followed by hand (revision history checked 2026-10-14).

## D-048 — Private-only uploads until the owner marks the project audited
**Status:** Accepted (Phase 7) — keeps D-012

- **Context:** Google's documentation disagrees with itself (checked 2026-10-14): the API revision history (28 Jul 2020) says uploads through unaudited projects created after that date are restricted to private viewing; the current `videos` reference pages say videos from unverified projects are *not* restricted to private.
- **Decision:** Follow the stricter statement (and YT-05): with `YOUTUBE_API_AUDITED=false` the app offers private uploads only and no scheduling, and says why. After every upload it records and shows the privacy YouTube actually applied (`actualPrivacyStatus`), with a warning if it differs from the request. `publishAt` is always sent together with `private` (required by the API).
- **Consequences:** Owners whose projects really can upload publicly must flip the flag themselves (after the audit). Revisit when Google's pages agree.

## D-049 — The YouTube worker shares the database and token module
**Status:** Accepted (Phase 7) — implements D-007/D-028

- **Decision:** `src/worker/index.ts` (run with `tsx --conditions=react-server`, which turns `server-only` imports into no-ops) claims `yt.upload` jobs directly through `src/server/jobs/queue.ts` and reads tokens only through `src/server/youtube/oauth.ts`. Job payloads contain just `{ publicationId }`. The resumable session URI (it grants upload access to that video for a while) is stored encrypted on the `Publication`, so a retried job resumes instead of starting over. Uploads use chunks of `YOUTUBE_UPLOAD_CHUNK_KB` (8 MB default, multiples of 256 KB as Google requires) and, after any interruption, ask YouTube how much arrived before continuing (up to 6 retries with backoff).
- **Reasons:** Tokens never cross a process boundary or the worker API; long uploads survive network drops and restarts.
- **Consequences:** `npm run dev:all` now starts three processes.

## D-050 — A local Google stand-in for automated tests
**Status:** Accepted (Phase 7)

- **Decision:** `tests/support/fake-google.mjs` implements the parts of Google's OAuth and YouTube API the app uses (code + PKCE checks, refresh, revoke, `channels.list`, resumable upload with 308/`Range`, `thumbnails.set`) with switches for failures (dropped connection, `invalid_grant`, API errors, forced private). Vitest replaces `fetch` with it; Playwright runs it as a server. The app talks to it only when `GOOGLE_API_TEST_BASE_URL` is set, which accepts **only** `http://127.0.0.1` / `http://localhost` addresses (so credentials can't be sent elsewhere) and shows a "Test mode" warning in the UI and on System status.
- **Consequences:** Automated tests prove the app's side of the protocol, not that Google accepts it; a manual test with a real channel remains required (TESTING.md §3.7).

## D-051 — Narration with Windows' built-in voices; Kokoro optional (amends D-011)
**Status:** Accepted (Phase 9)

- **Context:** D-011 planned Kokoro TTS. Kokoro needs PyTorch (≈1.5–2 GB of downloads) on a 3.9 GB RAM, no-GPU PC, and it doesn't report word timings, so captions would need a Whisper pass over every narration.
- **Decision:** `TTS_PROVIDER=sapi` (default) uses Windows' System.Speech voices through a PowerShell script run with an argument list (`media_worker/generator/sapi_speak.ps1`). The script records 16 kHz mono WAV and the engine's `SpeakProgress` word positions — at 24 kHz the reported positions drift, at 16 kHz they match the audio (measured). `TTS_PROVIDER=kokoro` stays available as an optional local provider (installed separately, not in the lockfile) and gets evenly spread word timings labelled "estimated". `TTS_VOICE` in `.env` is only a default: a Windows voice that isn't installed falls back to the default voice; a voice chosen for a project must exist.
- **Reasons:** Free, offline, nothing to download, fast on a weak CPU, exact caption timing.
- **Consequences:** Voices sound robotic and are English on this PC. Kokoro is untested here. The narration is synthetic, so publishing defaults the disclosure to "yes" (D-055).

## D-052 — Footage: stock video, the creator's library or uploaded clips; never stills or generated video
**Status:** Accepted (Phase 9) — extends D-011

- **Decision:** Each scene's footage is one of: a Pexels/Pixabay clip (searched by `gen.footage`, up to 5 ranked candidates, the best one downloaded from the provider's own media host into `stock-cache/`, searches cached 24 h), part of a ready library video (from a chosen start time), or a clip the creator uploads (MP4/MOV/M4V/WebM/MKV, ≤ 500 MB, streamed to disk and checked by its first bytes). Before rendering, the worker probes every clip and samples frames: footage whose frames don't change is refused with the scene number ("still images aren't allowed").
- **Reasons:** The owner has no stock key yet, and library footage keeps the feature useful without one. The motion check enforces "no slideshow" in code instead of by convention. AI video generation is not used: hosted APIs are paid and local models need a GPU.
- **Consequences:** Without a key, footage relevance depends on what the creator owns. Stock search and download are tested with mocks only until a key is configured.

## D-053 — Render: one segment per scene, crossfades at narration boundaries
**Status:** Accepted (Phase 9)

- **Decision:** `gen.render` cuts each scene's clip to its narration length + 0.4 s (looping clips that are too short), scales/crops it to the target frame (9:16 or 16:9, 720p or 1080p, 30 fps), then joins the segments with `xfade` at offsets equal to the cumulative narration lengths, so every scene's narration starts exactly when its picture is fully in. Narration is concatenated as-is; optional music loops at the chosen level and is ducked with `sidechaincompress`. Captions come from each scene's word timings, shifted by the scene's start and never crossing scenes, styled with the owner's default caption style scaled to the frame. The result becomes a library `Video` (`sourceType = generated`) that goes through normal processing.
- **Reasons:** Exact sync between voice, picture and captions; reuses the Shorts caption renderer (D-040) and the library pipeline.
- **Consequences:** The video is one transition (0.4 s) longer than the narration. Every render adds a new library video; the project points to the latest.

## D-054 — The script must be approved before anything is produced
**Status:** Accepted (Phase 9)

- **Decision:** `gen.script` only drafts. The creator edits, reorders, adds and removes scenes, and must approve the script (with a fact-check warning) before narration and footage searches start. Narration remembers the text it was made from; editing a scene afterwards marks its narration out of date and blocks rendering until it's recorded again.
- **Reasons:** AI scripts can contain wrong facts (GEN-02); out-of-date narration would silently mismatch the script.

## D-055 — Credits and the synthetic-media disclosure for generated videos
**Status:** Accepted (Phase 9)

- **Decision:** The render stores a credits text (each stock creator with the provider page, the licence, "own footage" when used, and the synthetic voice) in `Video.creditsText` — not in `notes`, which feed AI packaging. The publish form appends it to the description and defaults "altered or synthetic content" to "yes" for generated videos and Shorts cut from them, with an explanation; the creator can change both.
- **Reasons:** Pexels' API guidelines ask for credit to Pexels and creators; a synthetic narrator is the kind of content YouTube asks creators to disclose.

## D-056 — Job state changes are compare-and-set; results are reported again on transient errors
**Status:** Accepted (Phase 10) — refines D-032

- **Context:** The Phase 10 audit found races: lease recovery, results and cancellations updated jobs by id only, so a slow worker could apply a result after its job was handed to another worker, and two processes recovering the same expired lease could requeue it twice. Services checked "already running?" before, not inside, the transaction that queued work, so a double click could queue two renders or two YouTube uploads. One failed heartbeat or result report threw away finished work.
- **Decision:** Every job transition is an `updateMany` with the expected state (`status: "running", lockedBy: worker` for worker reports; `leaseExpiresAt < now` for recovery; `status: "queued"` for cancelling) and only takes effect when exactly one row changed. `completeJob` marks the job done as the first statement of its transaction, then persists the result; a result the handler can't save fails the job (`RESULT_REJECTED`) instead of re-running it, while busy-database errors let the worker report again. "One active job per item" checks run inside the queuing transaction (`assertNoActiveJob`; the generator claims its project status with a conditional update) — Prisma's SQLite adapter runs interactive transactions one at a time per process, and only the app process queues these jobs. The Python worker retries `complete`/`fail` three times (1, 3, 8 s) on network or server errors, treats a failed heartbeat as non-fatal (the 60 s lease covers short outages) and stops only on 409 (job no longer its own).
- **Consequences:** Tests cover duplicate reports, concurrent recovery, late failure reports and double-clicked renders. Leases are also recovered by the activity list (at most every 30 s), so a dead job is finished even when no worker runs.

## D-057 — Housekeeping task instead of deleting files inline
**Status:** Accepted (Phase 10)

- **Decision:** `src/server/maintenance.ts` runs in the Node worker at start and every `MAINTENANCE_INTERVAL_MIN` (60): recover expired leases, expire abandoned uploads, remove `videos/`, `shorts/`, `generator/` folders and thumbnails whose record is gone, old narration takes / replaced clips / music of idle generator projects, uploaded thumbnail originals no longer being processed, search-cache files older than 24 h and stock clips no scene uses for `STOCK_CACHE_DAYS` (14). Rules: inside `STORAGE_DIR` only, files older than one hour only, never anything of an item with an active job or a render in progress. Deletes in services retry briefly (Windows file locks) and never fail the user's action; whatever is left is removed by the next run.
- **Reasons:** Deleting a file a render might still read (a replaced clip) is unsafe inline; a sweep based on "what does the database still reference" also repairs past failures and crashes.
- **Consequences:** Disk space is reclaimed with up to an hour's delay. The worker must run for housekeeping (it runs with `start:all`/`dev:all`).

## D-058 — Production run, backups and secret checks as npm scripts
**Status:** Accepted (Phase 10)

- **Decision:** `npm run start:all` runs `next start` plus both workers (the YouTube worker with `--production`), with `scripts/start-windows.cmd` as a one-click start. `npm run backup` writes `backups/backup-<time>/` with an online SQLite copy (better-sqlite3 `backup()`, integrity-checked), the storage folder without temporary files (`--no-media` leaves out videos and renders) and a manifest; `.env` only with `--include-env`. `npm run restore` refuses while the app answers on its URL and moves the current data aside instead of deleting it. `npm run check:secrets` scans the built browser bundle for configured secret values and checks that Git would not include `.env`, databases, storage, backups or credential files. `better-sqlite3` (MIT, already installed through Prisma's adapter) is now a direct dependency because the scripts import it.
- **Reasons:** One owner on one Windows PC: plain commands, no extra services, nothing that can lose data by mistake.

## D-059 — Abuse protection for a localhost-only app
**Status:** Accepted (Phase 10) — amends SECURITY.md §2/§5

- **Context:** Better Auth keys rate limits on `X-Forwarded-For`, which Next.js only fills in when the client didn't send it, so a local script could send a new fake IP with every password guess. The worker API's loopback check reads the same header.
- **Decision:** The auth route sets `X-Forwarded-For: 127.0.0.1` before Better Auth sees the request: every sign-in attempt shares one bucket (5 per minute), which fits a single-owner app on one computer. Password changes must send `revokeOtherSessions: true` (enforced server-side). First-run sign-up writes a fixed-id `OwnerLock` row, so two simultaneous sign-ups can't create two owners. `GOOGLE_API_TEST_BASE_URL` is ignored (and reported) in production runs. The worker API's real "this computer only" control is the localhost binding; the header check is documented as catching proxied requests only.
- **Consequences:** If the app were ever put behind a proxy for several users, rate limiting by client IP would need a trusted proxy setting instead (out of scope: the app must not be exposed to the internet, DEPLOYMENT.md §7).

## D-060 — Resource limits on a 4 GB, 2-core computer
**Status:** Accepted (Phase 10)

- **Decision:** `RENDER_THREADS` now applies to every FFmpeg run through `media_worker.ffmpeg` (decoders, filters and encoder) and to the speech model, not only to exports. The speech model is released after each transcription unless `WHISPER_KEEP_LOADED=true`. The generator joins scenes in batches of at most 8 inputs (measured at 1080×1920: 30 inputs in one pass peaked at 2.1 GB, 8 inputs at 1.0 GB). FFmpeg's own error text goes to the worker log, not to the user (it contains file paths); face-tracking decodes have a stall watchdog. Python logs pass through a filter that masks `key=`, `token=`, `Bearer …`; Node logs also mask such text inside messages, stacks and error causes, and AppError causes are logged.
