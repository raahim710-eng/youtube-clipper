# AI YouTube Employee

A local-first web app that works like an AI employee for YouTube creators. It finds Short-worthy moments in your videos, edits vertical Shorts with captions, writes titles and descriptions, publishes to your channel, tracks analytics, and generates original videos from a topic. It runs on your own computer with free, local tools.

> **Status (Phase 10, hardening):** video library, local transcription, AI Clip Finder, Shorts Editor, AI Packaging, YouTube publishing and the Original Video Generator are built and tested; backups, housekeeping and a production start command are in place. **Not yet verified in the real world:** publishing to a real YouTube channel (needs your Google Cloud setup), stock footage from Pexels/Pixabay (needs a free key), Kokoro narration. Analytics (Phase 8) is not built yet. So this is **ready for careful personal use on your own computer, not a finished v1.0** — see the launch checklist in [DEPLOYMENT.md](DEPLOYMENT.md) §6 and [ROADMAP.md](ROADMAP.md).

> **Running it every day?** Follow [DEPLOYMENT.md](DEPLOYMENT.md): production start (`npm run start:all` or `scripts\start-windows.cmd`), environment-variable checklist, backups and recovery, launch checklist and costs.

## Features

| Feature | Phase | State |
|---|---|---|
| Secure login, app shell, system status | 2 | Built and tested |
| Video library with resumable uploads | 3 | Built and tested |
| Local transcription + AI clip finder | 4 | Built and tested with real speech and a local AI model |
| Shorts editor: 9:16 reframing, captions, MP4 export | 5 | Built and tested with a real recording |
| AI packaging: titles, descriptions, hashtags, hooks, thumbnails | 6 | Built and tested with a local AI model |
| YouTube channel connection, uploads, scheduling | 7 | Built; tested against a local stand-in for Google — **real channel not tested yet** |
| Analytics and recommendations, full dashboard | 8 | **Not built** (skipped for now) |
| Original video generator (script → narration → real footage → MP4) | 9 | Built and tested with real AI, Windows voices and own footage — **stock footage not tested with a real key** |
| Hardening: backups, housekeeping, production start, security fixes | 10 | Done (see DEPLOYMENT.md); v1.0 not yet reached |

## Technology stack

| Layer | Choice |
|---|---|
| Web app | Next.js (App Router) + TypeScript, Node.js 24 LTS, npm |
| UI | Tailwind CSS v4, shadcn/ui, lucide icons, Recharts |
| Database | SQLite via Prisma ORM |
| Auth | Better Auth (email + password, local owner account) |
| Background work | Database job queue; Python media worker + Node integration worker |
| Video | FFmpeg / ffprobe |
| Transcription | faster-whisper (local) |
| LLM | Ollama (local, default); Google Gemini free tier (optional) |
| Narration | Windows' built-in voices (default); Kokoro-82M optional |
| Reframing | OpenCV YuNet face detection + PySceneDetect |
| Footage for generated videos | Your library videos and uploaded clips; Pexels API (free key) and Pixabay API (optional) |
| YouTube | YouTube Data API v3 + YouTube Analytics API v2 (`googleapis`) |
| Testing | Vitest, Playwright, pytest |

Why these were chosen: [DECISIONS.md](DECISIONS.md). Details, limits and costs: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md).

## Prerequisites

| Tool | Needed from | Install (Windows) |
|---|---|---|
| Node.js 24 LTS | Phase 2 | https://nodejs.org (already installed on the dev machine) |
| Git | Phase 2 | https://git-scm.com (already installed) |
| FFmpeg (full build with libass — needed to burn captions into Shorts) | Phase 3 | `winget install Gyan.FFmpeg` (installed on the dev machine) |
| uv (manages Python 3.12 for the worker) | Phase 3 | `winget install astral-sh.uv` (installed on the dev machine) |
| Microsoft Visual C++ Redistributable (x64) | Phase 4 | `winget install Microsoft.VCRedist.2015+.x64` (admin prompt; needed by the speech engine) |
| Ollama + a model | Phase 4 | `winget install Ollama.Ollama`, then `ollama pull qwen2.5:1.5b` (or a bigger model if you have more RAM) |
| Face detection model (YuNet, ~230 KB) | Phase 5 | Nothing to install: the worker downloads it once from the OpenCV Zoo when Auto framing is first used (needs internet that one time). OpenCV itself comes with `npm run worker:setup`. |
| Pexels API key (free) | Phase 9 | https://www.pexels.com/api/ |
| Google Cloud project + OAuth client (free) | Phase 7 | Steps below |

