# Requirements

Functional and non-functional requirements. Each has an ID used by `TESTING.md` and `ROADMAP.md`.
Priority: **M** = must have for v1, **S** = should have, **C** = could have (only if time allows).
Implementation details are in `TECHNICAL_SPEC.md`; screens in `UI_UX.md`.

## 1. Functional requirements

### 1.1 Foundation — FND (Phase 2)
| ID | Requirement | P |
|---|---|---|
| FND-01 | On first run (no users exist), the app shows an owner setup page to create the account (name, email, password ≥ 12 chars). Afterwards sign-up is disabled. | M |
| FND-02 | Users log in with email and password; failed logins are rate-limited; users can log out and see/revoke active sessions. | M |
| FND-03 | All app pages require login; unauthenticated visitors are redirected to `/login`. | M |
| FND-04 | An app shell with sidebar navigation, top bar, page header, light/dark/system theme, and responsive layout down to tablet width. | M |
| FND-05 | Settings page with sections: Profile & security, Channels, AI & processing, System status. Sections for future phases show "Coming in Phase N". | M |
| FND-06 | System status shows database, storage, FFmpeg/ffprobe (+ libass), Ollama, workers and which optional API keys are configured (without revealing them). | M |
| FND-07 | Owner can reset a forgotten password with a documented local CLI script. | S |

### 1.2 Dashboard — DASH (shell in Phase 2, widgets added per phase, complete in Phase 8)
| ID | Requirement | P |
|---|---|---|
| DASH-01 | Shows quick actions: Upload video, Find clips, Generate video. | M |
| DASH-02 | Shows active and recently failed jobs with progress and links to the related item. | M |
| DASH-03 | Shows recent library videos, clips awaiting review, and Shorts ready to publish. | M |
| DASH-04 | Shows scheduled and recently uploaded publications per connected channel. | M |
| DASH-05 | Shows 28-day channel KPIs (views, watch time, subscribers net) with change vs previous 28 days, and the top 3 recommendations. | M |
| DASH-06 | Shows a warning banner when a required dependency is missing or a channel needs reconnecting. | M |
| DASH-07 | Every widget has a useful empty state that explains the next step. | M |

### 1.3 Job system — JOB (Phase 3)
| ID | Requirement | P |
|---|---|---|
| JOB-01 | Long-running work runs as background jobs and never blocks the UI. | M |
| JOB-02 | Users see job status and progress (0–100 %, message) and are notified (toast) on success or failure. | M |
| JOB-03 | Users can cancel queued or running jobs and retry failed ones. | M |
| JOB-04 | Jobs survive app/worker restarts: interrupted jobs are retried automatically up to 3 times. | M |
| JOB-05 | Failed jobs show a plain-language error and a suggested fix where known (e.g. "FFmpeg not found"). | M |

### 1.4 Video library — LIB (Phase 3)
| ID | Requirement | P |
|---|---|---|
| LIB-01 | Upload one or more video files by drag-and-drop or file picker, with per-file progress, using resumable chunked uploads. | M |
| LIB-02 | Reject files that are not real videos (checked by content), exceed `MAX_UPLOAD_MB`, or exceed `MAX_VIDEO_DURATION_MIN`, with a clear reason. | M |
| LIB-03 | After upload, extract metadata (duration, resolution, fps, codecs, size) and a poster image; create a browser-playable preview when needed. | M |
| LIB-04 | Library list/grid with poster, title, duration, status, date; search by title; sort by date/duration; filter by source (uploaded/generated). | M |
| LIB-05 | Video detail page with player, metadata, editable title and notes, and tabs for Transcript, Clips, Shorts, Packaging, Publications (tabs appear as their phases arrive). | M |
| LIB-06 | Delete a video after confirmation; this removes its files and all derived items (transcript, clips, Shorts, thumbnails) but not videos already on YouTube. | M |
| LIB-07 | Show total storage used and allow deleting derived files (previews, renders) to free space. | S |

