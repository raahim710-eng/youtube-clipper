# Roadmap

Ten phases, built in order. Each phase ends with a working, tested app, a status update in this file and `CLAUDE.md`, and a **stop for owner approval**. Requirement IDs: `REQUIREMENTS.md`. Tests: `TESTING.md`.

| # | Phase | Status |
|---|---|---|
| 1 | Project preparation | ✅ Complete — approved |
| 2 | Foundation & app shell | ✅ Complete — approved |
| 3 | Video library & job system | ✅ Complete — approved |
| 4 | Transcription & AI clip finder | ✅ Complete — approved |
| 5 | Shorts editor & export | ✅ Complete — approved |
| 6 | AI packaging | ✅ Complete — approved |
| 7 | YouTube integration | ✅ Built — automated tests pass; manual real-channel test pending (needs Google Cloud setup) |
| 8 | Analytics & complete dashboard | ⏸ Skipped for now at the owner's request — still planned |
| 9 | Original video generator | ✅ Complete — approved (stock footage tested with mocks only until a Pexels key is added) |
| 10 | Hardening, polish & v1.0 release | 🔧 Hardening done, awaiting owner review — **v1.0 not reached**: needs Phase 8, a real-channel YouTube test, a stock-footage test with a key, an accessibility audit and the owner's first published Short and generated video (PRD §9) |

Order rationale: each phase only depends on earlier ones — library before AI (needs media), clips before Shorts (needs candidates), packaging before publishing (supplies metadata), publishing before analytics (needs connected channels), generator late (reuses captions, rendering, packaging and publishing).

---