Recommended hardware: 16 GB RAM and 30+ GB free disk (models + videos). An NVIDIA GPU is optional and speeds up transcription and narration.

## Setup

Run these in the project folder (PowerShell or Git Bash):

```bash
npm install
```

```bash
npm run setup:env
```

This creates `.env` from `.env.example` with three freshly generated secrets. It never overwrites an existing `.env`. To create secrets by hand instead, run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` once per secret.

```bash
npm run db:deploy
```

```bash
npm run worker:setup
```

This prepares the Python media worker (uv downloads Python 3.12 and the worker's packages the first time).

```bash
npm run dev:all
```

This starts the app (in development mode) and both workers together. For everyday use, run `npm run build` once and then `npm run start:all` instead — faster and more stable (DEPLOYMENT.md). Open http://localhost:3000. On the first visit you'll be asked to create the owner account (one per installation; sign-up closes afterwards). Then check **Settings › System status**: anything missing is listed with how to fix it.

Upload videos on the **Videos** page. Supported: MP4, M4V, MOV, MKV, WebM and AVI, up to 4 GB and 180 minutes each (change `MAX_UPLOAD_MB` / `MAX_VIDEO_DURATION_MIN` in `.env`). Files are stored in `storage/` inside the project folder.

If login is misconfigured (for example, the secret is missing), the login page shows a "Setup needed" screen instead of a form.

Forgot the password? Run `npm run auth:reset-password` in the project folder.

**AI Clip Finder:** new videos are transcribed automatically on your computer. Open a video's **Clips** tab and choose **Find clips with AI** (local Ollama by default) or **Speech patterns only (no AI)**. Pick or configure the AI in **Settings › AI & processing**; keys and model names go in `.env` (see `.env.example`). Using Gemini instead needs a free API key from https://aistudio.google.com/app/apikey and sends transcript excerpts to Google.

**Shorts Editor:** accept a clip (or make your own from the transcript), then choose **Create Short** — on the clip card or in **Shorts Editor**. The editor opens with captions from the transcript and **Auto** framing (it finds the speaker's face; takes a few seconds). Trim on the timeline (or type start/end; trims never cut a word), edit caption text and timing, pick a caption style, switch framing (Auto, Centre, Blur, Manual), then **Export MP4**: a 1080×1920 H.264/AAC file with captions burned in, made by FFmpeg on your computer. Download it from the Export tab. Changes save automatically; if you edit after exporting, the Short is marked **Out of date** until you export again.

**AI Packaging:** open **AI Packaging** (or **Packaging** on a video page, or ⋯ › **Write packaging** in the Shorts Editor), add optional notes (audience, tone, keywords) and choose **Write packaging**. You get 5 titles, a description (with chapters for videos of 3+ minutes), hashtags, 3 opening hooks and 3 thumbnail ideas, written from the transcript by the AI chosen in **Settings › AI & processing** (local Ollama by default; add your channel's style there too). Everything is editable and has a Copy button; **Save changes** keeps your edits and **Use this packaging** marks your choice. **Write a new version** keeps the old ones. For thumbnails, pick a frame and add a headline (**Make mock-up**) or upload your own JPEG/PNG — the app draws text on your real frame; it doesn't generate images with AI. Suggestions that mention numbers not in the transcript or use sensational wording are flagged so you can check them.

### Troubleshooting

| Problem | Fix |
|---|---|
| Videos stay in "Processing" and the library says the media worker isn't running | You started `npm run dev`; stop it and run `npm run dev:all`. |
| `ffmpeg` or `uv` "not recognized" right after installing | Close and reopen the terminal (or VS Code) so it picks up the new PATH. |
| Processing failed: "FFmpeg isn't installed" | Install FFmpeg, restart `npm run dev:all`, then choose **Retry processing** on the video. |
| `uv` fails with "Missing expected target directory" in a terminal inside the Claude desktop app | That app's sandbox redirects `%APPDATA%`. Use a normal terminal, or first set `UV_PYTHON_INSTALL_DIR` to `<project>\.cache\uv-python`. |
| Transcription fails with "faster-whisper couldn't load" | Install the Visual C++ runtime: `winget install Microsoft.VCRedist.2015+.x64`, then `npm run worker:setup` and restart. |
| "Ollama isn't running" or "model isn't downloaded" | Start the Ollama app; run `ollama pull <OLLAMA_MODEL>`. Or choose another provider / speech patterns only in Settings › AI & processing. |
| Auto framing says "face detection model couldn't be downloaded" | It's fetched once from GitHub (OpenCV Zoo). Check the internet connection and choose **Try again** on the Framing tab, or copy `face_detection_yunet_2023mar.onnx` into `models/face`. Centre, Blur and Manual framing work without it. |
| Export fails with "can't draw captions (it lacks libass)" | Install the full FFmpeg build: `winget install Gyan.FFmpeg`, restart `npm run dev:all`. Or turn captions off. |
| Exports make the PC sluggish | Set `RENDER_THREADS="1"` in `.env` (slower export, smoother computer) and restart the worker. Choose **Standard** quality. |
| Packaging says the AI "isn't ready" | Follow the fix shown (start Ollama / `ollama pull <model>`, or add the key for Gemini in `.env` and restart). Packaging needs an AI model; "speech patterns only" can't write text. |
| Writing packaging takes several minutes | Expected with a small local model on a slow CPU (3–4 AI requests, more for long videos that are summarised first). Lower `PACKAGING_MAX_INPUT_WORDS` only if you use a model with a small context. |
| Google says `redirect_uri_mismatch` | The redirect URI in your OAuth client must equal `GOOGLE_REDIRECT_URI` exactly (scheme, `localhost` vs `127.0.0.1`, port, path). Fix it in Google Cloud Console, wait a minute, try again. |
| Google says "Access blocked" / `access_denied` / the app is in testing | Add your Google account under *Test users* on the consent screen (README › Google Cloud setup, step 3). |
| A channel shows "Needs reconnecting" | Normal about weekly while the Google project is in Testing mode, or after you removed access in your Google account. Press **Reconnect**. |
| Uploads stay "Waiting" | The YouTube upload worker isn't running: use `npm run dev:all` (or `npm run worker:yt`). |
| "Daily upload limit" / quota used up | Google's free limit for your project; it resets at midnight Pacific time (the *YouTube* page shows when in your time). |
| Finding clips with AI is slow | Expected on CPUs: roughly 30–40 s per rated moment with a small model. Lower `CLIP_AI_CANDIDATES` in `.env`. |
| Generator: "No stock video provider is set up" | Expected without a key. Use **Use a library video** or **Upload a clip** for each scene, or add a free Pexels key (see *Original video generator* below). |
| Generator: "the footage doesn't move (still images aren't allowed)" | That scene's clip is a still picture or a frozen video. Choose moving footage for the scene named in the message. |
| Generator: the narration says "isn't installed" / the voice list is empty | Windows voices are listed in *Settings › Time & language › Speech*. `TTS_VOICE` in `.env` is only a default; leave it empty to use Windows' default voice. |
| Generator: narration is "out of date" | You edited that scene's text after recording. Click **Record again** (or **Record missing narration**). |
| PowerShell says `npm.ps1 cannot be loaded because running scripts is disabled` | Type `npm.cmd` instead of `npm` (e.g. `npm.cmd run start:all`), or double-click `scripts\start-windows.cmd`. No need to change Windows' script policy. |
| The computer is slow while videos are processed | Set `RENDER_THREADS="1"` in `.env` and restart (jobs take longer, the computer stays usable). Keep `WHISPER_KEEP_LOADED="false"` on 4–8 GB RAM. |
| The disk is filling up | Housekeeping runs hourly while the app runs and removes unused files; delete videos you don't need; check `storage/stock-cache` (unused stock clips are kept for `STOCK_CACHE_DAYS`). Backups in `backups/` are never deleted automatically. |
| Something is still running after closing the app | Close every terminal window of the app; if `localhost:3000` still answers, restart the computer (or end the `node`/`python` processes in Task Manager). |
| An upload was interrupted | On **Videos**, the unfinished upload is listed — choose **Resume** and pick the same file. Unfinished uploads are deleted after 24 hours. |

### Checks and maintenance

| Command | What it does |
|---|---|
| `npm run start:all` | Production run: the built app plus both workers (after `npm run build`) |
| `npm run backup` / `npm run restore -- <folder> --yes` | Back up / restore the database and storage (DEPLOYMENT.md §5) |
| `npm run check:secrets` | After a build: no secrets in the browser bundle, nothing private would be committed |
| `npm run check` | Lint + typecheck + unit/integration tests |
| `npm run worker:test` / `npm run worker:lint` | Python worker tests (real FFmpeg) / ruff |
| `npm run test:e2e` | Browser tests with their own app, worker, database and generated sample videos (stop `npm run dev` first; first time: `npx playwright install chromium`) |
| `npm run build` | Production build |

### Original video generator (Phase 9)

*Original Video Generator* in the sidebar makes a video from a topic: brief → AI script (you check and edit it) → narration → footage per scene → MP4 with captions in your library.

- **Script:** uses the AI provider from *Settings › AI & processing* (Ollama by default; a small local model takes a few minutes and can get facts wrong — the app makes you review the script before anything is produced).
- **Narration:** Windows' built-in voices (`TTS_PROVIDER="sapi"`, the default) — free, offline, nothing to install; English voices such as *Microsoft David* and *Microsoft Zira*. Pick one per project. Optional, more natural voice: Kokoro (about 2 GB): `uv pip install --python media-worker/.venv kokoro soundfile`, then `TTS_PROVIDER="kokoro"` and `TTS_VOICE="af_heart"` in `.env` and restart (not tested on the development PC).
- **Footage — always real moving video:**
  - *Your own:* any ready video in your library (from a start time you choose) or a clip you upload for a scene (MP4/MOV/WebM/MKV, up to 500 MB). Its own sound is not used; avoid shots of someone talking to the camera, because with the new narration it can look as if they are saying it.
  - *Stock (free):* create a Pexels account, get a key at https://www.pexels.com/api/, put `PEXELS_API_KEY="…"` in `.env` and restart `npm run dev:all`. Optional: `PIXABAY_API_KEY` from https://pixabay.com/api/docs/. Limits: Pexels 200 requests/hour and 20,000/month; Pixabay 100/minute. Searches are cached for 24 hours. Both licences allow use in your videos; the app adds creator credits to the description when you publish.
  - Still images are refused when rendering. AI video generation isn't used (the free models need a graphics card; hosted ones are paid).
- **Music (optional):** upload music you have the rights to (e.g. from the YouTube Audio Library); it's ducked under the voice.
- **Result:** a new video in *Videos* marked "Generated", with credits on its Details tab. Publishing from the app adds the credits to the description and pre-selects "contains synthetic content: yes" because the voice is synthetic.
- **Time on a slow PC:** see TESTING.md §3.9 for measured runs.

### Google Cloud setup (Phase 7) — connect your YouTube channel

Publishing uses Google's official sign-in (OAuth) and the YouTube Data API v3. Everything below is free; no
billing account is needed. You do this once, in your own Google account. The app never asks for your Google
password — Google's own page asks you to allow access.

1. **Create a project** at https://console.cloud.google.com → project picker → *New project* (any name).
   Don't add a billing account.
2. **Enable the API:** *APIs & Services › Library* → search **YouTube Data API v3** → *Enable*.
   (The YouTube Analytics API is added in Phase 8.)
3. **Consent screen** (*Google Auth Platform* / *OAuth consent screen*):
   - *Get started*: an app name **without the word "YouTube"** (e.g. "Creator Studio Assistant"), your email
     as support and contact address.
   - *Audience*: **External**, publishing status **Testing**. Under *Test users*, add the Google account that
     owns your channel.
   - *Data access* (optional): add `.../auth/youtube.readonly` and `.../auth/youtube.upload` — the only two
     permissions the app asks for (see your channel; upload videos and thumbnails).
4. **OAuth client:** *Clients* (or *Credentials › Create credentials › OAuth client ID*) → type
   **Web application** → *Authorised redirect URIs* → add exactly
   `http://localhost:3000/api/youtube/oauth/callback` (it must match `GOOGLE_REDIRECT_URI` character for
   character, including `localhost` vs `127.0.0.1` and the port). No JavaScript origins are needed.
   Copy the client ID and secret; **don't download the JSON into this folder**.