### 1.5 AI Clip Finder — CLIP (Phase 4)
| ID | Requirement | P |
|---|---|---|
| CLIP-01 | Transcribe a video locally with word-level timestamps; language auto-detected or set by the user. | M |
| CLIP-02 | View the transcript synchronised with the player (click a line to seek; current line highlighted); search within it. | M |
| CLIP-03 | Users can correct transcript text; corrections are used by captions and packaging. *(Not built yet. Since Phase 5, caption wording can be corrected per Short in the Shorts Editor; correcting the transcript itself, for packaging too, is still open.)* | S |
| CLIP-04 | "Find clips" proposes up to 10 non-overlapping moments (default 15–60 s, configurable up to 180 s), each with a score, hook line, suggested title and a reason. | M |
| CLIP-05 | Clip start/end snap to word or sentence boundaries — never mid-word. | M |
| CLIP-06 | Users can preview each candidate, adjust its start/end, accept or dismiss it, and create manual clips from a transcript selection. | M |
| CLIP-07 | The UI states which model produced the suggestions and that suggestions are AI judgements to be reviewed. | M |
| CLIP-08 | Works without internet using local Ollama. If the chosen AI is unavailable or lacks credentials, the app says why and how to fix it, and offers "speech patterns only (no AI)" as an explicit, clearly labelled choice — it never substitutes non-AI results silently (DECISIONS.md D-035). | M |

### 1.6 Shorts editor — SHORT (Phase 5)
| ID | Requirement | P |
|---|---|---|
| SHORT-01 | Create a Short from an accepted clip or a manual range (max 3 minutes). | M |
| SHORT-02 | 9:16 preview with trim handles and playback of the selected range. *(The timeline zooms to the Short automatically instead of having a zoom slider.)* | M |
| SHORT-03 | Reframing modes: auto (face tracking), centre, fit with blurred background, manual position; auto can be overridden. | M |
| SHORT-04 | Automatic captions from the transcript, editable text and timing, at least 4 style presets (font size, colour, highlight, position); can be turned off. *(Phase 5: "highlight" = outline or box background; word-by-word highlighting not built — DECISIONS.md D-040.)* | M |
| SHORT-05 | Export to MP4: 1080×1920, H.264/AAC, captions burned in; progress shown; output downloadable. | M |
| SHORT-06 | The preview matches the export closely enough that framing and caption positions don't surprise the user (verified visually in tests). | M |
| SHORT-07 | Editing after export marks the render as out of date and offers re-export. | M |
| SHORT-08 | Optional title/hook text overlay in the first seconds. | C |

### 1.7 AI packaging — PKG (Phase 6)
| ID | Requirement | P |
|---|---|---|
| PKG-01 | Generate for a video or Short: 5 titles, 1 description, up to 15 hashtags, 3 hooks, 3 thumbnail concepts. | M |
| PKG-02 | Respect YouTube limits: titles ≤ 100 characters, description ≤ 5,000 bytes, no `<` or `>` in titles; show character counters. | M |
| PKG-03 | Long-form descriptions include chapter timestamps derived from the transcript (first chapter at 0:00, at least 3 chapters, each ≥ 10 s) when the video is long enough. *(Phase 6: videos ≥ 3 min, chapters ≥ 30 s apart; the AI only names them — D-043.)* | S |
| PKG-04 | Users can add notes (audience, tone, keywords) and regenerate; previous sets remain available. | M |
| PKG-05 | Every generated field is editable and can be copied with one click. | M |
| PKG-06 | Thumbnail mock-ups: render a concept onto a chosen video frame as a 1280×720 JPEG under 2 MB; users can also upload their own thumbnail image (JPEG/PNG, validated). *(Phase 6: Shorts get vertical 720×1280 images — D-044.)* | M |
| PKG-07 | Packaging uses `channelStyleNotes` from settings when present. | S |

### 1.8 YouTube integration — YT (Phase 7)
| ID | Requirement | P |
|---|---|---|
| YT-01 | Connect one or more YouTube channels via Google OAuth with the minimum scopes; show channel name and avatar. | M |
| YT-02 | Disconnect a channel: revoke the token at Google and delete stored credentials. | M |
| YT-03 | Detect expired/revoked tokens and show "Reconnect" (expected weekly while the Google project is in Testing mode). | M |
| YT-04 | Publish a video or Short with title, description, tags, category, privacy, made-for-kids answer, AI-disclosure answer and optional thumbnail. | M |
| YT-05 | Schedule publishing with a future date/time (uploaded as private with `publishAt`), shown in the user's local time zone. Enabled only when `YOUTUBE_API_AUDITED=true`; otherwise uploads are private and the UI explains why. *(Phase 7: Google's documentation currently contradicts itself about the private-only restriction; the app keeps this rule and shows the privacy YouTube actually applied — D-048.)* | M |
| YT-06 | Upload progress and result (YouTube link) are shown; failures are retryable; resumable upload continues after a network drop. | M |
| YT-07 | Track daily quota usage and block actions that would exceed it, stating when it resets. | M |
| YT-08 | Validate before upload: file exists, duration/format acceptable, required fields present, Shorts are ≤ 3 minutes and vertical/square. | M |