## Phase 1 — Project preparation
**Goal:** agree on stack, scope and rules before writing code.
- Deliverables: `CLAUDE.md`, `README.md`, `PRD.md`, `REQUIREMENTS.md`, `TECHNICAL_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `UI_UX.md`, `SECURITY.md`, `TESTING.md`, `ROADMAP.md`, `DECISIONS.md`, `.env.example`, `.gitignore`.
- **Done when:** all files exist, agree with each other, and the owner approves.

## Phase 2 — Foundation & app shell
**Goal:** a secure, empty, professional-looking app that future features plug into.
- `git init`; scaffold Next.js (App Router, TypeScript strict, Tailwind v4, ESLint) with npm; Prettier; shadcn/ui init with base components.
- Prisma 7 + SQLite (`better-sqlite3` adapter, WAL); first migration with Better Auth tables, `UserSettings`, `AuditLog`.
- Better Auth email/password; `/setup` first-run flow; `/login`; session middleware + `requireSession()`; session list/revoke; `scripts/reset-password`.
- App shell: sidebar (future items disabled with phase badges), top bar, theme switch, dashboard placeholder with "Get started" checklist, Settings sections.
- `src/server/{env,logger,errors,storage}.ts`; Zod env validation; security headers; `localhost` binding.
- `/api/health` + Settings › System status (DB, storage, FFmpeg/ffprobe/libass detection, Ollama reachability; workers shown as "not running yet").
- Vitest + Playwright set up; optional GitHub Actions for static checks and unit tests.
- Covers: FND-01…07, DASH-06/07 (shell), NFR-SEC-01 (applicable parts).
- **Done when:** `TESTING.md` §3.1 and §4 pass; README setup works from a fresh clone on Windows; no feature code from later phases exists.
- **Result (2026-10-13):** done. Lint, typecheck, 54 Vitest tests, 7 Playwright tests and `npm run build` pass. Differences from the plan: navigation names/routes follow D-023; CI not set up (no remote repository yet); TanStack Query moved to Phase 3 (D-024); CSP without nonces until Phase 10 (D-026).

## Phase 3 — Video library & job system
**Goal:** reliably upload, process and browse videos; background job infrastructure for everything that follows.
- `Job`, `WorkerHeartbeat`, `Upload`, `Video` tables; queue service with claim/lease/heartbeat/retry/cancel; internal worker API.
- Python media worker skeleton (`uv`, config, API client, job loop, ruff, pytest) + `media.ingest`.
- Node integration worker skeleton (no `yt.*` jobs yet, heartbeat only); `npm run dev:all`.
- Chunked resumable uploads; ffprobe validation; poster; preview proxy; authenticated Range streaming.
- Library list/grid, detail page (Overview tab), edit, delete with file cleanup, storage usage.
- Activity drawer, job toasts, dashboard "In progress" and "Recent videos" widgets.
- Covers: JOB-01…05, LIB-01…07, DASH-02/03 (partial).
- **Done when:** `TESTING.md` §3.2, §3.3 pass; a 2 GB real video uploads, processes and plays.
- **Result (2026-10-13):** done, except the 2 GB manual upload, which hasn't been run yet (known limitation). FFmpeg 9.0.2 and uv 0.13 installed. Lint, typecheck, 113 Vitest, 35 pytest and 16 Playwright tests (real app + real worker + FFmpeg-generated samples) and `npm run build` pass. Changes from the plan: Node integration worker moved to Phase 7 (D-028); no TanStack Query (D-031); LIB-07 only shows total storage (deleting derived files → Phase 10).

## Phase 4 — Transcription & AI clip finder
**Goal:** turn a video into a searchable transcript and a ranked list of Short-worthy moments.
- `Transcript`, `ClipCandidate` tables; `media.transcribe` (faster-whisper); auto-transcribe setting.
- LLM provider interface with Ollama (default) and Gemini (optional, off); choose and document the default Ollama model after testing on the owner's hardware (add a `DECISIONS.md` entry).
- `ai.find_clips`: heuristic windows + LLM scoring + fallback.
- Transcript tab (synced, searchable, editable); Clips tab and `/clips` page; dashboard "Ready for review" widget.
- Covers: CLIP-01…08.
- **Done when:** `TESTING.md` §3.4 passes and the manual quality check is recorded.
- **Result (2026-10-14):** done. Installed Ollama 0.40 + qwen2.5:1.5b and the Visual C++ runtime (D-033, D-036). Real pipeline verified on a 100 s spoken video: transcription 79 s incl. model load, AI rating ~4 min, 3 sensible suggestions with real timestamps. Lint, typecheck, 139 Vitest, 66 pytest and 24 Playwright tests (+1 opt-in real-AI test, passed) and `npm run build` pass. Changes from the plan: no automatic fallback from AI (D-035); overview page is `/clip-finder` (not `/clips`); transcript editing (CLIP-03, *should*) not built; manual quality check done on 1 synthetic-speech video, not 3 real ones (no real recordings on this PC).

## Phase 5 — Shorts editor & export
**Goal:** professional vertical Shorts from clips.
- `Short` table; caption builder; `media.reframe` (YuNet + shot-cut detection, D-039); caption presets; `.ass` generation; `media.render_short`.
- Editor UI (preview, timeline, trim, captions, framing, autosave, shortcuts); `/shorts` list; download.
- Covers: SHORT-01…08.
- **Done when:** `TESTING.md` §3.5 passes; export speed measured against NFR-PERF-03 and documented.
- **Result (2026-10-14):** done. `Short` table, editor (`/shorts/{id}`), caption builder and 5 presets, Auto/Centre/Blur/Manual framing with YuNet face tracking, FFmpeg export to 1080×1920 H.264/AAC with burned-in captions, download, out-of-date detection. Lint, typecheck, Vitest, pytest, Playwright (5 new tests + an opt-in real-video check) and `npm run build` pass. Tested with a real public-domain recording: captions within 50 ms for 90 % of captions, a 60 s Short exports in 1.06× real time on the owner's 2-core laptop (TESTING.md §3.5). Changes from the plan: PySceneDetect replaced by our own shot-cut detection (D-039); "highlight" presets are outline/box backgrounds, no word-by-word highlighting (D-040); the timeline zooms automatically instead of a zoom slider; "Package this Short"/"Publish" buttons arrive with Phases 6–7.

## Phase 6 — AI packaging
**Goal:** ready-to-use titles, descriptions, hashtags, hooks and thumbnails.
- `PackagingSet`, `Thumbnail` tables; `ai.package` (with long-transcript summarisation); limit enforcement; chapters.
- `media.thumbnail_mockup`, frame picker, image upload with re-encoding; packaging workspace UI.
- Covers: PKG-01…07.
- **Done when:** `TESTING.md` §3.6 passes.
- **Result (2026-10-14):** done. `PackagingSet` and `Thumbnail` tables, `ai.package` (grounded in the transcript, summarise-then-write for long ones, limits and checks in code, chapters from transcript times), `media.thumbnail_mockup` (frames, mock-ups, uploads re-encoded), packaging workspace with editing, versions, copy, saving and a preferred version, linked from videos and the Shorts Editor; channel style notes in Settings. Lint, typecheck, Vitest, pytest, Playwright (7 new tests with a test-only fake AI) and `npm run build` pass; real local model checked on 3 targets (TESTING.md §3.6). Changes from the plan: Shorts get vertical 720×1280 thumbnails (D-044); chapters need videos ≥ 3 min and are ≥ 30 s apart; no AI image generation (by design, D-016).

## Phase 7 — YouTube integration
**Goal:** securely connect channels and publish.
- Owner creates a Google Cloud project + OAuth client following README (manual step, free).
- `YouTubeChannel`, `OAuthCredential`, `Publication`, `ApiQuotaUsage` tables; crypto module; OAuth start/callback; connect/disconnect/reconnect UI.
- Node worker `yt.upload` (resumable, thumbnail), quota guard, `YOUTUBE_API_AUDITED` gating; publish dialog; `/publishing` page; dashboard "Scheduled" widget.
- Optional (owner's choice): apply for the YouTube API compliance audit to unlock public/scheduled uploads.
- Covers: YT-01…08.
- **Done when:** `TESTING.md` §3.7 automated tests pass and the manual real-channel test is completed.
- **Result (2026-10-14):** built. Channel connection (OAuth + PKCE, encrypted tokens, reconnect, disconnect with revocation), publish page with all required YouTube fields, resumable uploads in the new Node worker, thumbnails, quota guard, `/youtube` page, dashboard "Scheduled". All automated tests pass against a local Google stand-in (D-050). **Not yet verified with a real Google account or channel** — no Google Cloud credentials exist on this PC; the manual test is the remaining completion criterion. Changes from the plan: no `googleapis` package (D-047); private-only rule kept despite contradictory Google docs, with the applied privacy reported (D-048); fixed category list instead of `videoCategories.list`; publishing is a page, not a dialog.

## Phase 8 — Analytics & complete dashboard
**Goal:** understand performance and get data-backed suggestions.
- Incremental `yt-analytics.readonly` consent; `ChannelVideo`, `ChannelAnalyticsDaily`, `VideoAnalyticsDaily`, `Recommendation` tables.
- `yt.sync_channel`, `yt.sync_analytics`, 12-hour scheduler; recommendation rules; optional `ai.recommend`.
- Analytics pages with charts; dashboard KPIs and recommendations; all dashboard widgets final.
- Covers: ANL-01…07, DASH-01…07.
- **Done when:** `TESTING.md` §3.8 passes and numbers match YouTube Studio (allowing for delay).

## Phase 9 — Original video generator
**Goal:** create original videos from a topic with real moving footage.
- `GeneratorProject`, `GeneratorScene`, `StockAsset` tables; `gen.script`, `gen.narrate` (Windows voices by default, Kokoro optional — D-051), `gen.footage` (Pexels, optional Pixabay; library videos and uploaded clips without a key — D-052), `gen.render`.
- Stepper UI (Brief → Script → Scenes → Render); credits; disclosure default; output into library.
- Covers: GEN-01…08.
- **Done when:** `TESTING.md` §3.9 passes and two complete videos are produced.

## Phase 10 — Hardening, polish & v1.0 release
**Goal:** reliable, secure, pleasant to use every day.
- Full security review against `SECURITY.md`; dependency audit; fix findings.
- Performance pass (large libraries, long videos); cleanup tasks for temp files and stale renders.
- Backup/restore script; data deletion options; accessibility audit (NFR-A11Y-01); UI polish and copy review.
- Complete E2E suite for all main workflows; README/troubleshooting finalised; optional packaging (e.g. one-click start script).
- **Done when:** all **M** requirements pass; `TESTING.md` §4 and §5 pass; the release definition in `PRD.md` §9 is met; tag `v1.0.0`.

## After v1 (ideas, not commitments)
Comment assistant, multi-user/team mode, PostgreSQL option, local GPU text-to-video experiments, speaker diarisation, B-roll suggestions for long-form videos, more languages for narration.
