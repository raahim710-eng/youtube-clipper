# UI / UX Specification

Layout, navigation, design direction and user workflows. Feature rules are in `REQUIREMENTS.md`; components come from shadcn/ui (`DECISIONS.md` D-017).

## 1. Design direction

- **Feel:** a calm, professional production tool, closer to Linear, Vercel or Frame.io than to a flashy marketing site. Content (videos, thumbnails) provides the colour; the chrome stays neutral.
- **Theme:** light, dark and system (default: system), stored per browser by `next-themes`. Dark mode must be first-class because creators often edit in dim rooms.
- **Colour:** shadcn "zinc" neutrals + one accent, **violet** (`violet-600` light / `violet-500` dark). Semantic colours: success green, warning amber, destructive red, info blue. Do not use YouTube red or YouTube logos as app branding (Google branding rules); the YouTube logo appears only on the "Connect YouTube channel" button following YouTube's branding guidelines.
- **Typography:** Geist Sans for UI, Geist Mono for timecodes and IDs (both bundled with Next.js via `next/font`). Sizes: page title 24 px semibold, section title 16 px semibold, body 14 px, meta 12 px.
- **Spacing & shape:** 4 px grid; cards `rounded-xl`, inputs/buttons `rounded-md`; subtle borders over heavy shadows.
- **Motion:** 150–200 ms transitions; respect `prefers-reduced-motion`.
- **Product name:** "AI YouTube Employee" is the internal project name only. The name shown in the UI and on the Google OAuth consent screen is set by `NEXT_PUBLIC_APP_NAME` and must not contain "YouTube" (see `DECISIONS.md` D-021).
- **Tone of copy:** short, direct, sentence case. Name things by what the user gets ("Find clips"), not by technology ("Run LLM").

## 2. App layout

```
┌────────────────────────────┬──────────────────────────────────────────────┐
│ Logo  App name             │ Section title      [Channel ▾] [Jobs] [👤]   │ ← top bar
│────────────────────────────│──────────────────────────────────────────────│
│ ▣ Dashboard                │                                              │
│ ▶ Videos               P3  │              Page content                    │
│ ✂ AI Clip Finder       P4  │      (max width 1400 px, 16–24 px padding)   │
│ ▯ Shorts Editor        P5  │                                              │
│ ✎ AI Packaging         P6  │                                              │
│ ⇪ YouTube              P7  │                                              │
│ ▤ Analytics            P8  │                                              │
│ ✦ Original Video Gen.  P9  │                                              │
│                            │                                              │
│ ⚙ Settings                 │                                              │
└────────────────────────────┴──────────────────────────────────────────────┘
```

- **Sidebar** (shadcn `Sidebar`: collapsible to icons; becomes a sheet below 768 px and closes after choosing a page). Every item links to a page; items for unfinished phases show a small "P<N>" badge and open a clearly labelled placeholder (DECISIONS.md D-023). Labels and routes live in `src/lib/navigation.ts`.
- **Top bar:** section title, channel switcher (once channels exist, Phase 7), **Jobs** button with a count of active jobs that opens the activity drawer, user menu (theme, settings, log out).
- **Activity drawer:** right-side sheet listing running, queued and recent jobs, each with progress bar, cancel/retry, and a link to its item.
- **Banners:** system warnings (missing FFmpeg, worker offline, channel needs reconnect) appear under the top bar, dismissible per session.

## 3. Pages

