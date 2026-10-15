"""media.ingest — validate an uploaded video, read its details, make a poster and (if needed) a preview.

Result fields match `mediaIngestResultSchema` in src/server/jobs/media-ingest.ts.
"""

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from media_worker import ffmpeg
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.storage import resolve_storage_path


class IngestPayload(BaseModel):
    videoId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    outputDir: str = Field(min_length=1)
    maxDurationMinutes: int = Field(gt=0)


@dataclass
class VideoInfo:
    duration_s: float | None
    width: int
    height: int
    fps: float | None
    video_codec: str
    audio_codec: str | None
    pix_fmt: str | None


# What browsers can play directly (Chrome, Edge and Firefox).
_MP4_VIDEO = {"h264", "av1", "vp9"}
_MP4_AUDIO = {None, "aac", "mp3", "opus"}
_WEBM_VIDEO = {"vp8", "vp9", "av1"}
_WEBM_AUDIO = {None, "opus", "vorbis"}
_BROWSER_PIX_FMTS = {None, "yuv420p", "yuvj420p"}


def _parse_rate(value: str | None) -> float | None:
    if not value or "/" not in value:
        return None
    num, den = value.split("/", 1)
    try:
        rate = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        return None
    return round(rate, 3) if 0 < rate < 1000 else None


def _parse_duration(*candidates: Any) -> float | None:
    for value in candidates:
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(seconds) and seconds > 0:
            return seconds
    return None


def _rotation(stream: dict[str, Any]) -> int:
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            try:
                return int(float(side["rotation"])) % 360
            except (TypeError, ValueError):
                pass
    try:
        return int((stream.get("tags") or {}).get("rotate", 0)) % 360
    except (TypeError, ValueError):
        return 0


def analyse(probe: dict[str, Any]) -> VideoInfo:
    streams = probe.get("streams") or []
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")),
        None,
    )
    if video is None:
        raise JobError(
            "INVALID_VIDEO", "No video track was found. The file may be audio-only or damaged.", retryable=False
        )
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    if width <= 0 or height <= 0:
        raise JobError(
            "INVALID_VIDEO", "The video track has no picture size. The file may be damaged.", retryable=False
        )
    if _rotation(video) in (90, 270):  # phone videos recorded upright
        width, height = height, width

    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    return VideoInfo(
        duration_s=_parse_duration((probe.get("format") or {}).get("duration"), video.get("duration")),
        width=width,
        height=height,
        fps=_parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate")),
        video_codec=str(video.get("codec_name") or "unknown"),
        audio_codec=str(audio["codec_name"]) if audio and audio.get("codec_name") else None,
        pix_fmt=video.get("pix_fmt"),
    )


def needs_preview(container: str, info: VideoInfo) -> bool:
    """True when browsers can't reliably play the original, so a preview copy is made."""
    if info.pix_fmt not in _BROWSER_PIX_FMTS:
        return True  # e.g. 10-bit or 4:2:2 video
    if container in ("mp4", "m4v"):
        return not (info.video_codec in _MP4_VIDEO and info.audio_codec in _MP4_AUDIO)
    if container == "webm":
        return not (info.video_codec in _WEBM_VIDEO and info.audio_codec in _WEBM_AUDIO)
    return True  # MOV, MKV and AVI don't play everywhere


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = IngestPayload.model_validate(raw_payload)
    settings = ctx.settings
    root = settings.storage_root
    source = resolve_storage_path(payload.sourcePath, root)
    output_dir = resolve_storage_path(payload.outputDir, root)
    if not source.is_file():
        raise JobError(
            "SOURCE_MISSING", "The uploaded file is missing. Delete this video and upload it again.", retryable=False
        )
    output_dir.mkdir(parents=True, exist_ok=True)

    ffprobe_bin = ffmpeg.require_binary("ffprobe", settings.ffprobe_path)
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", settings.ffmpeg_path)

    ctx.progress(5, "Reading video details")
    info = analyse(ffmpeg.probe(ffprobe_bin, source))
    if info.duration_s and info.duration_s > payload.maxDurationMinutes * 60:
        minutes = math.ceil(info.duration_s / 60)
        raise JobError(
            "TOO_LONG",
            f"This video is about {minutes} minutes long. The limit is {payload.maxDurationMinutes} minutes "
            "(MAX_VIDEO_DURATION_MIN in .env).",
            retryable=False,
        )

    ctx.progress(15, "Creating thumbnail")
    poster = output_dir / "poster.jpg"
    at = min(info.duration_s * 0.1, 5.0) if info.duration_s else 0.0
    has_poster = ffmpeg.extract_frame(ffmpeg_bin, source, poster, at) or ffmpeg.extract_frame(
        ffmpeg_bin, source, poster, 0.0
    )

    container = Path(payload.sourcePath).suffix.lstrip(".").lower()
    preview_path: str | None = None
    if needs_preview(container, info):
        ctx.progress(25, "Creating a browser-friendly preview")
        preview = output_dir / "preview.mp4"
        ffmpeg.transcode_preview(
            ffmpeg_bin,
            source,
            preview,
            info.duration_s,
            lambda fraction: ctx.progress(25 + 70 * fraction, "Creating a browser-friendly preview"),
        )
        preview_path = f"{payload.outputDir}/preview.mp4"

    ctx.progress(98, "Saving details")
    return {
        "durationMs": round(info.duration_s * 1000) if info.duration_s else None,
        "width": info.width,
        "height": info.height,
        "fps": info.fps,
        "videoCodec": info.video_codec[:50],
        "audioCodec": info.audio_codec[:50] if info.audio_codec else None,
        "posterPath": f"{payload.outputDir}/poster.jpg" if has_poster else None,
        "previewPath": preview_path,
    }
