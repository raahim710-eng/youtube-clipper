"""media.reframe â€” find the main face in a Short's range and compute a smooth crop path (SHORT-03).

Result fields match `mediaReframeResultSchema` in src/server/jobs/media-reframe.ts.
"""

import logging
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, model_validator

from media_worker import ffmpeg
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.jobs.ingest import analyse
from media_worker.shorts.face_model import YUNET_FILE, FaceDetector, YuNetDetector, ensure_model
from media_worker.shorts.framing import TARGET_ASPECT, crop_box
from media_worker.shorts.tracking import Sample, build_path, cut_score, detect_cuts, frame_signature
from media_worker.storage import resolve_storage_path

log = logging.getLogger(__name__)
# No frame for this long: FFmpeg is stuck (well under the job's 60 s lease).
STALL_TIMEOUT_S = 45

ANALYSIS_WIDTH = 320
MAX_ANALYSIS_FPS = 15.0
FACE_SAMPLES_PER_SECOND = 5.0


class ReframePayload(BaseModel):
    shortId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)

    @model_validator(mode="after")
    def _range(self) -> "ReframePayload":
        if not 1_000 <= self.endMs - self.startMs <= 201_000:  # a Short (≤ 3 min) plus 10 s on each side
            raise ValueError("range must be 1 s to 3 min 20 s")
        return self


def _even(value: float) -> int:
    return max(2, round(value / 2) * 2)


def analyse_frames(
    ffmpeg_bin: str,
    source: Path,
    start_ms: int,
    end_ms: int,
    size: tuple[int, int],
    fps: float,
    detector: FaceDetector,
    on_progress: Any,
) -> tuple[list[Sample], list[int]]:
    """Decodes the range at `fps` and `size`; returns face samples (~5 per second) and cut times (ms)."""
    width, height = size
    frame_bytes = width * height * 3
    duration_s = (end_ms - start_ms) / 1000
    cmd = [
        ffmpeg_bin, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{start_ms / 1000:.3f}", "-t", f"{duration_s:.3f}", "-i", str(source),
        "-map", "0:v:0", "-vf", f"fps={fps:g},scale={width}:{height}",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1",
    ]  # fmt: skip
    process = subprocess.Popen(
        ffmpeg.limit_threads(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=ffmpeg._NO_WINDOW
    )
    stderr_tail: list[bytes] = []
    # Watchdog: if FFmpeg stops sending frames, kill it before the job's 60 s lease runs out, instead of
    # blocking on read() forever while the job is handed to another worker.
    last_frame = [time.monotonic()]
    stalled = threading.Event()

    def watchdog() -> None:
        while process.poll() is None:
            if time.monotonic() - last_frame[0] > STALL_TIMEOUT_S:
                stalled.set()
                ffmpeg.stop_process(process)
                return
            time.sleep(2)

    threading.Thread(target=watchdog, daemon=True).start()

    def pump_stderr() -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            stderr_tail.append(line)
            del stderr_tail[:-10]

    threading.Thread(target=pump_stderr, daemon=True).start()

    import numpy as np

    face_every = max(1, round(fps / FACE_SAMPLES_PER_SECOND))
    expected = max(1, int(duration_s * fps))
    samples: list[Sample] = []
    scores: list[float] = []
    times: list[int] = []
    previous = None
    index = 0
    if process.stdout is None:
        raise JobError("TRANSCODE_FAILED", "The video couldn't be read for face detection.", retryable=True)
    try:
        while True:
            chunk = process.stdout.read(frame_bytes)
            if not chunk or len(chunk) < frame_bytes:
                break
            frame = np.frombuffer(chunk, dtype=np.uint8).reshape(height, width, 3)
            t_ms = start_ms + round(index * 1000 / fps)
            signature = frame_signature(frame)
            scores.append(0.0 if previous is None else cut_score(previous, signature))
            times.append(t_ms)
            previous = signature
            if index % face_every == 0:
                samples.append(Sample(t_ms=t_ms, faces=detector.detect(frame)))
            index += 1
            last_frame[0] = time.monotonic()
            on_progress(min(1.0, index / expected))
        code = process.wait(timeout=60)
    except BaseException:
        ffmpeg.stop_process(process)
        raise
    if stalled.is_set():
        raise JobError("FFMPEG_STALLED", "Reading the video for face detection got stuck.", retryable=True)
    if code != 0 or not samples:
        log.warning("Face-detection decode failed (%s): %s", code, b" | ".join(stderr_tail[-5:])[:1000])
        raise JobError("TRANSCODE_FAILED", "The video couldn't be read for face detection.", retryable=True)
    return samples, detect_cuts(scores, times)


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = ReframePayload.model_validate(raw_payload)
    settings = ctx.settings
    source = resolve_storage_path(payload.sourcePath, settings.storage_root)
    if not source.is_file():
        raise JobError("SOURCE_MISSING", "The original video file is missing.", retryable=False)
    ffprobe_bin = ffmpeg.require_binary("ffprobe", settings.ffprobe_path)
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", settings.ffmpeg_path)

    ctx.progress(2, "Reading video details")
    info = analyse(ffmpeg.probe(ffprobe_bin, source))
    base = {"startMs": payload.startMs, "endMs": payload.endMs, "model": None}
    if info.width / info.height <= TARGET_ASPECT + 0.01:
        return {
            **base,
            "keyframes": [{"tMs": payload.startMs, "x": 0.5}],
            "shots": 1,
            "shotsWithFace": 0,
            "faceSamples": 0,
            "samples": 0,
            "warnings": ["This video is already vertical, so no side-to-side framing is needed."],
        }

    with ctx.keepalive("Preparing face detection"):
        model_file = ensure_model(settings.face_models_root)
    width = ANALYSIS_WIDTH
    height = _even(width * info.height / info.width)
    detector = YuNetDetector(model_file, width, height)
    fps = min(info.fps or 25.0, MAX_ANALYSIS_FPS)

    samples, cuts = analyse_frames(
        ffmpeg_bin,
        source,
        payload.startMs,
        payload.endMs,
        (width, height),
        fps,
        detector,
        lambda fraction: ctx.progress(5 + 90 * fraction, "Finding faces"),
    )
    box = crop_box(info.width, info.height)
    path = build_path(samples, cuts, box.width / info.width, payload.endMs)

    warnings: list[str] = []
    if path.face_samples == 0:
        warnings.append("No faces were found, so the crop stays centred. Choose Manual to set the position yourself.")
    elif path.shots_with_face < path.shots:
        missing = path.shots - path.shots_with_face
        warnings.append(f"{missing} of {path.shots} shots had no visible face and stay centred.")
    ctx.progress(98, "Saving framing")
    return {
        **base,
        "model": f"YuNet ({YUNET_FILE})",
        "keyframes": [{"tMs": t, "x": x} for t, x in path.keyframes],
        "shots": path.shots,
        "shotsWithFace": path.shots_with_face,
        "faceSamples": path.face_samples,
        "samples": path.samples,
        "warnings": warnings,
    }
