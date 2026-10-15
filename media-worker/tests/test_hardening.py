"""Phase 10 hardening: reporting retries, heartbeat resilience, thread limits, log redaction, cache damage."""

import json
import logging
from pathlib import Path

import httpx
import pytest
from conftest import RecordingSink

from media_worker import api_client, ffmpeg
from media_worker.api_client import ApiClient
from media_worker.config import Settings
from media_worker.errors import JobCancelled
from media_worker.generator.stock import SearchCache
from media_worker.job_context import JobContext
from media_worker.runner import RedactSecrets


def client_with(handler) -> ApiClient:  # type: ignore[no-untyped-def]
    return ApiClient("http://app", "s" * 40, "w1", transport=httpx.MockTransport(handler))


def test_finished_work_is_reported_again_after_a_server_hiccup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_client, "REPORT_RETRY_DELAYS_S", (0, 0, 0))
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503 if len(calls) < 3 else 200, json={})

    client_with(handler).complete("j1", {"ok": True})
    assert len(calls) == 3


def test_a_refused_result_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_client, "REPORT_RETRY_DELAYS_S", (0, 0, 0))
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(409, json={})

    with pytest.raises(httpx.HTTPStatusError):
        client_with(handler).fail("j1", "X", "y", retryable=False)
    assert len(calls) == 1


class FlakySink(RecordingSink):
    def __init__(self, error: Exception):
        super().__init__()
        self.error = error

    def heartbeat(self, job_id: str, progress: float, message: str | None) -> bool:
        raise self.error


def test_one_failed_heartbeat_doesnt_stop_a_long_job(settings: Settings) -> None:
    ctx = JobContext("j1", settings, FlakySink(httpx.ConnectError("app restarting")), min_interval_s=0)
    ctx.progress(10, "Rendering")  # no exception: the next heartbeat will try again


def test_a_lost_lease_stops_the_job(settings: Settings) -> None:
    response = httpx.Response(409, request=httpx.Request("POST", "http://app/x"))
    error = httpx.HTTPStatusError("conflict", request=response.request, response=response)
    ctx = JobContext("j1", settings, FlakySink(error), min_interval_s=0)
    with pytest.raises(JobCancelled):
        ctx.progress(10, "Rendering")


def test_thread_limit_reaches_every_input_filter_and_encoder() -> None:
    cmd = ["ffmpeg", "-y", "-i", "a.mp4", "-i", "b.wav", "-c:v", "libx264", "out.mp4"]
    ffmpeg.set_thread_limit(0)
    assert ffmpeg.limit_threads(cmd) == cmd
    ffmpeg.set_thread_limit(1)
    try:
        assert ffmpeg.limit_threads(cmd) == [
            "ffmpeg", "-filter_threads", "1", "-filter_complex_threads", "1", "-y",
            "-threads", "1", "-i", "a.mp4", "-threads", "1", "-i", "b.wav", "-c:v", "libx264",
            "-threads", "1", "out.mp4",
        ]  # fmt: skip
    finally:
        ffmpeg.set_thread_limit(0)


def test_logs_never_show_keys_or_tokens() -> None:
    record = logging.LogRecord(
        "x", logging.WARNING, __file__, 1,
        "GET https://pixabay.com/api/videos/?key=abc123secret&q=sea failed; Authorization: Bearer ya29.tokenvalue",
        None, None,
    )  # fmt: skip
    RedactSecrets().filter(record)
    text = record.getMessage()
    assert "abc123secret" not in text and "ya29.tokenvalue" not in text
    assert "key=[redacted]" in text and "q=sea" in text


def test_a_damaged_search_cache_file_is_just_a_miss(tmp_path: Path) -> None:
    cache = SearchCache(tmp_path)
    cache.put("pexels", "ocean", {"videos": [1]})
    assert cache.get("pexels", "ocean") == {"videos": [1]}
    entry = next((tmp_path / "search" / "pexels").glob("*.json"))
    entry.write_text("{not json", encoding="utf-8")
    assert cache.get("pexels", "ocean") is None
    cache.put("pexels", "ocean", {"videos": [2]})
    assert json.loads(entry.read_text(encoding="utf-8"))["data"] == {"videos": [2]}
    assert not list((tmp_path / "search" / "pexels").glob("*.partial"))
