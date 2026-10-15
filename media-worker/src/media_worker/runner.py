"""Worker main loop: claim a job, run it, report the outcome, repeat."""

import logging
import os
import re
import socket
import time
import uuid
from typing import Any

import httpx

from media_worker import __version__, ffmpeg
from media_worker.api_client import ApiClient
from media_worker.config import Settings, get_settings
from media_worker.errors import JobCancelled, JobError
from media_worker.job_context import JobContext
from media_worker.jobs import REGISTRY, JobRunner

log = logging.getLogger("media_worker")

WORKER_HEARTBEAT_EVERY_S = 15.0


def _transcription_status(settings: Settings) -> str | None:
    """Version string if the transcription engine can load, else None (shown on System status)."""
    if settings.transcription_provider != "faster-whisper":
        return None
    try:
        import faster_whisper

        return f"faster-whisper {faster_whisper.__version__} ({settings.whisper_model})"
    except Exception:  # e.g. missing Visual C++ runtime on Windows
        return None


def _face_tracking_status(settings: Settings) -> str | None:
    """OpenCV version and whether the face model is already downloaded, or None if OpenCV can't load."""
    try:
        import cv2
    except Exception:
        return None
    from media_worker.shorts.face_model import model_path

    model = "ready" if model_path(settings.face_models_root).is_file() else "downloads on first use (~230 KB)"
    return f"OpenCV {cv2.__version__}, YuNet model {model}"


def _tts_status(settings: Settings) -> str | None:
    """Installed voices for the configured text-to-speech provider (shown in the generator)."""
    try:
        from media_worker.generator.tts import SapiProvider, get_tts_provider

        provider = get_tts_provider(settings.tts_provider, settings)
        provider.check()
        if isinstance(provider, SapiProvider):
            return "sapi:" + "|".join(v["name"] for v in provider.voices())
        return f"{provider.name}:{provider.voice}"
    except Exception as error:  # reported, not fatal: other jobs still work
        log.warning("Text-to-speech isn't available: %s", getattr(error, "message", error))
        return None


def capabilities(settings: Settings) -> dict[str, Any]:
    ffmpeg_bin = ffmpeg.find_binary("ffmpeg", settings.ffmpeg_path)
    return {
        "ffmpeg": ffmpeg.ffmpeg_version(ffmpeg_bin),
        "ffprobe": ffmpeg.find_binary("ffprobe", settings.ffprobe_path) is not None,
        "transcription": _transcription_status(settings),
        "faceTracking": _face_tracking_status(settings),
        "captions": ffmpeg.has_filter(ffmpeg_bin, "ass"),
        "tts": _tts_status(settings),
        "stockProviders": ",".join(
            n for n, k in (("pexels", settings.pexels_api_key), ("pixabay", settings.pixabay_api_key)) if k
        ),
        "jobTypes": ",".join(sorted(REGISTRY)),
    }


_SECRET_PATTERNS = [
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"), r"\1[redacted]"),
    (
        re.compile(r"(?i)\b(key|api_key|apikey|token|access_token|refresh_token|secret|password)=([^&\s'\"]+)"),
        r"\1=[redacted]",
    ),
    (re.compile(r"(?i)(\"(?:authorization|x-goog-api-key|api_key|token|secret)\"\s*:\s*\")[^\"]+"), r"\1[redacted]"),
]


class RedactSecrets(logging.Filter):
    """Masks API keys and tokens in log lines (e.g. a Pixabay URL with `key=` inside an error), SECURITY.md §6."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = message
        for pattern, replacement in _SECRET_PATTERNS:
            redacted = pattern.sub(replacement, redacted)
        if redacted != message:
            record.msg, record.args = redacted, None
        if record.exc_info and not record.exc_text:
            text = logging.Formatter().formatException(record.exc_info)
            for pattern, replacement in _SECRET_PATTERNS:
                text = pattern.sub(replacement, text)
            record.exc_text = text
        return True


def run_job(client: ApiClient, settings: Settings, job: dict[str, Any], registry: dict[str, JobRunner]) -> str:
    """Runs one claimed job and reports the outcome. Returns "succeeded", "failed" or "cancelled"."""
    job_id, job_type = job["id"], job["type"]
    runner = registry.get(job_type)
    if runner is None:
        client.fail(job_id, "UNKNOWN_TYPE", f"This worker can't run {job_type} jobs.", retryable=False)
        return "failed"

    ctx = JobContext(job_id, settings, client)
    try:
        result = runner(job["payload"], ctx)
    except JobCancelled:
        log.info("Job %s cancelled", job_id)
        client.fail(job_id, "CANCELLED", "Cancelled by you.", retryable=False)
        return "cancelled"
    except JobError as error:
        log.warning("Job %s failed: %s (%s)", job_id, error.message, error.code)
        client.fail(job_id, error.code, error.message, error.retryable)
        return "failed"
    except Exception:
        log.exception("Job %s crashed", job_id)
        client.fail(job_id, "WORKER_ERROR", "Something went wrong while processing. It will be retried.", True)
        return "failed"

    client.complete(job_id, result)
    log.info("Job %s (%s) done", job_id, job_type)
    return "succeeded"


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s [media-worker] %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # don't log every poll
    for handler in logging.getLogger().handlers:
        handler.addFilter(RedactSecrets())
    ffmpeg.set_thread_limit(settings.render_threads)
    if len(settings.worker_shared_secret) < 32:
        log.error("WORKER_SHARED_SECRET is missing or shorter than 32 characters. Run `npm run setup:env`.")
        raise SystemExit(2)

    worker_id = f"python-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    client = ApiClient(settings.app_internal_url, settings.worker_shared_secret, worker_id)
    poll_s = max(settings.worker_poll_interval_ms, 250) / 1000
    caps = capabilities(settings)
    if not caps["ffmpeg"]:
        log.warning("FFmpeg not found — videos will fail processing until it is installed.")
    log.info("Worker %s ready (storage: %s, app: %s)", worker_id, settings.storage_root, settings.app_internal_url)

    last_worker_heartbeat = 0.0
    app_reachable = True
    try:
        while True:
            try:
                if time.monotonic() - last_worker_heartbeat > WORKER_HEARTBEAT_EVERY_S:
                    client.worker_heartbeat(__version__, caps)
                    last_worker_heartbeat = time.monotonic()
                job = client.claim(list(REGISTRY))
                if not app_reachable:
                    log.info("Connected to the app again.")
                    app_reachable = True
            except httpx.TransportError:
                if app_reachable:
                    log.warning(
                        "Can't reach the app at %s — is `npm run dev` running? Retrying…", settings.app_internal_url
                    )
                    app_reachable = False
                time.sleep(5)
                continue
            except httpx.HTTPStatusError as error:
                log.error("The app rejected the worker (%s). Check WORKER_SHARED_SECRET.", error.response.status_code)
                time.sleep(10)
                continue

            if job is None:
                time.sleep(poll_s)
                continue
            log.info("Running job %s (%s, attempt %s)", job["id"], job["type"], job.get("attempt"))
            try:
                run_job(client, settings, job, REGISTRY)
            except KeyboardInterrupt:
                client.fail(job["id"], "WORKER_STOPPED", "The worker was stopped; it will be retried.", True)
                raise
            except httpx.HTTPError:
                # Couldn't report the outcome; the job's lease will expire and it will be retried.
                log.exception("Couldn't report the result of job %s", job["id"])
    except KeyboardInterrupt:
        log.info("Worker stopped.")
    finally:
        client.close()
