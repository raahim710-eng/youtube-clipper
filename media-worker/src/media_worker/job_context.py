import contextlib
import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Protocol

from media_worker.config import Settings
from media_worker.errors import JobCancelled

log = logging.getLogger(__name__)


class ProgressSink(Protocol):
    def heartbeat(self, job_id: str, progress: float, message: str | None) -> bool: ...


class JobContext:
    """Passed to every job. `progress()` sends throttled heartbeats (which also extend the job's
    lease) and raises JobCancelled when the user cancelled the job."""

    def __init__(self, job_id: str, settings: Settings, sink: ProgressSink, *, min_interval_s: float = 2.0):
        self.job_id = job_id
        self.settings = settings
        self._sink = sink
        self._min_interval_s = min_interval_s
        self._last_sent = 0.0
        self._last_message: str | None = None
        self._last_percent = 0.0
        self._cancel_requested = False

    def _send(self, percent: float, message: str | None) -> None:
        try:
            cancel = self._sink.heartbeat(self.job_id, percent, message)
        except Exception as error:
            # 409: the app no longer considers this worker the job's owner (lease lost or job cancelled) — stop.
            # Anything else (app restarting, database busy) is retried with the next heartbeat; the lease
            # (60 s) outlasts a short outage, so a long render isn't thrown away for one failed request.
            if getattr(getattr(error, "response", None), "status_code", None) == 409:
                cancel = True
            else:
                log.warning("Heartbeat for job %s failed (%s); continuing.", self.job_id, type(error).__name__)
                return
        if cancel:
            self._cancel_requested = True

    def progress(self, percent: float, message: str | None = None) -> None:
        if self._cancel_requested:
            raise JobCancelled()
        self._last_percent = percent
        now = time.monotonic()
        if message == self._last_message and now - self._last_sent < self._min_interval_s:
            return
        self._last_sent = now
        self._last_message = message
        self._send(percent, message)
        if self._cancel_requested:
            raise JobCancelled()

    @contextmanager
    def keepalive(self, message: str, interval_s: float = 10.0) -> Iterator[None]:
        """For steps that block for a long time (loading a model, waiting for an AI reply):
        keeps sending heartbeats from a background thread so the job's lease doesn't expire.
        A cancellation seen meanwhile is raised when the step finishes."""
        self.progress(self._last_percent, message)
        stop = threading.Event()

        def beat() -> None:
            while not stop.wait(interval_s):
                # A missed heartbeat is simply retried on the next tick.
                with contextlib.suppress(Exception):
                    self._send(self._last_percent, message)

        thread = threading.Thread(target=beat, daemon=True)
        thread.start()
        try:
            yield
        finally:
            stop.set()
            thread.join(timeout=5)
        if self._cancel_requested:
            raise JobCancelled()
