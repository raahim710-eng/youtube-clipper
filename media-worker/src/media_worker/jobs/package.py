"""ai.package — YouTube packaging for a video or a Short (PKG-01…07, TECHNICAL_SPEC.md §7.4).

Everything is based on the real transcript (or a Short's edited captions). Long transcripts are summarised
part by part first. The AI writes text only: chapter times come from transcript segments and thumbnail
frame times from transcript excerpts the AI picks by id. Every reply is schema-validated, then limits are
enforced and questionable wording is flagged (packaging/checks.py).

Result fields match `aiPackageResultSchema` in src/server/jobs/ai-package.ts.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.llm import LLMProvider, LLMReplyError, get_llm_provider
from media_worker.packaging import checks
from media_worker.packaging.chapters import chapter_block, chapter_slots
from media_worker.packaging.prompts import (
    CHAPTERS_SCHEMA,
    CONCEPTS_SCHEMA,
    DESCRIPTION_SCHEMA,
    SUMMARY_SCHEMA,
    SYSTEM_PROMPT,
    TITLES_SCHEMA,
    ChapterTitles,
    Concepts,
    DescriptionTags,
    Summary,
    TitlesHooks,
    chapters_prompt,
    concepts_prompt,
    description_prompt,
    summary_prompt,
    titles_prompt,
)
from media_worker.packaging.source import chunk_words, excerpts, load_segments, word_count
from media_worker.storage import resolve_storage_path

HOOK_MAX_CHARS = 200


class PackagePayload(BaseModel):
    targetKind: Literal["video", "short"]
    targetId: str = Field(min_length=1)
    transcriptPath: str = Field(min_length=1)
    rangeStartMs: int | None = Field(default=None, ge=0)
    rangeEndMs: int | None = Field(default=None, gt=0)
    # A Short's captions as the creator corrected them; preferred over the raw transcript when present.
    captionText: str | None = Field(default=None, max_length=20_000)
    durationMs: int = Field(gt=0)
    title: str = Field(default="", max_length=200)
    notes: str | None = Field(default=None, max_length=2000)
    channelStyle: str | None = Field(default=None, max_length=2000)
    provider: str = Field(min_length=1)
    maxInputWords: int = Field(default=1500, ge=200, le=20_000)


def ask[T: BaseModel](
    provider: LLMProvider,
    ctx: JobContext,
    message: str,
    prompt: str,
    schema: dict,
    model: type[T],
    *,
    system: str = SYSTEM_PROMPT,
) -> T | None:
    """One request with one retry for an unusable reply. Provider errors (credentials, offline) propagate."""
    for _attempt in range(2):
        with ctx.keepalive(message):
            try:
                raw = provider.generate_json(system, prompt, schema)
            except LLMReplyError:
                continue
        try:
            return model.model_validate(raw)
        except ValidationError:
            continue
    return None


def summarise(provider: LLMProvider, ctx: JobContext, text: str, max_words: int) -> str:
    """Summarise-then-combine until the text fits the model's input budget."""
    level = 0
    while word_count(text) > max_words and level < 3:
        level += 1
        parts = chunk_words(text, max_words)
        summaries = []
        for index, part in enumerate(parts, start=1):
            ctx.progress(5 + 25 * index / len(parts), f"Summarising the transcript (part {index} of {len(parts)})")
            prompt = summary_prompt(part, index, len(parts))
            reply = ask(provider, ctx, f"Summarising part {index} of {len(parts)}", prompt, SUMMARY_SCHEMA, Summary)
            if reply:
                summaries.append(reply.summary.strip())
        if not summaries:
            raise JobError("LLM_BAD_OUTPUT", f"The AI model ({provider.model}) couldn't summarise the transcript.",
                           retryable=False)  # fmt: skip
        text = "\n".join(summaries)
    return text


