# CLAUDE.md — AI YouTube Employee

Permanent instructions for Claude Code sessions in this repository. Read this file at the start of every session, then read the documents relevant to the task.

## What this project is

A **local-first web app** that acts as an "AI employee" for a YouTube creator. It runs on the creator's own computer and:
manages a video library → finds Short-worthy moments → edits vertical Shorts → writes packaging (titles, descriptions, hooks, thumbnail concepts) → publishes to YouTube → tracks analytics → generates original stock-footage videos from a topic.

AI and media processing run **locally by default** (FFmpeg, faster-whisper, Ollama, Windows voices). External services are free tiers and optional, except YouTube itself.

## Current status

- **Completed:** Phases 1–6; Phase 7 (YouTube integration) built and tested against a local Google stand-in — the manual real-channel test is still pending (needs the owner's Google Cloud project). Phase 8 (analytics) skipped for now at the owner's request.
- **Phase 9 — Original video generator:** complete. Stock footage (Pexels/Pixabay) is tested with mocks only until a key is configured; Kokoro narration is optional and untested.
- **Phase 10 — Hardening:** audit fixes, housekeeping, backups/restore, production start and DEPLOYMENT.md done — **awaiting owner review**. v1.0 is not reached (see ROADMAP.md Phase 10 row). Next: whatever the owner chooses (Phase 8 analytics, real-world tests, accessibility audit). Don't start new features without approval.
- When a phase starts or finishes, update this section and the status column in `ROADMAP.md`.

## Documentation map (each fact lives in one place)

| Topic | Source of truth |
|---|---|
| Why the product exists, users, goals, non-goals | `PRD.md` |
| What each feature must do (requirement IDs like `LIB-03`) | `REQUIREMENTS.md` |
| Libraries, versions policy, external services & limits, pipelines, env vars | `TECHNICAL_SPEC.md` |
| Processes, folders, module boundaries, job lifecycle | `ARCHITECTURE.md` |
| Tables, fields, relationships | `DATABASE_SCHEMA.md` |
| Layout, navigation, design tokens, workflows | `UI_UX.md` |
| Auth, OAuth, tokens, files, privacy | `SECURITY.md` |
| Test strategy and per-feature acceptance tests | `TESTING.md` |
| Phases, scope, completion criteria | `ROADMAP.md` |
| Why each technical choice was made | `DECISIONS.md` |

Rule: do not copy facts between documents; link to the source of truth. If a decision changes, add/supersede an entry in `DECISIONS.md` first, then update the affected documents in the same change.

## Phase boundaries

- Work only within the current phase's scope in `ROADMAP.md`. If a task needs something from a later phase, stop and ask the owner.
- Do not build early versions of later-phase features. Every navigation item already has a page; unbuilt features show `FeaturePlaceholder` driven by `src/lib/navigation.ts`. When a feature's phase is built, set `available: true` there and replace the placeholder page.
- A phase is complete only when its completion criteria in `ROADMAP.md` and the related acceptance tests in `TESTING.md` pass. Then summarise, update status, **stop and wait for approval**.
- Database changes happen only through Prisma migrations and must be reflected in `DATABASE_SCHEMA.md`.

## Non-negotiable rules

### Cost
- No paid services, subscriptions, billing code or trial-only APIs.
- External APIs are allowed only if listed in `TECHNICAL_SPEC.md` → "External services". Every optional service sits behind an interface and the app must still work (with reduced features) without it.
- Never claim an AI model or API can do something without checking its documentation. Record limits and uncertainties in the docs.

### Security (full rules in `SECURITY.md`)
- Never commit secrets. Only `.env.example` with placeholder values is committed.
- OAuth tokens are encrypted with `src/server/crypto.ts` before storage, are never sent to the browser and are never logged.
- Validate every server input (route handlers, server actions, worker API payloads/results) with Zod; Python validates with pydantic.
- Database access only through Prisma. `$queryRaw` only with tagged templates, never string concatenation.
- Spawn FFmpeg and other binaries with argument arrays (`spawn(cmd, args)` / `subprocess.run([...])`), never through a shell string.
- Never use a user-supplied string as a file path. Resolve paths only via the storage module, which rejects anything outside `STORAGE_DIR`.
- Every route handler and server action checks the session, except: auth routes, `/api/health`, and `/api/internal/*` (worker secret instead).
- User media is served only through authenticated routes, never from `public/`.

### Dependencies
- Prefer what is already in the stack (`TECHNICAL_SPEC.md`). Before adding a dependency, check licence (MIT/BSD/Apache preferred; flag GPL/AGPL), maintenance activity and size. Record significant additions in `DECISIONS.md`.
- Use exact versions; commit `package-lock.json` and `media-worker/uv.lock`.

## Coding conventions

**TypeScript (Next.js app + Node worker)**
- `strict: true`; no `any` (use `unknown` and narrow); avoid non-null `!`.
- Server-only modules live in `src/server/` and start with `import "server-only"` (except modules shared with the Node worker, which must not import Next.js APIs).
- Business logic in `src/server/services/`; route handlers and server actions stay thin (validate → call service → return).
- Status values are string unions defined once in `src/lib/constants.ts` with matching Zod schemas (SQLite has no native enums).
- Files kebab-case, React components PascalCase, functions/variables camelCase.
- UI uses shadcn/ui components from `src/components/ui`; do not add a second component library.
- Throw `AppError` (code + user-safe message) for expected failures; log details server-side only.

**Python (`media-worker/`)**
- Python 3.12 managed by `uv`; type hints everywhere; `ruff` for lint and format.
- One module per job type in `media_worker/jobs/`, exposing `run(payload, ctx) -> result` with pydantic payload/result models.
- The worker never touches the database. It talks to the app only through the internal worker API.
- AI rules (D-034/D-035/D-043): the AI never produces timestamps (clips, chapters, thumbnail frames); every AI output is schema-validated; results without AI are labelled "no AI"; never fall back from AI silently. Providers live in `media_worker/llm/` and `media_worker/transcription/`.
- YouTube (D-047…D-050): tokens are read only in `src/server/youtube/oauth.ts`; never put tokens or upload session URIs in job payloads, logs or responses (a test checks this). Never claim real publishing works until the manual real-channel test is done. `GOOGLE_API_TEST_BASE_URL` is for tests only.
- Shorts (D-040/D-041): preview and export must stay in sync — framing geometry is mirrored in `src/lib/shorts/framing.ts` and `media_worker/shorts/framing.py`; caption numbers come only from `src/lib/shorts/caption-style.ts`. Change both sides together and keep the tests that compare them.
- Resolve every storage path with `media_worker.storage.resolve_storage_path` (mirror of the TypeScript rules), run FFmpeg via `media_worker.ffmpeg` (argument lists, no shell), and report progress with `ctx.progress()`, which also detects cancellation. Raise `JobError(code, user_message, retryable=…)` for expected failures.

**General**
- Small focused functions and files. Comments explain *why*, not *what*.
- Store times in UTC; name durations with units (`durationMs`, `startMs`).
- UI text: plain English, sentence case, no jargon.

## Commands

| Command | Purpose |
|---|---|
| `npm run setup:env` | Create `.env` from `.env.example` with fresh secrets (never overwrites) |
| `npm run dev` | Next.js dev server only, http://localhost:3000 (videos won't be processed) |
| `npm run dev:all` | App + Python media worker + Node YouTube worker together (the normal way to run the app) |
| `npm run worker` / `worker:setup` / `worker:test` / `worker:lint` | Run the media worker / install its Python env (`uv sync`) / pytest / ruff |
| `npm run worker:yt` | Run the Node integration worker (YouTube uploads) on its own |
| `npm run build` / `npm start` | Production build / serve it on localhost |
| `npm run lint` / `npm run typecheck` | ESLint / route type generation + `tsc --noEmit` |
| `npm run format` / `npm run format:check` | Prettier |
| `npm test` | Vitest unit + integration tests (temporary database, never your `.env`) |
| `npm run test:e2e` | Playwright end-to-end tests (own server on port 3200 and own database; stop `npm run dev` first) |
| `npm run check` | lint + typecheck + unit/integration tests |
| `npm run db:migrate` | Create/apply Prisma migrations (dev) and regenerate the Prisma client |
| `npm run db:deploy` / `db:generate` / `db:studio` | Apply migrations only / regenerate client / browse data |
| `npm run auth:reset-password` | Reset the owner password from the terminal |
| `npm run start:all` | Production run (after `npm run build`): app + both workers |
| `npm run backup` / `npm run restore -- <folder> --yes` | Back up / restore database and storage (DEPLOYMENT.md §5) |
| `npm run check:secrets` | After a build: no secret values in the browser bundle, nothing private would be committed |


## Next.js 16 specifics (read before writing UI code)

- Also read `AGENTS.md` (written by Next.js): this version differs from older training data; the bundled docs are in `node_modules/next/dist/docs/`.
- Route protection lives in `src/proxy.ts` (the old `middleware` convention was renamed). It is only an optimistic cookie check.
- `cacheComponents` is on. Anything reading the request (session, cookies) or the database must run at request time: call `requireUser()` / `getCurrentSession()` (they read headers first) or `await connection()` before database work, and keep it under a `loading.tsx` or `<Suspense>` boundary. Never let a database answer be prerendered at build time.
- Instant-navigation validation only runs for segments with `export const instant = true` (DECISIONS.md D-022).
- Prisma 7: the client is generated into `src/generated/prisma` (git-ignored, created by `postinstall`); import from `@/generated/prisma/client`.

## Environment notes

- Owner's machine: Windows 10, PowerShell, **3.9 GB RAM, 2-core i5-3210M, no GPU** — keep anything heavy configurable and measured (D-033). Node 24 LTS, Git, FFmpeg 9.0.2, uv 0.13, Ollama 0.40 with qwen2.5:1.5b, Visual C++ runtime installed; the worker uses Python 3.12 managed by uv, with OpenCV 5 (headless only — never add the GUI `opencv-python` next to it, D-039). The YuNet face model lives in `models/face` (git-ignored). Terminals opened before those installs must be restarted to see them on PATH.
- Claude desktop app quirk: processes started from inside the app run in its MSIX package, which redirects writes to `%APPDATA%` and breaks uv's managed Python. When running uv from inside the app, set `UV_PYTHON_INSTALL_DIR=<repo>\.cache\uv-python` (git-ignored). Normal terminals don't need this.
- Tests: `tests/unit`, `tests/integration` (Vitest, `server-only` is stubbed), `tests/e2e` (Playwright). Never run tests against `data/app.db`.
- Write cross-platform code: `path.join`, no POSIX-only shell commands in npm scripts.
- Never run destructive commands on `storage/` or `data/` without asking.

## Definition of done (every task)

1. Follows the rules above; `lint`, `typecheck` and all tests pass.
2. New behaviour has tests as described in `TESTING.md`; `npm run build` succeeds.
3. Docs updated when behaviour, schema, env vars or decisions change (`.env.example`, `DATABASE_SCHEMA.md`, `DECISIONS.md`, etc.).
4. Final message states what changed, how it was tested, and any open risks or limitations.
