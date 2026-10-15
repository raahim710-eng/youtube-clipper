# Technical Specification

Technologies, dependencies, external services, and how each feature is implemented. Reasons for choices are in `DECISIONS.md`; process structure is in `ARCHITECTURE.md`; tables in `DATABASE_SCHEMA.md`.

## 1. Runtime prerequisites

| Tool | Version policy | Needed from | Notes |
|---|---|---|---|
| Node.js | 24 LTS | Phase 2 | Installed (v24.14.1). |
| npm | Bundled with Node | Phase 2 | Installed (11.x). |
| Git | Any recent | Phase 2 | Installed. |
| uv | Latest stable | Phase 3 | Installed (0.13). Manages Python 3.12 and the worker's packages. Windows: `winget install astral-sh.uv`. |
| FFmpeg + ffprobe | 7.x or newer, **with libass** | Phase 3 | Installed (9.0.2 full build). Windows: `winget install Gyan.FFmpeg` (full build includes libass, libx264, libx265). |
| Ollama | Latest stable | Phase 4 | Local LLM server on `127.0.0.1:11434`. |
| NVIDIA GPU + CUDA 12 / cuDNN 9 | Optional | Phase 4 | Speeds up faster-whisper and Kokoro. Everything works on CPU, more slowly. |
| Windows speech (System.Speech, built into Windows) | Built in | Phase 9 | Default narration voices (D-051), driven through Windows PowerShell 5.1. Other OSes need `TTS_PROVIDER=kokoro`. |

Version pinning: exact versions are fixed in `package.json` (no `^`) and `package-lock.json` / `uv.lock`. This document lists packages and major versions only. `package.json` also overrides `mysql2` (D-027).

## 2. Dependencies

### 2.1 Web app and Node worker (npm)

| Package | Purpose | Phase |
|---|---|---|
| `next` (16.4), `react`, `react-dom` (19.3) | Framework (App Router, Cache Components, Turbopack) | 2 |
| `typescript`, `@types/*` | Types | 2 |
| `tailwindcss` v4 (+ `@tailwindcss/turbopack`), `shadcn` (CLI + base CSS, "radix-nova" preset), `radix-ui`, `cn`, `class-variance-authority`, `tw-animate-css`, `lucide-react`, `sonner`, `next-themes`, `geist` (bundled fonts) | UI | 2 |
| `prisma`, `@prisma/client` (7.10), `@prisma/adapter-better-sqlite3` (brings `better-sqlite3`), `dotenv` | ORM + SQLite driver (Prisma 7 requires a driver adapter; client generated to `src/generated/prisma`; CLI config in `prisma.config.ts`) | 2 |
| `better-auth` (1.7) | App authentication | 2 |
| `zod` (v4) | Validation | 2 |
| `server-only` | Guards server modules | 2 |
| (none) | Client polling is plain `fetch` + `router.refresh()` (D-031) | 3 |
| `tsx` | Runs the Node worker | 3 |
| `concurrently` | `npm run dev:all` | 3 |
| `googleapis` (includes `google-auth-library`) | YouTube Data API v3, YouTube Analytics API v2, OAuth | 7 |
| `recharts` (via shadcn chart) | Analytics charts | 8 |
| Dev: `typescript` 5.9, `eslint` 9 + `eslint-config-next`, `prettier`, `vitest` 5, `@playwright/test`, `tsx` | Quality/testing, scripts | 2 |
| Dev (later, when component tests are needed): `@testing-library/react`, `jsdom` | Component tests | 3+ |

### 2.2 Media worker (Python 3.12, `uv`)

| Package | Licence | Purpose | Phase |
|---|---|---|---|
| `httpx` | BSD | Internal worker API (later also Ollama, Pexels, Pixabay, Gemini) | 3 |
| `pydantic`, `pydantic-settings` | MIT | Payload/result models, env config | 3 |
| `faster-whisper` (1.2, CTranslate2) | MIT | Local transcription with word timestamps (needs the MSVC runtime on Windows, D-036) | 4 |
| `numpy` | BSD | Audio samples for Whisper, loudness envelope | 4 |
| `opencv-python-headless` (5.0) | Apache-2.0 | YuNet face detection (`cv2.FaceDetectorYN`), frame thumbnails for shot cuts | 5 |
| `Pillow` (12.3) | HPND (permissive) | Thumbnail mock-ups, re-encoding uploaded thumbnails | 6 |
| `kokoro` (+ PyTorch, `soundfile`) — **optional, not in `uv.lock`** | Apache-2.0 | Alternative local narration (`TTS_PROVIDER=kokoro`), about 1.5–2 GB; install with `uv pip install --python media-worker/.venv kokoro soundfile`. Not installed or tested on the owner's PC (D-051). | 9 |
| Dev: `pytest`, `ruff` | MIT | Tests, lint/format | 3 |

