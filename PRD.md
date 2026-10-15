# Product Requirements Document — AI YouTube Employee

## 1. Vision

Give every YouTube creator an "AI employee" that does the repetitive work of running a channel — cutting Shorts, writing titles and descriptions, uploading, and reading analytics — so the creator can spend their time on ideas and recording. It runs on the creator's own computer, keeps their footage private, and costs nothing to operate.

## 2. Problem

Creators who record long-form videos (podcasts, tutorials, commentary, vlogs) know that Shorts and good packaging grow a channel, but:
- Finding the best 30–60 seconds in an hour of footage takes hours of scrubbing.
- Turning a clip into a vertical Short with captions and good framing needs editing skills and software.
- Writing titles, descriptions, hashtags and thumbnail ideas for every upload is tiring and inconsistent.
- Uploading, scheduling and checking analytics happens in different tools.
- Existing AI tools that do this are subscription-based, upload footage to the cloud, and charge per minute of video.

## 3. Target users

| Persona | Description | Main needs |
|---|---|---|
| **Solo long-form creator** (primary) | Publishes 1–4 long videos per week, wants Shorts from each, limited editing time | Clip finder, Shorts editor, packaging, scheduling |
| **Podcaster / interviewer** | Talking-head footage, multiple speakers | Accurate transcription, face reframing, captions |
| **Faceless / educational channel** | Explainer topics, no on-camera presence | Original video generator, packaging |
| **Small creator team (future)** | Editor + creator sharing a machine or server | Out of scope for v1; schema leaves room for it |

Assumed user skills: comfortable installing desktop software by following a guide; not necessarily a programmer.

## 4. Product goals (v1)

1. **Save time:** go from an uploaded long video to a ready-to-publish Short (captioned, framed, packaged) in under 15 minutes of user time.
2. **Professional output:** 1080×1920 Shorts with readable captions and sensible framing; metadata that respects YouTube limits.
3. **Zero running cost:** no subscriptions; only free tools and free API keys.
4. **Privacy:** footage and transcripts stay local unless the user publishes them.
5. **Trustworthy automation:** the AI suggests, the creator approves. Nothing is published without an explicit user action.

## 5. Core features

Detailed behaviour is in `REQUIREMENTS.md`; delivery order in `ROADMAP.md`.

| # | Feature | Value to the creator |
|---|---|---|
| 1 | **Dashboard** | One place to see what's processing, what's ready, what's scheduled and how the channel is doing. |
| 2 | **Video library** | Upload and organise source videos; every other tool starts here. |
| 3 | **AI clip finder** | Local transcription plus AI ranking of moments that could work as Shorts, with reasons. |
| 4 | **Shorts editor** | 9:16 reframing, auto captions, trimming, MP4 export. |
| 5 | **AI packaging** | Titles, description, hashtags, hooks and thumbnail concepts/mock-ups. |
| 6 | **YouTube integration** | Secure channel connection, uploads, native scheduling. |
| 7 | **Analytics** | Channel and video performance with data-backed recommendations. |
| 8 | **Original video generator** | Topic → script → narration → real stock footage → finished video. |

## 6. Non-goals (v1)

- Hosted SaaS, multi-tenant accounts, team roles, billing.
- A full timeline video editor (multi-track, transitions library, effects).
- AI image generation for thumbnails and AI text-to-video generation (hardware/cost — see `DECISIONS.md` D-011, D-016).
- Comment moderation/replies, community posts, live streams, other platforms (TikTok, Instagram).
- Monetisation/revenue analytics.
- Fully automatic publishing without human review.
- Mobile app (the web UI works on tablets; phones are not a target).

## 7. Success metrics

Measured manually on the owner's own channel after v1:
- Time from upload to exported Short (user time, excluding processing) ≤ 15 min.
- ≥ 50 % of AI-suggested clips judged "usable" by the creator on typical talking-head content.
- ≥ 80 % of exports need no manual reframing on single-speaker footage.
- 0 failed uploads that aren't explained with a clear reason and a retry option.
- Monthly running cost: €0 / $0.

## 8. Constraints and known limitations

These shape what we promise. Full details and numbers: `TECHNICAL_SPEC.md` §3.

- **Hardware dependent:** local transcription, LLMs and TTS are slower on CPU-only computers. A computer with 16 GB RAM is recommended; an NVIDIA GPU is optional but helps.
- **Small local LLMs are imperfect judges** of what is "interesting", and only see the transcript, not the visuals. All AI output is reviewable and editable.
- **YouTube API rules:**
  - Uploads from unaudited Google Cloud projects are locked to private, and scheduled public release needs a passed (free) compliance audit.
  - In Testing mode, channels must be reconnected every 7 days.
  - Daily quotas limit uploads (100 `videos.insert` calls/day by default).
- **YouTube policies:** mass-produced or repetitive generated content may not be eligible for monetisation, and realistic synthetic content must be disclosed. The generator encourages original scripts and sets the disclosure by default.
- **Stock footage relevance** depends on keyword search; abstract topics may need manual footage choices.
- **Language:** transcription is multilingual; narration quality is best in English.

## 9. Release definition

v1.0 is reached when all ten roadmap phases are complete, every **M** requirement passes its acceptance tests, and the owner has published at least one Short and one generated video to their own channel using only the app.
