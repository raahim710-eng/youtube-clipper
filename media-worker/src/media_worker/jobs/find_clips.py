"""ai.find_clips — suggest moments that could become Shorts (TECHNICAL_SPEC.md §7.2).

1. Candidate windows are cut at real sentence boundaries from the transcript (never invented).
2. Each window gets a measurable speech-pattern score (pace, loudness, questions, clean start, length).
3. mode "ai": the best-covering shortlist is rated by the configured AI provider, which also writes a
   title, hook and reason. mode "heuristic": no AI at all — results are labelled that way in the UI.

Result fields match `aiFindClipsResultSchema` in src/server/jobs/ai-find-clips.ts.
"""

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from media_worker.clips.candidates import (
    Window,
    build_windows,
    load_words,
    padded_bounds,
    pick_final,
    score_windows,
    shortlist,
    split_sentences,
)
from media_worker.clips.prompts import CATEGORIES, RESPONSE_SCHEMA, SYSTEM_PROMPT, Rating, RatingReply, user_prompt
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.llm import LLMProvider, LLMReplyError, get_llm_provider
from media_worker.storage import resolve_storage_path

AI_WEIGHT = 0.7  # final score = 70 % AI rating + 30 % speech-pattern score


class FindClipsPayload(BaseModel):
    videoId: str = Field(min_length=1)
    transcriptPath: str = Field(min_length=1)
    mode: Literal["ai", "heuristic"]
    provider: str | None = None
    minSec: int = Field(default=15, ge=5, le=170)
    maxSec: int = Field(default=60, ge=10, le=180)
    maxClips: int = Field(default=10, ge=1, le=30)
    aiCandidates: int = Field(default=12, ge=1, le=60)
    # Excerpts per AI request. 1 gives small local models the least chance to mix excerpts up.
    aiBatchSize: int = Field(default=1, ge=1, le=8)
    videoTitle: str = ""
    notes: str | None = None


def _first_sentence(text: str, limit: int) -> str:
    for mark in (". ", "? ", "! "):
        if mark in text:
            text = text.split(mark, 1)[0] + mark.strip()
            break
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _clip(window: Window, score: int, words: list, duration_ms: int, **fields: Any) -> dict[str, Any]:
    start, end = padded_bounds(window, words, duration_ms)
    return {
        "startMs": start,
        "endMs": end,
        "score": score,
        "heuristicScore": window.heuristic,
        "transcriptText": window.text[:4000],
        **fields,
    }