PySceneDetect was planned for shot detection but not added: version 0.7 requires the GUI build of OpenCV, which conflicts with the headless build (D-039).

Assets committed to the repo: Geist Bold, Geist Black and Geist Mono Bold (SIL OFL, from the `geist` npm package, licence included) in `media-worker/assets/fonts/` for captions (D-040). Downloaded at first use (not committed): YuNet ONNX model (`face_detection_yunet_2023mar.onnx`, OpenCV Zoo, MIT, SHA-256 checked) into `FACE_MODELS_DIR`, Whisper models, Kokoro weights.

## 3. External services

All are free at the time of writing. Limits change; the app must handle quota errors gracefully.

| Service | Needed for | Credentials | Free limits / conditions | Risk of future cost |
|---|---|---|---|---|
| **YouTube Data API v3** | Channel info, video lists, uploads, scheduling, thumbnails | Google Cloud OAuth client (Web application) | Default **10,000 units/day** per project, reset at midnight Pacific time. `videos.list`/`channels.list` = 1 unit; `thumbnails.set` ≈ 50; since 1 Jun 2026 `videos.insert` and `search.list` have **their own buckets of 100 calls/day** (1 per call). Thumbnails up to 50 MB (since Sep 2026). Unaudited projects created after 28 Jul 2020: uploads restricted to private per the API revision history (current reference pages contradict this — D-048); the compliance audit is free but takes time. Checked 2026-10-14. | None (quota increases are free via audit/application). |
| **YouTube Analytics API v2** | Channel/video performance reports | Same OAuth client, scope `yt-analytics.readonly` | Free, quota-limited. Data is typically delayed by a day or more. | None. |
| **Google OAuth (consent screen)** | Connecting channels | Same | In **Testing** mode: max 100 test users, **refresh tokens expire after 7 days**. Publishing an app that requests sensitive YouTube scopes requires Google verification (privacy policy, homepage). | None, but verification effort. |
| **Ollama** (local) | Default LLM | None | Free, local. Speed depends on hardware. | None. |
| **Pexels API** (optional) | Stock video for the generator | Free API key (`PEXELS_API_KEY`) | **200 requests/hour, 20,000/month** by default; guidelines: show a prominent link to Pexels and credit creators when possible; `Authorization: <key>` header; `GET https://api.pexels.com/v1/videos/search` (`query`, `orientation`, `size`, `per_page` up to 80). The app caches searches 24 h and downloads files from `videos.pexels.com` / `player.vimeo.com` only. Checked 2026-10-14. **Not tested live — no key configured.** | None (limits can be raised for free). |
| **Pixabay API** (optional) | Extra stock video | Free API key (`PIXABAY_API_KEY`) | **100 requests/60 s**; requests must be cached 24 h; no systematic mass downloads; show users where videos come from. `GET https://pixabay.com/api/videos/?key=...` (`video_type`, `safesearch`); files from `cdn.pixabay.com`. Checked 2026-10-14. **Not tested live.** | None. |
| **Google Gemini API** (optional, off by default) | Alternative LLM on weak hardware | Free API key from AI Studio | Per-project RPM/RPD limits that change over time; **free-tier prompts may be used to improve Google products**; not available in some regions. | Yes, if the free tier is reduced — the app must keep working with Ollama alone. |

Not used (would cost money or need strong GPUs): paid TTS/voice APIs, hosted video-generation APIs, image-generation APIs, cloud storage, hosted databases, transactional email.

## 4. Configuration

All configuration comes from `.env` (template: `.env.example`, which documents each variable; checklist with required/optional/secret per variable: DEPLOYMENT.md §4). Both the Next.js app and the Python worker read the same `.env` from the repository root. Secrets live only in `.env` (D-020). Non-secret user preferences live in the `UserSettings` table.

## 5. Storage layout

`STORAGE_DIR` (default `./storage`), paths stored relative to it:

```
storage/
  uploads/tmp/{uploadId}/          chunk staging (deleted after assembly)
  videos/{videoId}/source.{ext}    original file
  videos/{videoId}/preview.mp4     H.264 proxy, only if the source isn't browser-playable
  videos/{videoId}/poster.jpg      poster frame
  videos/{videoId}/transcript.json word-level transcript
  shorts/{shortId}/render-{n}.mp4  exported Short (new name per export; older ones removed, D-041)
  shorts/{shortId}/captions.ass    generated subtitle file (last export)
  thumbnails/{thumbnailId}.jpg     frames, mock-ups and user uploads (re-encoded JPEG)
  thumbnails/uploads/{id}.upload   an uploaded image waiting to be checked (deleted after)
  generator/{projectId}/narration/{sceneId}-{n}.wav  scene narration (16 kHz mono)
  generator/{projectId}/clips/{sceneId}-{n}.{ext}    clips the creator uploaded for a scene
  generator/{projectId}/music-{n}.{ext}              optional background music
  generator/{projectId}/render/                       temporary render files (removed after each render)
  videos/{videoId}/source.mp4      a rendered generated video (then processed like an upload)
  stock-cache/{provider}/{assetId}.mp4               downloaded stock clips, shared by projects
  stock-cache/search/{provider}/{hash}.json          24-hour search cache
```

## 6. Job system

Job types and the worker that claims them:

| Type | Worker | Input → Output |
|---|---|---|
| `media.ingest` | Python | Source file → ffprobe metadata, poster, preview proxy if needed |
| `media.transcribe` | Python | Video → `transcript.json` + language |
| `ai.find_clips` | Python | Transcript + audio features → ranked clip candidates |
| `media.reframe` | Python | Short range (+10 s each side) → crop-centre keyframes in source time ✅ |
| `media.render_short` | Python | Short settings → 1080×1920 MP4 ✅ |
| `ai.package` | Python | Transcript/summary (or a Short's captions) → titles, description (+ chapters), hashtags, hooks, thumbnail concepts ✅ |
| `media.thumbnail_mockup` | Python | Frame (+ headline) or uploaded image → 1280×720 (720×1280 for Shorts) JPEG < 2 MB ✅ |
| `ai.recommend` | Python | Analytics summary → narrative recommendations |
| `gen.script` | Python | Topic brief → title, hook, scenes (narration, footage keywords) ✅ |
| `gen.narrate` | Python | Scene texts → per-scene WAV + word timings; scenes fail independently ✅ |
| `gen.footage` | Python | Scene keywords → up to 5 stock candidates each, best one downloaded ✅ |
| `gen.render` | Python | Narration + footage + captions (+ music) → MP4, registered as a library video ✅ |
| `yt.upload` | Node | Publication → YouTube video ID (+ thumbnail) ✅ |
| `yt.sync_channel` | Node | Channel → refreshed channel/video stats |
| `yt.sync_analytics` | Node | Channel + date range → daily analytics rows |

Internal worker API (Next.js, `Authorization: Bearer WORKER_SHARED_SECRET`, loopback only):

| Method & path | Purpose |
|---|---|
| `POST /api/internal/jobs/claim` | Body `{workerId, types[]}`; atomically marks the oldest queued job of those types as `running` and returns it, or `204` |
| `POST /api/internal/jobs/{id}/heartbeat` | `{progress 0–100, message}`; extends the lease |
| `POST /api/internal/jobs/{id}/complete` | `{result}`; result validated by the type's Zod schema, then a per-type handler persists it |
| `POST /api/internal/jobs/{id}/fail` | `{error, retryable}` |
| `POST /api/internal/workers/heartbeat` | Worker liveness for the system status page |

Defaults (D-032, D-056): lease 60 s; the worker heartbeats at least every ~5 s while working (a failed heartbeat is retried with the next one; a 409 stops the job); results and failures are reported up to 4 times (1, 3, 8 s back-off) on network or server errors; `maxAttempts` 3 with 15 s × attempt back-off for retryable errors; one job at a time per worker; workers poll every `WORKER_POLL_INTERVAL_MS` (2 s) and check in every 15 s. The worker never sees secrets other than its own `WORKER_SHARED_SECRET`.

Worker error codes used so far: `INVALID_VIDEO`, `TOO_LONG`, `SOURCE_MISSING`, `FFMPEG_MISSING`, `NO_AUDIO`, `NO_SPEECH`, `NOT_ENOUGH_SPEECH`, `TRANSCRIPT_MISSING`, `TRANSCRIPTION_UNAVAILABLE`, `TRANSCRIPTION_NOT_CONFIGURED`, `LLM_NOT_CONFIGURED`, `LLM_CREDENTIALS`, `LLM_MODEL_MISSING`, `LLM_UNAVAILABLE`, `LLM_BAD_OUTPUT`, `FACE_MODEL_INVALID`, `CAPTIONS_UNSUPPORTED`, `INVALID_RANGE`, `UNSUPPORTED_IMAGE`, `FRAME_FAILED`, `QUOTA_EXCEEDED`, `TTS_NOT_CONFIGURED`, `TTS_NOT_INSTALLED`, `TTS_UNAVAILABLE`, `TTS_VOICE_MISSING`, `TTS_FAILED`, `STOCK_NOT_CONFIGURED`, `STOCK_CREDENTIALS`, `STOCK_NONE_FOUND`, `STOCK_HOST_REFUSED`, `STOCK_TOO_LARGE`, `STOCK_ERROR`, `NARRATION_MISSING`, `SCENE_FOOTAGE`, `YOUTUBE_REAUTH`, `YOUTUBE_<reason>` for YouTube API errors such as `YOUTUBE_forbidden` (not retryable — the owner must act); `PROBE_TIMEOUT`, `TRANSCODE_FAILED`, `FFMPEG_STALLED`, `AUDIO_EXTRACT_FAILED`, `TRANSCRIPTION_MODEL_FAILED`, `LLM_TIMEOUT`, `LLM_RATE_LIMITED`, `FACE_MODEL_DOWNLOAD_FAILED`, `RENDER_FAILED`, `TTS_TIMEOUT`, `STOCK_UNAVAILABLE`, `STOCK_RATE_LIMITED`, `STOCK_DOWNLOAD_FAILED`, `NETWORK`, `UPLOAD_ERROR`, `WORKER_ERROR`, `WORKER_STOPPED` (retryable); `CANCELLED`. The app adds `WORKER_LOST` (lease expired), `INVALID_RESULT` and `RESULT_REJECTED` (a valid result the app can't save, e.g. a path it didn't ask for — not retried). Long blocking steps keep the lease alive with background heartbeats (D-038).

## 7. Feature implementation details

### 7.1 Uploads and library (Phase 3) ✅
- **Formats and limits** (`src/lib/uploads.ts`, shared by browser and server): MP4, M4V, MOV, MKV, WebM, AVI; up to `MAX_UPLOAD_MB` (default 4,096 MB) and `MAX_VIDEO_DURATION_MIN` (default 180). The UI shows these limits.
- **Validation layers:** (1) browser: extension, size, non-empty — before anything is sent; (2) server on create: the same rules again; (3) server per chunk: chunk number in range and exact byte length; (4) server on complete: all chunks present, total size, and magic bytes matching the claimed format (`src/server/media/sniff.ts`); (5) worker: ffprobe must find a real video stream, and the duration must be within the limit.
- **API** (all require a session; state-changing calls also require a same-origin `Origin` header):
  `POST /api/uploads` → `{id, chunkSize, totalChunks}` · `PUT /api/uploads/{id}/chunks/{n}` (raw bytes, streamed to disk) · `GET /api/uploads/{id}` (received chunks, for resuming) · `POST /api/uploads/{id}/complete` → `{videoId}` · `DELETE /api/uploads/{id}` (discard).
- **Storage:** chunks are written in place into `uploads/tmp/{id}/data.bin` with `{n}.ok` markers; completing renames the file to `videos/{videoId}/source.{ext}` (D-029). Cleanup: cancelled/failed uploads are deleted at once; idle uploads expire after 24 h; orphaned temp folders older than 1 h are removed by the sweep.
- **Processing:** `media.ingest` (Python worker) — ffprobe metadata (rotation-aware size, fps, codecs, duration), `poster.jpg` (640 px wide), and `preview.mp4` only when the original isn't browser-friendly (D-030). Progress is reported throughout; cancelling stops FFmpeg and removes partial files.
- **Serving:** `GET /api/media/videos/{id}/{source|preview|poster|playback}[?download=1]` checks session + ownership, supports HTTP Range (206/416) for seeking, sends `nosniff` and a sanitized file name. `playback` = preview if present, else the original.
- **Library UI:** `/videos` (upload panel with progress/cancel/retry/resume, search, status filter, sort, storage total, "worker not running" notice) and `/videos/{id}` (player, details, title/notes, processing progress with cancel, retry after failure, download original, delete with confirmation). Activity drawer in the top bar.
- **Not yet:** deleting derived files separately (LIB-07 partial — only total size is shown), detail-page tabs for later phases.

### 7.2 Transcription and AI Clip Finder (Phase 4) ✅
- **Transcription (`media.transcribe`)**: checks for an audio track (`NO_AUDIO` otherwise), extracts 16 kHz mono WAV with FFmpeg, and runs faster-whisper (`WHISPER_MODEL`, default `base`, int8 CPU; `WHISPER_DEVICE=auto` uses an NVIDIA GPU when present) with word timestamps and voice-activity filtering. Audio is processed in 10-minute pieces with correct time offsets, so long videos use little memory; the first piece's detected language is used for the rest. Output `videos/{id}/transcript.json`: `{version: 1, provider, model, language, languageProbability, durationMs, segments: [{startMs, endMs, text, words: [[startMs, endMs, text], …]}], loudness: {windowMs: 500, db: […]}}`. Queued automatically after ingest when the video has audio and `autoTranscribe` is on (priority 200, after new uploads).
- **Clip finding (`ai.find_clips`)** — D-034: sentence windows from word timings → speech-pattern score → shortlist (`CLIP_AI_CANDIDATES`, spread across the video) → AI rating (`CLIP_AI_BATCH_SIZE` excerpts per request; JSON schema: id, score 0–100, title ≤ 60, hook ≤ 100, reason, category) → 70/30 blended score → best non-overlapping `CLIP_MAX_SUGGESTIONS`. Edges are padded (150 ms before, 300 ms after) without reaching into neighbouring words. Malformed AI replies get one retry; ids the AI invents are ignored; unrated moments are dropped (never shown as AI-rated); if nothing usable comes back the job fails with `LLM_BAD_OUTPUT`. Mode `heuristic` skips AI entirely and is labelled "Speech patterns (no AI)".
- **Providers** (D-035): `ollama` (`OLLAMA_MODEL`, JSON-schema `format`, `num_ctx` from `OLLAMA_NUM_CTX`, replies capped at `OLLAMA_NUM_PREDICT` tokens (1,024, added in Phase 6 after a small model kept generating until the timeout), model kept loaded 10 min), `gemini` (REST `generateContent`, JSON mode, key in the `x-goog-api-key` header), `openai_compatible` (`/chat/completions`, `response_format: json_object`). The app checks readiness before queuing (Ollama reachable + model pulled; keys/models present) and shows the fix; the worker checks again.
- **Review** (`/videos/{id}?tab=clips`): preview plays exactly the range in the shared player; timing edits are snapped to whole words on the server (`snapToWords`) and refresh the clip's transcript text; accept/reject/back to review; rename; manual clips from transcript lines (origin `manual`). Re-running analysis replaces earlier `suggested`/`rejected` AI or heuristic clips and keeps accepted and manual ones.
- **Hand-over**: accepted clips form the Shorts Editor queue (`/shorts`, D-037).
- **Not yet**: correcting transcript text (CLIP-03, *should*), word-level selection for manual clips (lines only), speaker detection.

### 7.3 Shorts editor and export (Phase 5) ✅
- **Short** (`/shorts/{id}`): created from a clip (accepted or manual, one Short per clip, SHORT-01); the clip is marked accepted. Range 1 s – 3 min inside the video; the editor's timeline shows the Short ± 60 s, trims snap out of words (never into silence) and keep captions the user edited (`mergeCaptionsForRange`). Autosave 1 s after the last edit; keyboard: Space, ←/→ 1 s, `[`/`]` set start/end at the playhead.
- **Captions** (SHORT-04, D-040): built in TypeScript (`src/lib/shorts/captions.ts`) from the transcript words whose middle lies in the range: 1–4 words, ≤ 18 characters (one long word may exceed it), new caption after a pause > 0.5 s or sentence end; captions bridge gaps ≤ 1 s and linger 0.3 s otherwise; never overlap. Stored in source-video time on the Short; text and timing editable, captions can be added/deleted/rebuilt or turned off. Five presets (Bold white, Yellow pop, Boxed, Clean, Typewriter) plus font (Geist Black/Bold/Mono), size, colour, capitals, background (none/outline/box with colour and opacity) and vertical position. Optional hook text (SHORT-08) at the top for the first 3 s, in the caption font on a white box. The user's style can be saved as the default for new Shorts (`UserSettings.captionStyleJson`).
- **Framing** (SHORT-03, D-039, D-042): `auto` (face tracking), `center`, `blur` (whole frame scaled to fit over a blurred, darkened copy) and `manual` (drag the crop box on the current source frame or use the slider). Crop = full source height × 9:16 width (sources already 9:16 or narrower need no side-to-side framing). `media.reframe`: FFmpeg decodes the range (+10 s each side) at ≤ 15 fps, 320 px wide; shot cuts from HSV frame differences (threshold 30, shots ≥ 1 s); YuNet (score ≥ 0.6) on ~5 frames/s; per shot the main face = largest size × confidence track; median + moving-average smoothing, still when movement < 3 % of the width; keyframes simplified (Ramer–Douglas–Peucker, tolerance 0.4 %, ≤ 150) with a jump at each cut; shots without faces stay centred (with a warning). Measured: 3 s for a 30 s range on the owner's laptop.
- **Preview** (SHORT-02, SHORT-06): the source video in a 9:16 box, positioned with the same crop geometry (`src/lib/shorts/framing.ts` mirrors `media_worker/shorts/framing.py`), captions drawn with the same numbers as the export (`caption-style.ts`), the blur background from a tiny canvas; playback stops at the end of the Short.
- **Export** (`media.render_short`, SHORT-05, D-041): one FFmpeg pass — `-ss start -t length -i source`, crop (centre expression interpolating the keyframes over `t`) or blur graph → 1080×1920 → `ass=captions.ass:fontsdir=fonts` (FFmpeg runs inside the Short's folder, so no path escaping) → `libx264` (`veryfast` CRF 20 "Standard" / `medium` CRF 18 "High"), `yuv420p`, `high` profile, fps kept (≤ 60) + AAC 48 kHz 160 kbps stereo (`-an` when the source has no audio), `+faststart`; `RENDER_THREADS` limits encoder threads. The result is probed (must be 1080×1920) before it's reported. Priority 50 (before background transcription). Progress, cancel and errors appear in the Export tab; the finished MP4 plays in the page and downloads from `/api/media/shorts/{id}?download=1` (owner only, Range support).
- **Out of date** (SHORT-07): a SHA-256 of everything that changes the video (range, framing keyframes, captions, style, hook, quality) is stored with each export; a different current hash shows "Out of date" in the editor and on `/shorts`.
- **Performance** (NFR-PERF-03): see TESTING.md §3.5 for measured export times.
- **Not built**: word-by-word "karaoke" caption highlighting, following a second speaker within a shot, a zoom slider on the timeline (it zooms to the Short automatically), split/merge of captions.
- Note: a vertical/square video of ≤3 minutes is classified as a Short by YouTube automatically; there is no API flag.

### 7.4 AI packaging (Phase 6) ✅
- **Where:** `/packaging` lists every Short and ready video with its packaging status; `/packaging/{video|short}/{id}` is the workspace. Linked from the video page ("Packaging"), the Shorts Editor (⋯ › Write packaging; "Package this Short" after export). Needs a ready transcript and a working AI provider (Settings › AI & processing); otherwise the page explains what is missing (e.g. "Google Gemini API isn't ready: No API key" with where to get one) and queues nothing.
- **Input** (`ai.package`, D-043): the transcript — for a Short, its own captions as edited in the Shorts Editor (or the transcript words in its range) — plus the working title, the creator's notes for this version, the video's notes and the channel style notes (PKG-07). Transcripts over `PACKAGING_MAX_INPUT_WORDS` (default 1,500 words) are summarised part by part (≤ 100 words per part, again if needed) before writing.
- **Requests** (each JSON-schema-validated, one retry): ① 5 titles + 3 opening hooks ② description (2–3 short paragraphs; 2–3 sentences for Shorts) + up to 10 hashtags ③ 3 thumbnail concepts (headline ≤ 5 words, composition, emotion, the id of the best-fitting transcript excerpt) ④ chapter names (long videos only). Prompts tell the model to use only what the transcript says and to treat it as data.
- **Checks** (worker `packaging/checks.py`, app `src/lib/packaging/limits.ts`): titles ≤ 100 characters (code points), descriptions ≤ 5,000 UTF-8 bytes, `<`/`>` removed from both; duplicates removed; hashtags normalised (`#video editing` → `videoEditing`), de-duplicated case-insensitively, ≤ 15, and dropped when unrelated to the transcript/title/notes (with a notice); `#Shorts` added for Shorts; numbers not in the transcript, sensational phrases, all-capitals, placeholders such as `[Name]` and — in descriptions and hooks — capitalised names that don't appear in the transcript/title/notes are flagged next to the suggestion (the description's flags disappear once the creator edits it); hooks that merely repeat a title are dropped. Chapters: segment starts, first at 0:00, ≥ 3, ≥ 30 s apart, videos ≥ 3 min, appended to the description as `Chapters
0:00 …`.
- **Editing** (PKG-04/05, D-045): every field is editable with counters (characters/bytes); titles and hooks are radio-selectable; hashtags toggle on/off and can be added; Copy buttons per field and "Copy title, description and hashtags"; "Save changes"; "Use this packaging" marks the preferred version. Regenerating with notes adds a version; old versions stay.
- **Thumbnails** (`media.thumbnail_mockup`, D-044): frame picker on the source video (limited to the Short's range), "Make mock-up" (headline drawn on the frame), "Save frame only", "Upload your own image" (JPEG/PNG ≤ 10 MB, checked by content, re-encoded without metadata); output 1280×720 (videos) or 720×1280 (Shorts) JPEG, quality lowered until < 2 MB; one thumbnail can be chosen per video/Short; served only to the owner from `/api/media/thumbnails/{id}`.
- **Not built:** AI image generation (by design), A/B testing of titles, translation, automatic upload to YouTube (Phase 7).

### 7.5 YouTube integration (Phase 7) ✅
- **Endpoints** (D-047): `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`, `https://oauth2.googleapis.com/revoke`, `https://www.googleapis.com/youtube/v3`, `https://www.googleapis.com/upload/youtube/v3`. `GOOGLE_API_TEST_BASE_URL` (tests only, localhost only, D-050) replaces all of them.
- **OAuth** (`src/server/youtube/oauth.ts`, routes `/api/youtube/oauth/start` and `/callback`): Web-application client; redirect `GOOGLE_REDIRECT_URI`; scopes `youtube.readonly` + `youtube.upload`; `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`; PKCE S256 (48-byte verifier) and a 32-byte `state`, both sealed (AES-GCM) in an httpOnly, `SameSite=Lax`, 10-minute cookie scoped to `/api/youtube/oauth`, bound to the signed-in user. The callback checks user + state (constant-time), exchanges the code with the verifier, requires both scopes, calls `channels.list?mine=true` and stores every channel of that Google account with encrypted tokens (`OAuthCredential`). A refresh token is kept when Google doesn't send a new one. Access tokens are refreshed 60 s before expiry; `invalid_grant` marks the channel `reauth_required` (YT-03). Disconnect revokes the refresh token at Google, deletes the credential and keeps the channel row as `revoked` for upload history (YT-02).
- **Publish** (`/youtube/publish/{video|short}/{id}`, YT-04/08): the exported Short MP4 (must exist; a warning if it's out of date) or the library video's original file. Prefilled from the preferred packaging version (title, description + hashtag line, hashtags as tags) and its chosen thumbnail. Fields: channel, title (≤ 100 characters), description (≤ 5,000 bytes), tags (≤ 500 characters counted like YouTube: commas count, tags with spaces count their quotes), category (fixed list of YouTube's assignable category ids — no quota spent on `videoCategories.list`), privacy, schedule (local time → UTC, ≥ 15 min ahead), **made for kids** and **altered/synthetic content** answers (both required; sent as `status.selfDeclaredMadeForKids` and `status.containsSyntheticMedia`), thumbnail. Checks (`src/lib/youtube/publish.ts`): file ready, Shorts ≤ 3 min and vertical/square, required fields, no `<`/`>`, private-only and no scheduling unless `YOUTUBE_API_AUDITED=true` (D-048), today's upload quota left.
- **Upload** (`yt.upload`, Node worker `src/worker/index.ts`, D-049): resumable `videos.insert` (`part=snippet,status`), chunks of `YOUTUBE_UPLOAD_CHUNK_KB`, session URI stored encrypted, status query after any interruption, 6 retries with backoff for network/5xx errors, cancellation between chunks, lease kept alive every 10 s. Then `thumbnails.set` for the chosen thumbnail (a refusal — e.g. unverified channel — becomes a warning, not a failure). Result: video id, the privacy YouTube applied, warnings. Errors become plain-language messages (`quotaExceeded`, `uploadLimitExceeded`, `forbidden`, `invalidPublishAt`, …) with retry guidance on the YouTube page.
- **Quota guard** (`src/server/youtube/quota.ts`, YT-07): `ApiQuotaUsage` per Pacific day and bucket; each call reserves its cost with a conditional increment first (`channels.list` 1, `thumbnails.set` 50 in `default`; `videos.insert` 1 in its own bucket); limits `YOUTUBE_DAILY_UNITS` (10,000) and `YOUTUBE_DAILY_UPLOADS` (100). Publishing is refused when no upload is left, with the reset time in the owner's time zone.
- **Pages:** Settings › Channels (setup status, connect, reconnect, disconnect), `/youtube` (uploads with live progress, links to the video and YouTube Studio, errors with guidance, retry/cancel, today's quota), dashboard "Scheduled" widget.
- **Not built:** editing videos already on YouTube, playlists, captions upload, scheduling without the audit, multiple Google Cloud projects.

### 7.6 Analytics (Phase 8)
- `yt.sync_channel`: `channels.list` + paginate the uploads playlist via `playlistItems.list` + `videos.list` in batches of 50 (cheap; avoids `search.list`).
- `yt.sync_analytics`: `reports.query` for channel daily metrics (`views`, `estimatedMinutesWatched`, `averageViewDuration`, `subscribersGained`, `subscribersLost`, `likes`, `comments`, `shares`) and per-video daily metrics for recent videos. Revenue metrics are excluded (they need an extra monetary scope).
- Runs on demand and automatically every 12 h while the Node worker is running.
- Recommendations: deterministic rules computed in TypeScript, each with evidence (e.g. "Shorts get 3.2× the views per upload of long-form over 90 days"; "videos with no Shorts made yet but high retention"; "posting gaps over 14 days"; best weekday from own data when there are enough uploads). Optional `ai.recommend` turns them into a short narrative. No growth guarantees.

### 7.7 Original video generator (Phase 9) ✅
Pages `/generator` (brief, provider explanations, projects) and `/generator/[id]` (Brief → Script → Voice & footage → Render, UI_UX.md §5.6). Service: `src/server/services/generator.ts`; pure timeline helpers in `src/lib/generator/`; worker code in `media_worker/generator/` and `media_worker/jobs/gen_*.py`.
1. **Brief** (GEN-01): topic, niche (fixed list), optional audience and notes, tone, length (30, 45, 60, 90, 120, 180, 240 or 300 s), shape 9:16 or 16:9, 720p or 1080p, voice (installed voices reported by the worker), speaking speed, captions on/off, quality. Narration is English (the installed voices). Creating a project queues the script at once if the AI provider is ready; otherwise the project stays a draft with the reason (no silent fallback, D-035).
2. **`gen.script`** (GEN-02): the configured LLM gets the brief as data inside `<brief>` and a budget of 150 words/minute (±20 %) split into about one scene per 8 s (3–30 scenes); output is schema-validated. If the length misses the range, one rewrite is requested with the exact count and the closer version is kept; a remaining miss becomes a warning. The creator edits, reorders, adds and removes scenes and must approve the script (D-054).
3. **`gen.narrate`** (GEN-03): `TTS_PROVIDER=sapi` (default) speaks each scene with Windows' voices to a 16 kHz mono WAV and reports word start times from the engine; `kokoro` (optional) gets proportional timings labelled "estimated". Each recording gets a new file name; a scene whose text changed afterwards is "out of date". Scenes fail independently; a missing engine fails the job with install guidance.
4. **`gen.footage`** (GEN-04, GEN-08): only with `PEXELS_API_KEY` and/or `PIXABAY_API_KEY`. Per scene: search each configured provider (24 h cache under `stock-cache/search/`), keep files whose short side is at least 720 px in the right orientation (the smallest such file), rank clips at least as long as the narration first, keep 5, download the best one (https, official media host, at most 200 MB, partial file then rename). Other candidates are downloaded when chosen, at render time. Without a key the app explains how to get a free Pexels key, and scenes use **library videos** (from a start time) or **uploaded clips** instead (D-052).
5. **`gen.render`** (GEN-05): checks every narration file, resolves or downloads every clip, probes it and refuses footage without motion (frame differences, D-052). Each scene becomes a segment of narration length + 0.4 s (clips shorter than that loop), scaled/cropped to the frame at 30 fps; segments are joined with 0.4 s `xfade` crossfades at the cumulative narration lengths (D-053); narration is concatenated and padded by the final transition; optional music (`musicVolumeDb`, default -18 dB) loops and is ducked under the voice; captions (the owner's default caption style scaled to the frame, built from word timings per scene) are burned in with libass. Encoding as §7.3 (libx264 `veryfast`/CRF 21 standard, `medium`/CRF 19 high; AAC 160 kb/s 48 kHz stereo; `+faststart`).
6. **Library and publishing** (GEN-06, GEN-07): the MP4 becomes `videos/{id}/source.mp4` of a new `Video` (`sourceType = generated`, `creditsText`), processed by `media.ingest` like an upload, so the Clip Finder, Shorts Editor, Packaging and Publishing work on it. The publish form appends the credits to the description and defaults the synthetic-content answer to "yes" (D-055).

Measured on the owner's PC (TESTING.md §3.9): script 3–5 min with `qwen2.5:1.5b`, narration about 1.5–2.5 s per scene, rendering about 1.4–1.6× the video length at 720p.

## 8. Logging and errors
- Node: a small logger wrapper with levels (`LOG_LEVEL`), redaction of keys named like `token`, `secret`, `password`, `authorization`, and masking of secrets inside text (`key=`, `code=`, `Bearer …`), including error stacks and causes. `AppError` causes are logged; the user only sees the safe message.
- Python: standard `logging`, same levels; a handler filter masks `key=`, `token=` and `Bearer …` (D-060). FFmpeg's own error text is logged, never shown to the user.
- Job errors store a user-safe message in `Job.error` and full details only in local logs.
