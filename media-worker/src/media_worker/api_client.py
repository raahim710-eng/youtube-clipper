import time
from typing import Any

import httpx

# Reporting a finished job is retried on network errors and server errors (e.g. the database was busy),
# so hours of work aren't redone because of one failed request.
REPORT_RETRY_DELAYS_S = (1.0, 3.0, 8.0)


class ApiClient:
    """Talks to the web app's internal worker API (/api/internal/*). The worker never touches the database."""

    def __init__(self, base_url: str, secret: str, worker_id: str, *, transport: httpx.BaseTransport | None = None):
        self.worker_id = worker_id
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {secret}"},
            timeout=httpx.Timeout(30.0, connect=5.0),
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def _post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        response = self._client.post(path, json=body)
        response.raise_for_status()
        return response

    def worker_heartbeat(self, version: str, capabilities: dict[str, Any]) -> None:
        self._post(
            "/api/internal/workers/heartbeat",
            {"workerId": self.worker_id, "kind": "python", "version": version, "capabilities": capabilities},
        )

    def claim(self, types: list[str]) -> dict[str, Any] | None:
        response = self._post("/api/internal/jobs/claim", {"workerId": self.worker_id, "types": types})
        return None if response.status_code == 204 else response.json()

    def heartbeat(self, job_id: str, progress: float, message: str | None) -> bool:
        """Returns True when the user asked to cancel the job."""
        body: dict[str, Any] = {"workerId": self.worker_id, "progress": max(0.0, min(100.0, progress))}
        if message:
            body["message"] = message[:200]
        return bool(self._post(f"/api/internal/jobs/{job_id}/heartbeat", body).json().get("cancelRequested"))

    def _report(self, path: str, body: dict[str, Any]) -> None:
        for delay in (*REPORT_RETRY_DELAYS_S, None):
            try:
                self._post(path, body)
                return
            except httpx.HTTPStatusError as error:
                if error.response.status_code < 500 or delay is None:
                    raise
            except httpx.TransportError:
                if delay is None:
                    raise
            time.sleep(delay)

    def complete(self, job_id: str, result: dict[str, Any]) -> None:
        self._report(f"/api/internal/jobs/{job_id}/complete", {"workerId": self.worker_id, "result": result})

    def fail(self, job_id: str, code: str, message: str, retryable: bool) -> None:
        self._report(
            f"/api/internal/jobs/{job_id}/fail",
            {"workerId": self.worker_id, "code": code[:50], "message": message[:500], "retryable": retryable},
        )