5. **`.env`:**
   ```
   GOOGLE_CLIENT_ID="…apps.googleusercontent.com"
   GOOGLE_CLIENT_SECRET="…"
   GOOGLE_REDIRECT_URI="http://localhost:3000/api/youtube/oauth/callback"
   TOKEN_ENCRYPTION_KEY="…"      # already created by `npm run setup:env`; keep it — losing it means reconnecting
   YOUTUBE_API_AUDITED="false"   # see "Audit" below
   ```
6. **Restart** with `npm run dev:all` (it now starts three processes: app, media worker and the YouTube
   upload worker). Check *Settings › System status*: "Google OAuth client" and "YouTube upload worker" should
   be OK.
7. **Connect:** *Settings › Channels › Connect a YouTube channel*. Google shows "Google hasn't verified this
   app" — expected for your own app in Testing mode with you as a test user: choose *Continue*, pick the
   channel's account and allow both permissions.

**Limits of this free setup** (Google's documentation, checked 2026-10-14):
- **Quota per project and day** (resets at midnight Pacific time): 10,000 units for most calls, plus a separate
  bucket of **100 uploads** (`videos.insert`). A custom thumbnail costs 50 units, finding your channel 1.
  The app counts usage, refuses actions that would exceed it and shows when it resets (*YouTube* page). If your
  project has different limits (*APIs & Services › YouTube Data API v3 › Quotas*), set `YOUTUBE_DAILY_UNITS` /
  `YOUTUBE_DAILY_UPLOADS`. Higher quotas can be requested for free with Google's quota extension form, which
  involves the audit below.
- **Testing mode:** at most 100 test users, and Google expires the sign-in after **7 days** — the app then shows
  "Needs reconnecting"; press *Reconnect*. Moving the consent screen to *In production* with these YouTube
  permissions requires Google's **OAuth app verification** (privacy policy, homepage, demo video). Not needed
  for personal use.
- **Audit and privacy:** Google's YouTube policy (API revision history, 28 Jul 2020) says videos uploaded through
  unaudited API projects created after that date are **restricted to private**, until the project passes the free
  **YouTube API Services compliance audit** (Google's "YouTube API Services – Audit and Quota Extension" form, linked from the YouTube Data API quota documentation). Some
  current reference pages say the opposite; until Google is consistent, the app stays on the safe side:
  with `YOUTUBE_API_AUDITED="false"` it uploads **private** only and disables scheduling. After an upload the
  app shows the privacy YouTube actually applied. Set `YOUTUBE_API_AUDITED="true"` only after your project
  passes the audit; then public/unlisted uploads and **scheduling** (YouTube's own `publishAt`, which works even
  when this computer is off) are enabled.
- **Custom thumbnails** need a verified channel (https://www.youtube.com/verify). If YouTube refuses the
  thumbnail, the video is still uploaded and the app says so.

To remove the app's access at any time: *Settings › Channels › Disconnect* (revokes it at Google), or
https://myaccount.google.com/permissions. See [SECURITY.md](SECURITY.md) §3.

## Development workflow

1. Work happens phase by phase ([ROADMAP.md](ROADMAP.md)); each phase ends with tests passing and owner approval.
2. Read [CLAUDE.md](CLAUDE.md) for coding rules, phase boundaries and the definition of done.
3. Use a branch per phase or feature (`phase-3/library-upload`), small commits, and merge when checks pass.
4. Before committing: `npm run check` and `npm run build` (+ `npm run worker:test` and `npm run worker:lint` when the worker changed; + `npm run test:e2e` for UI changes).
5. Schema changes go through `npm run db:migrate` and an update to [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).
6. New significant dependency or design choice → entry in [DECISIONS.md](DECISIONS.md).

## Project structure

See [ARCHITECTURE.md](ARCHITECTURE.md) §2. In short: `src/` (Next.js app, server code, Node worker), `prisma/`, `media-worker/` (Python), `tests/e2e/`, `scripts/`; `data/` and `storage/` hold your database and media and are never committed.

## Documentation

| File | Contents |
|---|---|
| [PRD.md](PRD.md) | Vision, users, goals, non-goals, limitations |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Functional and non-functional requirements |
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | Dependencies, external services and limits, pipelines |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, folders, job lifecycle, flows |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Tables and relationships |
| [UI_UX.md](UI_UX.md) | Layout, design system, workflows |
| [SECURITY.md](SECURITY.md) | Auth, OAuth, tokens, files, privacy |
| [TESTING.md](TESTING.md) | Test strategy and acceptance tests |
| [ROADMAP.md](ROADMAP.md) | Phases and completion criteria |
| [DECISIONS.md](DECISIONS.md) | Decision log |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Installing for daily use, environment checklist, backups, launch checklist, costs |
| [CLAUDE.md](CLAUDE.md) | Instructions for AI-assisted development |

## Costs

Designed to cost nothing to run: all core processing is local, and external APIs are used within free tiers. Things that could change: free-tier limits of optional APIs (Gemini, Pexels, Pixabay), and YouTube API quotas. The video generator uses only free tools (local AI, Windows voices, FFmpeg, free stock APIs) and never a paid video-generation service. The full list is in [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) §3.