| Route | Purpose | Key elements |
|---|---|---|
| `/setup` | First-run owner account | Single card form; explains data stays local |
| `/login` | Sign in | Email, password, error states |
| `/dashboard` | Overview | Quick actions row; KPI cards (Phase 8); "In progress" jobs; "Ready for review" clips; "Ready to publish" Shorts; "Scheduled" list; top recommendations |
| `/videos` | Video library (built in Phase 3) | Upload dropzone (top), grid/list toggle, search, sort, filter; video cards with poster, duration badge, status chip |
| `/videos/[id]` | Video detail | Player left (sticky on wide screens) + processing status; tabs right: **Clips** (find clips with AI or speech patterns, review cards: preview, adjust timing, accept/reject, rename) · **Transcript** (synced, searchable, "Make a clip" from lines) · **Details** (title/notes, file info, download, delete). Header has a **Packaging** button. Accepted clip cards offer **Create Short** / **Open Short**. Tabs for Packaging/Publications arrive with their phases |
| `/clip-finder` | AI Clip Finder: AI provider status, every video's transcript/clip status, best suggestions waiting for review | Filter by video/status; sort by score; bulk dismiss |
| `/shorts` | Shorts Editor home: "Clips ready for editing" (accepted clips without a Short, each with **Create Short**) and "Your Shorts" (9:16 cards with status: Draft / Exporting / Ready / Out of date / Export failed) | Cards with 9:16 thumbnails, status, "out of date" badge |
| `/shorts/[id]` | Shorts editor | See §4 |
| `/packaging` and `/packaging/[video\|short]/[id]` | AI Packaging: list of Shorts and videos with status · workspace ✅ | Provider line + readiness alert, notes, "Write packaging"/"Write a new version" with progress and cancel; version tabs; titles/hooks as radio lists with editable inputs, counters, "AI suggestion"/"Edited by you" and warnings; description with byte counter; hashtag toggle chips + add; concept cards (text only) with "Make mock-up"; thumbnail panel: frame picker, headline, upload, gallery (choose, download, delete); Copy buttons everywhere; "Save changes", "Use this packaging" |
| `/youtube` | YouTube: channels, publications | Table: target, channel, status, privacy, scheduled time, YouTube link; "New publication" wizard |
| `/analytics` | Channel analytics | Date range tabs (7/28/90 d), KPI cards, line/bar charts, top videos table, Shorts vs long-form, recommendations list |
| `/analytics/videos/[id]` | Single video analytics | Daily chart, retention/engagement metrics |
| `/generator` | Generator projects | Project list + "New video" |
| `/generator/[id]` | Generator workspace | Steps: Brief → Script → Voice & footage → Render (§5.6) |
| `/settings`, `/settings/channels`, `/settings/ai`, `/settings/system` | Settings | Profile & security (account, change password, active sessions), Channels (Phase 7), AI & processing (Phase 4), System status |