def _rate_batch(provider: LLMProvider, payload: FindClipsPayload, batch: list[Window]) -> dict[int, Rating]:
    prompt = user_prompt(payload.videoTitle, payload.notes, [(w.id, w.duration_ms / 1000, w.text) for w in batch])
    wanted = {w.id for w in batch}
    for _attempt in range(2):  # one retry for malformed replies
        try:
            reply = RatingReply.model_validate(provider.generate_json(SYSTEM_PROMPT, prompt, RESPONSE_SCHEMA))
        except (LLMReplyError, ValidationError):
            continue
        ratings: dict[int, Rating] = {}
        for rating in reply.clips:
            if rating.id in wanted and rating.id not in ratings:  # ignore ids the AI made up
                ratings[rating.id] = rating
        if ratings:
            return ratings
    return {}


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = FindClipsPayload.model_validate(raw_payload)
    path = resolve_storage_path(payload.transcriptPath, ctx.settings.storage_root)
    if not path.is_file():
        raise JobError(
            "TRANSCRIPT_MISSING", "The transcript file is missing. Transcribe the video again.", retryable=False
        )
    transcript = json.loads(path.read_text(encoding="utf-8"))
    duration_ms = int(transcript.get("durationMs") or 0)

    ctx.progress(5, "Finding natural start and end points")
    words = load_words(transcript)
    if len(words) < 5:
        raise JobError(
            "NO_SPEECH", "No speech was found in this video, so there are no moments to suggest.", retryable=False
        )
    sentences = split_sentences(words)
    min_ms, max_ms = payload.minSec * 1000, max(payload.maxSec, payload.minSec + 5) * 1000
    windows = build_windows(words, sentences, min_ms, max_ms)
    if not windows:  # short videos: allow shorter clips rather than giving up
        windows = build_windows(words, sentences, 5_000, max_ms)
    if not windows:
        raise JobError(
            "NOT_ENOUGH_SPEECH", "There isn't enough continuous speech for a clip (at least 5 seconds).", False
        )
    score_windows(windows, words, transcript)

    if payload.mode == "heuristic":
        ctx.progress(90, "Ranking by speech patterns")
        final = pick_final([(w, w.heuristic) for w in windows], payload.maxClips)
        clips = [
            _clip(
                w,
                score,
                words,
                duration_ms,
                aiScore=None,
                title=_first_sentence(w.text, 60),
                hook=_first_sentence(w.text, 100),
                reason=(
                    "Speech patterns: " + ", ".join(w.signals) + "."
                    if w.signals
                    else "A complete, self-contained passage of a good length."
                ),
                category=None,
            )
            for w, score in final
        ]
        return {
            "mode": "heuristic",
            "provider": None,
            "model": None,
            "clips": clips,
            "analysedCandidates": len(windows),
            "ratedCandidates": 0,
            "failedBatches": 0,
            "warnings": [],
        }

    if not payload.provider:
        raise JobError(
            "LLM_NOT_CONFIGURED", "No AI provider was chosen. Pick one in Settings › AI & processing.", retryable=False
        )
    provider = get_llm_provider(payload.provider, ctx.settings)
    with ctx.keepalive("Checking the AI provider"):
        provider.check()

    picked = shortlist(windows, payload.aiCandidates, duration_ms)
    size = payload.aiBatchSize
    batches = [picked[i : i + size] for i in range(0, len(picked), size)]
    rated: list[tuple[Window, int]] = []
    details: dict[int, Rating] = {}
    failed = 0
    for index, batch in enumerate(batches, start=1):
        ctx.progress(10 + 80 * (index - 1) / len(batches), f"AI is rating moments ({index} of {len(batches)})")
        with ctx.keepalive(f"AI is rating moments ({index} of {len(batches)})"):
            ratings = _rate_batch(provider, payload, batch)
        if not ratings:
            failed += 1
        for window in batch:
            rating = ratings.get(window.id)
            if rating:  # windows the AI didn't rate are left out rather than shown as AI-rated
                details[window.id] = rating
                rated.append((window, round(AI_WEIGHT * rating.score + (1 - AI_WEIGHT) * window.heuristic)))

    if not rated:
        raise JobError(
            "LLM_BAD_OUTPUT",
            f"The AI model ({provider.model}) didn't return usable ratings. Retry, try another model, "
            "or use “speech patterns only”.",
            retryable=False,
        )
    warnings = (
        [f"{failed} of {len(batches)} AI requests gave unusable answers; those moments were skipped."] if failed else []
    )

    ctx.progress(95, "Choosing the best moments")
    clips = []
    for window, score in pick_final(rated, payload.maxClips):
        rating = details[window.id]
        clips.append(
            _clip(
                window,
                score,
                words,
                duration_ms,
                aiScore=rating.score,
                title=rating.title.strip()[:60] or _first_sentence(window.text, 60),
                hook=(rating.hook.strip() or _first_sentence(window.text, 100))[:100],
                reason=rating.reason.strip()[:300],
                category=rating.category if rating.category in CATEGORIES else "other",
            )
        )
    return {
        "mode": "ai",
        "provider": provider.name,
        "model": provider.model,
        "clips": clips,
        "analysedCandidates": len(windows),
        "ratedCandidates": len(rated),
        "failedBatches": failed,
        "warnings": warnings,
    }
