import json
from pathlib import Path
from typing import Any

import pytest
from conftest import RecordingSink, make_video, requires_ffmpeg
from PIL import Image, ImageDraw, PngImagePlugin
from test_candidates import transcript_from

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.jobs import package, thumbnail_mockup
from media_worker.llm import LLMReplyError
from media_worker.packaging import checks
from media_worker.packaging.chapters import chapter_block, chapter_slots, timestamp
from media_worker.packaging.source import Segment
from media_worker.packaging.thumbnail import fit_headline

# --- Limits and checks (PKG-02) ----------------------------------------------------------------------


def test_titles_follow_youtube_limits() -> None:
    assert checks.clean_title("<b>Edit faster</b>  with   transcripts") == ("bEdit faster/b with transcripts", False)
    long = "word " * 40
    title, shortened = checks.clean_title(long)
    assert shortened and len(title) <= 100 and not title.endswith(" ")


def test_description_fits_5000_bytes_even_with_multibyte_characters() -> None:
    text = "Café ☕ " * 1500  # ~10,500 bytes
    description, shortened = checks.clean_description(text + "<script>")
    assert shortened
    assert len(description.encode("utf-8")) <= 5000
    description.encode("utf-8").decode("utf-8")  # still valid UTF-8 (no cut characters)
    assert "<" not in description and ">" not in description
    assert checks.clean_description("Line one\r\n\r\n\r\n\r\nLine   two") == ("Line one\n\nLine two", False)


def test_hashtags_are_normalised_deduplicated_and_related() -> None:
    vocabulary = checks.source_vocabulary("Transcripts make video editing much faster for creators.")
    kept, dropped = checks.clean_hashtags(
        ["#VideoEditing", "video editing", "transcripts", "#Crypto", "Editing!!", "#123", "creator tips"],
        vocabulary,
        extra=["Shorts"],
    )
    assert kept == ["Shorts", "VideoEditing", "transcripts", "Editing", "creatorTips"]
    assert dropped == ["Crypto"]
    assert checks.normalize_hashtag("#Hello World") == "HelloWorld"


def test_flags_for_unsupported_numbers_clickbait_and_capitals() -> None:
    numbers = checks.source_numbers("That saved me about eleven hours every week, 3 times faster.")
    assert checks.flags_for("Save 11 hours a week, 3x faster", numbers) == []
    flags = checks.flags_for("10 SHOCKING EDITING SECRETS YOU WON'T BELIEVE", numbers)
    assert any("Mentions 10" in f for f in flags)
    assert any("Sensational" in f for f in flags)
    assert any("capital" in f for f in flags)


# --- Chapters (PKG-03) -------------------------------------------------------------------------------


def test_chapters_start_at_zero_and_are_long_enough() -> None:
    segments = [Segment(i * 15_000, i * 15_000 + 12_000, f"Sentence number {i}.") for i in range(40)]  # 10 min
    slots = chapter_slots(segments, 600_000)
    starts = [s.start_ms for s in slots]
    assert starts[0] == 0 and len(starts) >= 3
    assert all(b - a >= 30_000 for a, b in zip(starts, starts[1:], strict=False))
    assert all(start % 15_000 == 0 for start in starts), "chapters start where a transcript segment starts"
    assert slots[1].text.startswith("Sentence number")


def test_short_videos_get_no_chapters() -> None:
    segments = [Segment(i * 10_000, i * 10_000 + 8_000, "Hello.") for i in range(17)]
    assert chapter_slots(segments, 170_000) == []


def test_chapter_block_format() -> None:
    assert timestamp(0) == "0:00" and timestamp(75_000) == "1:15" and timestamp(3_725_000) == "1:02:05"
    assert chapter_block([(0, "Intro"), (75_000, "Setup")]) == "Chapters\n0:00 Intro\n1:15 Setup"


# --- The ai.package job ------------------------------------------------------------------------------

TALK = transcript_from([
    (0, "Welcome back to the channel everyone."),
    (4, "Did you know most editing time is spent searching?"),
    (9, "It is true and it surprised me a lot!"),
    (14, "So I started using transcripts for every single video."),
    (20, "Now I find any moment in a few seconds."),
    (26, "That saved me about eleven hours every week."),
    (32, "Here is how you can do the same thing today."),
])  # fmt: skip