def _items(values: list[str], numbers: set[str], limit: int, max_chars: int) -> list[dict[str, Any]]:
    seen: set[str] = set()
    items = []
    for value in values:
        text = checks.clean_line(value).strip("\"'“”")
        if max_chars == checks.TITLE_MAX_CHARS:
            text, _ = checks.clean_title(text)
        elif len(text) > max_chars:
            text = text[: max_chars - 1].rstrip() + "…"
        if not text or text.lower() in seen:
            continue
        seen.add(text.lower())
        items.append({"text": text, "flags": checks.flags_for(text, numbers)})
    return items[:limit]


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = PackagePayload.model_validate(raw_payload)
    path = resolve_storage_path(payload.transcriptPath, ctx.settings.storage_root)
    if not path.is_file():
        raise JobError("TRANSCRIPT_MISSING", "The transcript file is missing. Transcribe the video again.",
                       retryable=False)  # fmt: skip
    ctx.progress(2, "Reading the transcript")
    segments = load_segments(path, payload.rangeStartMs, payload.rangeEndMs)
    full_text = (payload.captionText or "").strip() or " ".join(s.text for s in segments)
    if word_count(full_text) < 5:
        raise JobError("NO_SPEECH", "There's no speech in the transcript to base titles and descriptions on.",
                       retryable=False)  # fmt: skip

    provider = get_llm_provider(payload.provider, ctx.settings)
    with ctx.keepalive("Checking the AI provider"):
        provider.check()

    fmt = payload.targetKind if payload.targetKind == "short" else "long"
    source = summarise(provider, ctx, full_text, payload.maxInputWords)
    used_summary = source != full_text
    notes = payload.notes
    context = {"is_summary": used_summary, "notes": notes, "style": payload.channelStyle}
    vocabulary = checks.source_vocabulary(full_text, payload.title, notes or "", payload.channelStyle or "")
    numbers = checks.source_numbers(full_text, payload.title, notes or "")
    warnings: list[str] = []

    ctx.progress(35, "Writing titles and hooks")
    titles_hooks = ask(provider, ctx, "Writing titles and hooks", titles_prompt(payload.title, fmt, source, **context),
                       TITLES_SCHEMA, TitlesHooks)  # fmt: skip
    ctx.progress(55, "Writing the description and hashtags")
    description_tags = ask(provider, ctx, "Writing the description and hashtags",
                           description_prompt(payload.title, fmt, source, **context), DESCRIPTION_SCHEMA,
                           DescriptionTags)  # fmt: skip
    if not titles_hooks or not description_tags:
        raise JobError(
            "LLM_BAD_OUTPUT",
            f"The AI model ({provider.model}) didn't return usable titles or descriptions. Try again, or choose "
            "another model in Settings › AI & processing.",
            retryable=False,
        )

    ctx.progress(75, "Suggesting thumbnail concepts")
    moments = excerpts(segments)
    concepts_reply = ask(provider, ctx, "Suggesting thumbnail concepts",
                         concepts_prompt(payload.title, fmt, source, [(e.id, e.text) for e in moments], **context),
                         CONCEPTS_SCHEMA, Concepts)  # fmt: skip
    concepts = []
    if concepts_reply:
        times = {e.id: e.start_ms for e in moments}
        for concept in concepts_reply.concepts[:3]:
            headline = checks.clean_headline(concept.headline)
            if not headline:
                continue
            concepts.append({
                "headline": headline,
                "composition": checks.clean_line(concept.composition)[:400],
                "emotion": checks.clean_line(concept.emotion)[:80],
                # Frame times only from real excerpts; an id the AI made up means "pick a frame yourself".
                "frameMs": times.get(concept.excerpt),
                "flags": checks.flags_for(headline, numbers),
            })  # fmt: skip
    else:
        warnings.append("The AI didn't return usable thumbnail concepts; try generating again.")

    chapters: list[dict[str, Any]] = []
    if fmt == "long":
        slots = chapter_slots(segments, payload.durationMs)
        if slots:
            ctx.progress(88, "Naming chapters")
            sections = [(i + 1, " ".join(slot.text.split()[:120])) for i, slot in enumerate(slots)]
            reply = ask(provider, ctx, "Naming chapters", chapters_prompt(sections), CHAPTERS_SCHEMA, ChapterTitles)
            names = {c.id: checks.clean_line(c.title)[:60] for c in reply.chapters} if reply else {}
            if all(names.get(i + 1) for i in range(len(slots))):
                chapters = [{"startMs": s.start_ms, "title": names[i + 1]} for i, s in enumerate(slots)]
            else:
                warnings.append("Chapters were left out because the AI didn't name every section.")

    description, shortened = checks.clean_description(description_tags.description)
    # Checked before chapters are added: chapter times are real, and not part of what the AI claimed.
    description_flags = checks.flags_for(description, numbers) + checks.name_flags(description, vocabulary)
    if chapters:
        block = chapter_block([(c["startMs"], c["title"]) for c in chapters])
        room = checks.DESCRIPTION_MAX_BYTES - len(block.encode("utf-8")) - 2
        body = description.encode("utf-8")[:room].decode("utf-8", errors="ignore")
        description = f"{body.rstrip()}\n\n{block}"
    if shortened:
        warnings.append("The description was shortened to YouTube's 5,000-byte limit.")

    raw_tags = description_tags.hashtags
    if fmt == "long":  # #Shorts on a long video would mislead viewers
        raw_tags = [t for t in raw_tags if (checks.normalize_hashtag(t) or "").lower() not in ("shorts", "short")]
    hashtags, dropped = checks.clean_hashtags(raw_tags, vocabulary, extra=["Shorts"] if fmt == "short" else None)
    if dropped:
        warnings.append("Left out hashtags unrelated to the transcript: " + ", ".join(f"#{t}" for t in dropped[:8]))

    titles = _items(titles_hooks.titles, numbers, 5, checks.TITLE_MAX_CHARS)
    # Small models sometimes repeat the titles as hooks; a hook should be a different, spoken opening.
    title_texts = {t["text"].lower() for t in titles}
    hooks = [h for h in _items(titles_hooks.hooks, numbers, 3, HOOK_MAX_CHARS) if h["text"].lower() not in title_texts]
    for hook in hooks:
        hook["flags"] += checks.name_flags(hook["text"], vocabulary)
    if len(hooks) < len(titles_hooks.hooks[:3]):
        warnings.append("Some opening hooks only repeated the titles and were left out — write a new version for more.")
    if not titles:
        raise JobError("LLM_BAD_OUTPUT", f"The AI model ({provider.model}) returned no usable titles.", retryable=False)

    ctx.progress(98, "Saving")
    return {
        "provider": provider.name,
        "model": provider.model,
        "format": fmt,
        "usedSummary": used_summary,
        "sourceWords": word_count(full_text),
        "titles": titles,
        "hooks": hooks,
        "description": description,
        "descriptionFlags": description_flags,
        "hashtags": hashtags,
        "droppedHashtags": dropped,
        "concepts": concepts,
        "chapters": chapters,
        "warnings": warnings,
    }