### 1.9 Analytics — ANL (Phase 8)
| ID | Requirement | P |
|---|---|---|
| ANL-01 | Sync channel statistics and the list of channel videos (including ones not uploaded through the app). | M |
| ANL-02 | Sync daily channel and per-video metrics from the YouTube Analytics API; on demand and every 12 h while running. | M |
| ANL-03 | Analytics page: KPI cards, views and watch-time charts (7/28/90 days), top videos table, Shorts vs long-form comparison. | M |
| ANL-04 | Video analytics view: daily views, average view duration/percentage, engagement. | M |
| ANL-05 | Recommendations based on the channel's own data, each with the evidence shown and the option to dismiss. | M |
| ANL-06 | Show "data delayed" notice and last-synced time; never fabricate missing values. | M |
| ANL-07 | Optional AI narrative summary of recommendations. | C |

### 1.10 Original video generator — GEN (Phase 9)
| ID | Requirement | P |
|---|---|---|
| GEN-01 | Create a project from a brief: topic, audience, tone, target length (30 s–5 min), aspect ratio (16:9 or 9:16), voice. | M |
| GEN-02 | Generate a scene-by-scene script; user must review and can edit, reorder, add or remove scenes before production. Warn that facts must be checked. | M |
| GEN-03 | Generate narration locally for each scene and allow previewing it; regenerate a single scene. | M |
| GEN-04 | Find real moving stock footage for each scene (Pexels; Pixabay optional), show up to 5 candidates, allow swapping, uploading own clip or using part of a library video (D-052). No still-image slideshows. | M |
| GEN-05 | Render the final MP4 with narration, footage matched to narration length, burned-in captions and optional user-supplied music. | M |
| GEN-06 | Save the result to the library as a generated video, with a credits text listing stock creators, inserted into the description by default. | M |
| GEN-07 | Default the AI-disclosure (synthetic media) answer to "yes" for generated videos with a synthetic voice, with an explanation. | M |
| GEN-08 | Explain clearly when no API key is configured and how to get a free Pexels key. | M |

## 2. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-COST-01 | Cost | No paid services; the full v1 feature set works with free tools and free API keys only. |
| NFR-COST-02 | Cost | Core features (library, transcription, clips, Shorts, packaging with Ollama) work fully offline. |
| NFR-SEC-01 | Security | All requirements in `SECURITY.md` are met. |
| NFR-PRIV-01 | Privacy | Media and transcripts never leave the machine except when the user publishes to YouTube or explicitly enables Gemini. |
| NFR-REL-01 | Reliability | No data loss on app/worker crash: jobs resume or retry; partial files are cleaned up; uploads are resumable. |
| NFR-REL-02 | Reliability | External API failures (quota, network, 5xx) produce clear messages and retries with backoff; the app stays usable. |
| NFR-PERF-01 | Performance | UI pages render in < 1 s on the dev machine with 500 library videos; heavy work never runs in request handlers. |
| NFR-PERF-02 | Performance | Uploads of at least 4 GB succeed; memory use does not grow with file size (streaming). |
| NFR-PERF-03 | Performance | A 60 s Short exports in under 3× real time on a typical 4-core CPU without GPU (target, measured in Phase 5). |
| NFR-UX-01 | Usability | Professional, consistent UI per `UI_UX.md`; every async action shows loading, success and error states. |
| NFR-A11Y-01 | Accessibility | WCAG 2.2 AA colour contrast, full keyboard navigation, visible focus, labelled controls. |
| NFR-MAINT-01 | Maintainability | TypeScript strict, lint clean, tests per `TESTING.md`; feature code organised as in `ARCHITECTURE.md`. |
| NFR-MAINT-02 | Maintainability | AI providers, stock providers and TTS are behind interfaces so they can be swapped without touching features. |
| NFR-COMP-01 | Compatibility | Runs on Windows 10/11 (primary), macOS and Linux; latest Chrome, Edge and Firefox. |
| NFR-HONEST-01 | Transparency | The UI never presents AI output as verified fact; it labels AI-generated content and shows the model used. |
