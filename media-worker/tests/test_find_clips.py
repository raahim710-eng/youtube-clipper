import json
from pathlib import Path
from typing import Any

import pytest
from conftest import RecordingSink
from test_candidates import TALK

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.jobs import find_clips
from media_worker.llm import LLMReplyError


class FakeProvider:
    """Stands in for a real AI provider; scripted replies per call."""

    name = "fake"
    model = "fake-model-1"

    def __init__(self, replies: list[Any]):
        self.replies = replies
        self.prompts: list[str] = []

    def check(self) -> None:
        pass

    def generate_json(self, system: str, user: str, schema: dict) -> Any:
        self.prompts.append(user)
        reply = self.replies.pop(0) if self.replies else None
        if isinstance(reply, Exception):
            raise reply
        if callable(reply):
            return reply(user)
        return reply


def rate_all(score: int = 70):  # type: ignore[no-untyped-def]
    """A reply that rates every excerpt id found in the prompt."""

    def reply(user: str) -> dict:
        ids = [int(part.split('"')[0]) for part in user.split('<excerpt id="')[1:]]
        return {"clips": [{"id": i, "score": score, "title": f"Title {i}", "hook": "Hook", "reason": "Because.",
                           "category": "surprising_fact"} for i in ids]}  # fmt: skip

    return reply


@pytest.fixture
def transcript(storage: Path) -> str:
    path = storage / "videos/v1/transcript.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(TALK), encoding="utf-8")
    return "videos/v1/transcript.json"


def run(transcript: str, settings: Settings, **payload: Any) -> dict:
    body = {"videoId": "v1", "transcriptPath": transcript, "minSec": 5, "maxSec": 20, "aiCandidates": 6, **payload}
    return find_clips.run(body, JobContext("j1", settings, RecordingSink(), min_interval_s=0))


def word_edges() -> tuple[set[int], set[int]]:
    words = [w for s in TALK["segments"] for w in s["words"]]
    return {w[0] for w in words}, {w[1] for w in words}


def test_speech_pattern_mode_never_claims_ai(transcript: str, settings: Settings) -> None:
    result = run(transcript, settings, mode="heuristic")
    assert result["mode"] == "heuristic" and result["provider"] is None and result["model"] is None
    assert result["clips"] and all(c["aiScore"] is None and c["category"] is None for c in result["clips"])
    assert all(c["reason"] for c in result["clips"])


def test_ai_mode_uses_real_transcript_timings_and_names_the_model(
    transcript: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeProvider([rate_all(80)] * 10)
    monkeypatch.setattr(find_clips, "get_llm_provider", lambda name, s: fake)
    result = run(transcript, settings, mode="ai", provider="ollama")

    assert result["mode"] == "ai" and result["model"] == "fake-model-1"
    starts, ends = word_edges()
    for clip in result["clips"]:
        # Padded bounds: within 150/300 ms of real word edges, never invented by the AI.
        assert any(0 <= s - clip["startMs"] <= 150 for s in starts)
        assert any(0 <= clip["endMs"] - e <= 300 for e in ends)
        assert clip["aiScore"] == 80 and clip["category"] == "surprising_fact"
        assert clip["transcriptText"] in " ".join(seg["text"] for seg in TALK["segments"])
    # Excerpts are sent one per request by default.
    assert all(p.count("<excerpt") == 1 for p in fake.prompts)


def test_ids_the_ai_invents_are_ignored_and_unrated_moments_dropped(
    transcript: str, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    bogus = {"clips": [{"id": 9999, "score": 99, "title": "x", "hook": "", "reason": "y", "category": "story"}]}
    fake = FakeProvider([bogus, rate_all(60)] + [bogus] * 10)
    monkeypatch.setattr(find_clips, "get_llm_provider", lambda name, s: fake)
    result = run(transcript, settings, mode="ai", provider="ollama")
    assert len(result["clips"]) >= 1
    assert all(c["aiScore"] == 60 for c in result["clips"])
    assert result["warnings"]


def test_malformed_replies_are_retried_once(transcript: str, settings: Settings, monkeypatch) -> None:  # noqa: ANN001
    fake = FakeProvider([LLMReplyError("bad"), rate_all(70)] * 10)
    monkeypatch.setattr(find_clips, "get_llm_provider", lambda name, s: fake)
    result = run(transcript, settings, mode="ai", provider="ollama", aiCandidates=1)
    assert result["ratedCandidates"] == 1 and not result["warnings"]


def test_no_usable_ai_answers_fails_honestly(transcript: str, settings: Settings, monkeypatch) -> None:  # noqa: ANN001
    fake = FakeProvider([LLMReplyError("bad")] * 50)
    monkeypatch.setattr(find_clips, "get_llm_provider", lambda name, s: fake)
    with pytest.raises(JobError) as error:
        run(transcript, settings, mode="ai", provider="ollama")
    assert error.value.code == "LLM_BAD_OUTPUT" and "speech patterns only" in error.value.message


def test_provider_problems_stop_the_job_with_the_fix(transcript: str, settings: Settings, monkeypatch) -> None:  # noqa: ANN001
    class Broken(FakeProvider):
        def check(self) -> None:
            raise JobError("LLM_CREDENTIALS", "Gemini needs an API key.", retryable=False)

    monkeypatch.setattr(find_clips, "get_llm_provider", lambda name, s: Broken([]))
    with pytest.raises(JobError) as error:
        run(transcript, settings, mode="ai", provider="gemini")
    assert error.value.code == "LLM_CREDENTIALS"


def test_no_speech_is_reported(storage: Path, settings: Settings) -> None:
    path = storage / "videos/v1/transcript.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"version": 1, "durationMs": 5000, "segments": []}), encoding="utf-8")
    with pytest.raises(JobError) as error:
        run("videos/v1/transcript.json", settings, mode="heuristic")
    assert error.value.code == "NO_SPEECH"
