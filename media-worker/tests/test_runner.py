from typing import Any

from conftest import RecordingSink

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.runner import run_job


class FakeClient(RecordingSink):
    def __init__(self) -> None:
        super().__init__()
        self.completed: list[tuple[str, dict]] = []
        self.failed: list[tuple[str, str, str, bool]] = []

    def complete(self, job_id: str, result: dict) -> None:
        self.completed.append((job_id, result))

    def fail(self, job_id: str, code: str, message: str, retryable: bool) -> None:
        self.failed.append((job_id, code, message, retryable))


JOB = {"id": "j1", "type": "test.job", "payload": {"n": 1}}


def run_with(runner: Any) -> tuple[str, FakeClient]:
    client = FakeClient()
    outcome = run_job(client, Settings(_env_file=None), JOB, {"test.job": runner})  # type: ignore[arg-type]
    return outcome, client


def test_success_reports_the_result() -> None:
    outcome, client = run_with(lambda payload, ctx: {"double": payload["n"] * 2})
    assert outcome == "succeeded"
    assert client.completed == [("j1", {"double": 2})]


def test_expected_errors_keep_their_code_and_retry_flag() -> None:
    def runner(payload: Any, ctx: JobContext) -> dict:
        raise JobError("INVALID_VIDEO", "Not a video.", retryable=False)

    outcome, client = run_with(runner)
    assert outcome == "failed"
    assert client.failed == [("j1", "INVALID_VIDEO", "Not a video.", False)]


def test_crashes_are_retryable_and_hide_internal_details() -> None:
    def runner(payload: Any, ctx: JobContext) -> dict:
        raise RuntimeError("secret internal detail")

    outcome, client = run_with(runner)
    _, code, message, retryable = client.failed[0]
    assert outcome == "failed"
    assert code == "WORKER_ERROR" and retryable
    assert "secret" not in message


def test_cancellation_is_reported() -> None:
    def runner(payload: Any, ctx: JobContext) -> dict:
        ctx._sink.cancel_after = 0  # type: ignore[attr-defined]
        ctx.progress(10, "working")
        return {}

    outcome, client = run_with(runner)
    assert outcome == "cancelled"
    assert client.failed[0][1] == "CANCELLED"


def test_unknown_job_types_fail_permanently() -> None:
    client = FakeClient()
    assert run_job(client, Settings(_env_file=None), {**JOB, "type": "nope"}, {}) == "failed"  # type: ignore[arg-type]
    assert client.failed[0][1] == "UNKNOWN_TYPE"