## 4. Shorts editor layout ✅ (Phase 5)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Shorts  [Short title……]  ✓ Saved          [Download] [Export MP4] [⋯]│
│ From <source video>                                                   │
├────────────────────────┬─────────────────────────────────────────────┤
│                        │ Tabs: Captions | Framing | Export           │
│   9:16 preview         │                                             │
│   (crop applied,       │ Captions: on/off · style (5 presets, font,  │
│    captions + hook     │ size, colour, capitals, background, colour, │
│    overlaid)           │ opacity, position, "use for new Shorts") ·  │
│                        │ caption list (time → seek, text, ⋯ start/end│
│  ▶  0:12.0 / 0:45.0    │ at playhead, delete) · add · rebuild ·      │
│  Keys hint             │ hook text (first 3 s)                       │
│                        │ Framing: Auto · Centre · Blur · Manual      │
│                        │ (face-tracking status; manual = drag the    │
│                        │ crop box on the source frame + slider)      │
│                        │ Export: settings summary, quality, progress │
│                        │ + cancel, errors + try again, finished MP4  │
│                        │ player, size/time, Download, out-of-date    │
├────────────────────────┴─────────────────────────────────────────────┤
│ Start [1:05.2]  End [1:50.3]  Length · snaps out of words · ≤ 3 min   │
│ Timeline: loudness bars, selected range with trim handles (sliders),  │
│ playhead, transcript words beneath; zooms to the Short ± context      │
└──────────────────────────────────────────────────────────────────────┘
```
- Autosave (debounced 1 s) with "Saving…/Saved ✓" indicator; a failed save shows the reason and "Try again", and blocks export; leaving with unsaved changes asks first.
- Keyboard: Space play/pause, ←/→ step 1 s, `[`/`]` set in/out at playhead (ignored while typing); trim handles take ←/→ (0.1 s) and Shift+←/→ (1 s).
- Exporting/face tracking progress is polled every 2 s; a toast says when the Short is ready.
- After export: in-page player of the real MP4, Download button (also in the header while up to date). "Package this Short" and "Publish" arrive with Phases 6–7.

## 5. Key workflows

### 5.1 First run
Open app → `/setup` (create owner) → dashboard with a "Get started" checklist: ① Check system status ② Upload a video ③ Connect a YouTube channel (Phase 7+). Checklist items tick off automatically.

### 5.2 Upload → transcript
Videos → drop files → per-file progress → card shows "Processing" → "Ready" (toast). Transcription starts automatically after ingest when the user's setting "Auto-transcribe new videos" is on (default on).

### 5.3 Find clips → Short
Video detail › Clips → "Find clips" (shows estimated time) → candidates list with score bar, hook, reason, preview button → adjust start/end on a mini-timeline → "Create Short" → opens editor with captions and auto framing → Export.

### 5.4 Package
From a video ("Packaging" button) or a Short (Shorts Editor ⋯ › Write packaging, or "Package this Short" after export) → optional notes → "Write packaging" (progress; a few minutes on a slow PC) → choose a title, edit the description, toggle hashtags, pick a hook → Copy or "Save changes" → a concept's "Make mock-up" fills the headline and jumps to its frame → "Make mock-up" or upload your own image → "Use this" on a thumbnail → "Use this packaging" (Phase 7 publishing will prefill from it). "Write a new version" keeps earlier versions. ✅

### 5.5 Publish
"Publish" (video page header, Shorts Editor ⋯ / Export tab, packaging workspace) → `/youtube/publish/{video|short}/{id}`: one page with ① Details (channel, title and description with counters, tags with YouTube's length rule, category — prefilled from the chosen packaging) ② Visibility: Private / Unlisted / Public / Schedule (local date-time; disabled with explanation until the project is audited) ③ Required answers: made for kids, altered/synthetic content ④ Thumbnail (from Packaging, or let YouTube choose) → list of what's still missing → "Upload as private" → `/youtube` with live progress → "Open on YouTube" / "YouTube Studio", the privacy YouTube applied, warnings; failures show the reason, what to do and "Try again" (resumes). ✅

### 5.6 Generate an original video
`/generator`: **New video** form (topic, niche, audience, tone, notes, length, shape, resolution, quality, voice, speaking speed, captions) next to **How videos are made** — what each step uses, what it needs, its licence, limits, processing time and cost (all free), and whether it's ready. Below: the projects with their stage.

`/generator/[id]` is a four-step workspace (tabs):
1. **Brief** — the settings form and "Write the script" / "Write a new script" (replaces scenes, with a warning). While the AI writes: a spinner and the job's progress.
2. **Script** — "Check the facts" warning naming the AI model; title, hook and scene cards (narration with word count and estimated seconds, footage keywords, optional on-screen text idea) that can be edited, moved, removed and added; total length against the target. "I've checked it — approve the script" saves, approves and starts narration (and the stock search when a key is set).
3. **Voice & footage** — counts ("3 of 5 narrated · 2 of 5 with footage"), "Record missing narration", "Find footage for the rest" (stock key only). Each scene card: status chips with text, the narration player ("Record again", out-of-date and estimated-timing notes), the chosen footage with preview, source link and start time, up to 5 stock suggestions ("Use this"), "Use a library video" (dialog with start time) and "Upload a clip". Without a stock key: an explanation of how to get a free Pexels key; otherwise "Stock videos provided by Pexels" link.
4. **Render** — what the file will be, optional background music (upload, volume, remove, rights reminder), "Render the video" (disabled with the exact reason, scene by scene), progress with Cancel, the finished video with Download / Open in Videos / Package it / Publish to YouTube, and the credits with Copy.

Errors (script, render) appear in a red alert at the top in plain words; job progress for every running step is shown with Cancel. Finished videos appear in Videos with a "Generated" chip and their credits on the Details tab.

## 6. Shared UI patterns

- **Status chips:** Processing (blue, spinner), Ready (green), Needs review (amber), Failed (red, with "Why?" popover), Scheduled (violet).
- **Loading:** skeletons for lists/cards; inline spinners for buttons; never a blank page.
- **Empty states:** icon, one-sentence explanation, primary action.
- **Destructive actions:** confirmation dialog naming exactly what will be deleted; type-to-confirm for deleting a channel connection or a video with publications.
- **Errors:** inline field errors from Zod; toasts for async failures with a "Details" link to the job.
- **AI content:** a small "AI" tag with a tooltip naming the provider and model; regenerate and edit always available.
- **Timecodes:** `m:ss` under an hour, `h:mm:ss` above; mono font.
- **Forms:** labels above inputs, helper text below, character counters where YouTube imposes limits.

## 7. Accessibility

Meets `NFR-A11Y-01`: Radix primitives for focus management, all icons with labels, contrast checked in both themes, captions/preview controls operable by keyboard, no information conveyed by colour alone (chips include text).