def long_talk(minutes: int = 6) -> dict:
    lines = [(i * 12, f"In part {i} we look at transcripts and editing workflow step {i}.") for i in range(minutes * 5)]
    return transcript_from(lines)


class ScriptedProvider:
    """Answers each packaging step with a reply chosen by the prompt; can fail on purpose."""

    name = "fake"
    model = "fake-model-1"

    def __init__(self, overrides: dict[str, list[Any]] | None = None):
        self.overrides = overrides or {}
        self.prompts: list[str] = []

    def check(self) -> None:
        pass

    def generate_json(self, system: str, user: str, schema: dict) -> Any:
        self.prompts.append(user)
        step = (
            "summary" if "Summarise what this part says" in user
            else "titles" if "5 different title options" in user
            else "description" if "engaging description" in user
            else "concepts" if "thumbnail concepts" in user
            else "chapters"
        )  # fmt: skip
        queued = self.overrides.get(step)
        if queued:
            reply = queued.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        if step == "summary":
            return {"summary": "The creator explains how transcripts make editing faster."}
        if step == "titles":
            return {
                "titles": [
                    "Edit Faster With Transcripts",
                    "How I Find Any Moment in Seconds",
                    "Save Eleven Hours a Week Editing",
                    "10 SHOCKING EDITING SECRETS",
                    "Edit Faster With Transcripts",  # duplicate: removed
                ],
                "hooks": ["Most editing time is spent searching.", "I found a faster way to edit.", "Here's my trick."],
            }
        if step == "description":
            return {
                "description": "Searching takes most of the editing time. <b>Transcripts</b> fix that.",
                "hashtags": ["VideoEditing", "transcripts", "#Crypto", "editing"],
            }
        if step == "concepts":
            return {
                "concepts": [
                    {"headline": "Edit in seconds now please really", "composition": "Face left, text right",
                     "emotion": "surprised", "excerpt": 2},
                    {"headline": "Stop searching", "composition": "Close-up", "emotion": "relief", "excerpt": 99},
                ]
            }  # fmt: skip
        sections = [int(part.split('"')[0]) for part in user.split('<excerpt id="')[1:]]
        return {"chapters": [{"id": i, "title": f"Part {i} topic"} for i in sections]}


@pytest.fixture
def run_job(storage: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch):
    def run(transcript: dict, provider: ScriptedProvider, **payload: Any) -> dict:
        path = storage / "videos/v1/transcript.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(transcript), encoding="utf-8")
        monkeypatch.setattr(package, "get_llm_provider", lambda name, s: provider)
        body = {
            "targetKind": "video",
            "targetId": "v1",
            "transcriptPath": "videos/v1/transcript.json",
            "durationMs": transcript["durationMs"],
            "title": "Editing talk",
            "provider": "fake",
            **payload,
        }
        return package.run(body, JobContext("j1", settings, RecordingSink()))

    return run


def test_packaging_is_grounded_cleaned_and_flagged(run_job) -> None:  # type: ignore[no-untyped-def]
    provider = ScriptedProvider()
    result = run_job(TALK, provider, notes="For beginner YouTubers")

    assert [t["text"] for t in result["titles"]] == [
        "Edit Faster With Transcripts",
        "How I Find Any Moment in Seconds",
        "Save Eleven Hours a Week Editing",
        "10 SHOCKING EDITING SECRETS",
    ]
    flagged = result["titles"][3]["flags"]
    assert any("Mentions 10" in f for f in flagged) and any("Sensational" in f for f in flagged)
    assert result["titles"][2]["flags"] == []  # "eleven" is in the transcript
    assert result["description"] == "Searching takes most of the editing time. bTranscripts/b fix that."
    assert result["hashtags"] == ["VideoEditing", "transcripts", "editing"]
    assert result["droppedHashtags"] == ["Crypto"]
    assert any("#Crypto" in w for w in result["warnings"])
    assert result["concepts"][0]["headline"] == "Edit in seconds now please"  # ≤ 5 words
    assert result["concepts"][0]["frameMs"] == 4000  # excerpt 2 = the segment starting at 4 s
    assert result["concepts"][1]["frameMs"] is None  # an excerpt id the AI made up
    assert result["chapters"] == [] and result["usedSummary"] is False  # too short for chapters
    assert (result["provider"], result["model"], result["format"]) == ("fake", "fake-model-1", "long")
    assert "<transcript>" in provider.prompts[0] and "For beginner YouTubers" in provider.prompts[0]


def test_long_videos_are_summarised_and_get_chapters(run_job) -> None:  # type: ignore[no-untyped-def]
    provider = ScriptedProvider()
    result = run_job(long_talk(6), provider, maxInputWords=200)
    assert result["usedSummary"] is True
    assert any("Summarise what this part says" in p for p in provider.prompts)
    assert "<summary>" in next(p for p in provider.prompts if "5 different title options" in p)
    chapters = result["chapters"]
    assert chapters[0]["startMs"] == 0 and len(chapters) >= 3
    assert "\n\nChapters\n0:00 Part 1 topic\n" in result["description"]
    assert len(result["description"].encode("utf-8")) <= 5000


def test_shorts_use_the_edited_captions_and_add_shorts_hashtag(run_job) -> None:  # type: ignore[no-untyped-def]
    provider = ScriptedProvider()
    result = run_job(
        TALK,
        provider,
        targetKind="short",
        targetId="s1",
        rangeStartMs=4000,
        rangeEndMs=13000,
        captionText="Did you know most editing time is spent searching? It surprised me!",
    )
    assert result["format"] == "short" and result["chapters"] == []
    assert result["hashtags"][0] == "Shorts"
    first = provider.prompts[0]
    assert "YouTube Short" in first and "It surprised me!" in first and "Welcome back" not in first


def test_a_malformed_reply_is_retried_once(run_job) -> None:  # type: ignore[no-untyped-def]
    provider = ScriptedProvider({"titles": [LLMReplyError("not json"), {"titles": []}]})
    with pytest.raises(JobError) as error:
        run_job(TALK, provider)
    assert error.value.code == "LLM_BAD_OUTPUT" and "fake-model-1" in error.value.message

    provider = ScriptedProvider({"titles": [{"oops": True}]})
    assert run_job(TALK, provider)["titles"]  # second attempt succeeded


def test_missing_concepts_are_a_warning_not_a_failure(run_job) -> None:  # type: ignore[no-untyped-def]
    provider = ScriptedProvider({"concepts": [{"bad": 1}, {"bad": 2}]})
    result = run_job(TALK, provider)
    assert result["concepts"] == [] and any("thumbnail concepts" in w for w in result["warnings"])


def test_no_speech_is_explained(run_job) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(JobError) as error:
        run_job(transcript_from([(0, "Hi.")]), ScriptedProvider())
    assert error.value.code == "NO_SPEECH"


# --- Thumbnails (PKG-06) -----------------------------------------------------------------------------


def thumb_payload(**overrides: Any) -> dict:
    return {
        "thumbnailId": "t1",
        "mode": "mockup",
        "sourcePath": "videos/v1/source.mp4",
        "outputPath": "thumbnails/t1.jpg",
        "frameMs": 1000,
        "headline": "Edit faster with transcripts today",
        "width": 1280,
        "height": 720,
        **overrides,
    }


@requires_ffmpeg
def test_mockup_is_a_1280x720_jpeg_under_2mb(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", seconds=3, size="1920x1080")
    result = thumbnail_mockup.run(thumb_payload(), JobContext("j1", settings, RecordingSink()))
    path = storage / "thumbnails/t1.jpg"
    with Image.open(path) as image:
        assert (image.format, image.size) == ("JPEG", (1280, 720))
    assert path.stat().st_size < 2 * 1024 * 1024
    assert result == {"outputPath": "thumbnails/t1.jpg", "width": 1280, "height": 720,
                      "sizeBytes": path.stat().st_size, "headline": "Edit faster with transcripts today"}  # fmt: skip


@requires_ffmpeg
def test_vertical_frame_for_a_short(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", seconds=2, size="640x360")
    thumbnail_mockup.run(thumb_payload(mode="frame", headline=None, width=720, height=1280),
                         JobContext("j1", settings, RecordingSink()))  # fmt: skip
    with Image.open(storage / "thumbnails/t1.jpg") as image:
        assert image.size == (720, 1280)


def test_long_headlines_wrap_and_shrink_to_fit() -> None:
    draw = ImageDraw.Draw(Image.new("RGB", (1280, 720)))
    font, lines = fit_headline(draw, "Supercalifragilistic transcripts change everything forever", 1152, 302, 115)
    assert 1 <= len(lines) <= 3
    assert all(draw.textlength(line, font=font) <= 1152 for line in lines)
    assert font.size < 115


def test_uploaded_png_is_reencoded_without_metadata(storage: Path, settings: Settings) -> None:
    source = storage / "thumbnails/uploads/t1.upload"
    source.parent.mkdir(parents=True)
    info = PngImagePlugin.PngInfo()
    info.add_text("Author", "secret location data")
    Image.new("RGBA", (1600, 900), (200, 30, 30, 255)).save(source, "PNG", pnginfo=info)
    thumbnail_mockup.run(
        thumb_payload(mode="upload", sourcePath="thumbnails/uploads/t1.upload", frameMs=None, headline=None),
        JobContext("j1", settings, RecordingSink()),
    )
    output = storage / "thumbnails/t1.jpg"
    with Image.open(output) as image:
        assert (image.format, image.size) == ("JPEG", (1280, 720))
        assert not image.info.get("exif") and "Author" not in image.info
    assert b"secret location data" not in output.read_bytes()
    assert not source.exists(), "the original upload is deleted"


def test_non_images_are_rejected(storage: Path, settings: Settings) -> None:
    source = storage / "thumbnails/uploads/t1.upload"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"\x89PNG\r\n\x1a\n" + b"not really an image" * 20)
    with pytest.raises(JobError) as error:
        thumbnail_mockup.run(
            thumb_payload(mode="upload", sourcePath="thumbnails/uploads/t1.upload", frameMs=None),
            JobContext("j1", settings, RecordingSink()),
        )
    assert error.value.code == "UNSUPPORTED_IMAGE"
    assert not (storage / "thumbnails/t1.jpg").exists()


def test_thumbnail_paths_are_fixed(settings: Settings) -> None:
    with pytest.raises(ValueError):
        thumbnail_mockup.run(
            thumb_payload(outputPath="videos/v1/poster.jpg"), JobContext("j1", settings, RecordingSink())
        )


def test_placeholders_are_flagged() -> None:
    assert any("placeholder" in f for f in checks.flags_for("President [Name] outlines the plan", set()))
    assert not any("placeholder" in f for f in checks.flags_for("A plan for jobs", set()))


def test_hooks_repeating_titles_are_dropped_and_no_shorts_tag_on_long_videos(run_job) -> None:  # type: ignore[no-untyped-def]
    titles = ["Edit Faster With Transcripts", "Find Any Moment", "Stop Searching", "Edit Smarter", "Save Time"]
    hooks = ["Edit Faster With Transcripts", "Most editing time is spent searching."]
    provider = ScriptedProvider({
        "titles": [{"titles": titles, "hooks": hooks}],
        "description": [{"description": "President [Name] explains editing.", "hashtags": ["shorts", "editing"]}],
    })  # fmt: skip
    result = run_job(TALK, provider)
    assert [h["text"] for h in result["hooks"]] == ["Most editing time is spent searching."]
    assert any("repeated the titles" in w for w in result["warnings"])
    assert result["hashtags"] == ["editing"]
    assert any("placeholder" in f for f in result["descriptionFlags"])


def test_names_not_in_the_transcript_are_flagged() -> None:
    vocabulary = checks.source_vocabulary("Experts agree that if nothing is done the American economy suffers.")
    text = "In this video, President Biden discusses the American economy. Learn what experts agree on."
    assert checks.unsupported_names(text, vocabulary) == ["President", "Biden"]
    assert checks.name_flags("Learn how the American economy works.", vocabulary) == []


def test_description_flags_ignore_chapter_times(run_job) -> None:  # type: ignore[no-untyped-def]
    result = run_job(long_talk(6), ScriptedProvider())
    assert "Chapters\n0:00" in result["description"]
    assert result["descriptionFlags"] == []
