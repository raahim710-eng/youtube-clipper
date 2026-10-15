"""media.render_short — export a Short as a 1080×1920 H.264/AAC MP4 with burned-in captions (SHORT-05).

Result fields match `mediaRenderShortResultSchema` in src/server/jobs/media-render-short.ts.
"""

import shutil
import time
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from media_worker import ffmpeg
from media_worker.config import FONTS_DIR
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.jobs.ingest import analyse
from media_worker.shorts.ass import Cue, TextStyle, build_ass
from media_worker.shorts.framing import OUT_H, OUT_W, Keyframe, video_filter
from media_worker.storage import resolve_storage_path

MAX_FPS = 60.0
# x264 settings per export quality (TECHNICAL_SPEC.md §7.3). "standard" keeps exports quick on slow CPUs.
QUALITY = {"standard": ("veryfast", "20"), "high": ("medium", "18")}


class KeyframeIn(BaseModel):
    tMs: int = Field(ge=0)
    x: float = Field(ge=0, le=1)


class Framing(BaseModel):
    mode: Literal["crop", "blur"]
    keyframes: list[KeyframeIn] = Field(default_factory=list, max_length=500)


class Hook(BaseModel):
    text: str = Field(min_length=1, max_length=200)
    endMs: int = Field(gt=0)
    style: TextStyle


class RenderPayload(BaseModel):
    shortId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    outputPath: str = Field(min_length=1)
    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)
    framing: Framing
    captions: list[Cue] = Field(default_factory=list, max_length=2000)
    captionStyle: TextStyle | None = None
    hook: Hook | None = None
    quality: Literal["standard", "high"] = "standard"

    @model_validator(mode="after")
    def _check(self) -> "RenderPayload":
        if not 1_000 <= self.endMs - self.startMs <= 181_000:
            raise ValueError("range must be 1 s to 3 min")
        path = PurePosixPath(self.outputPath)
        if path.suffix != ".mp4" or path.parent != PurePosixPath(f"shorts/{self.shortId}"):
            raise ValueError("outputPath must be shorts/{shortId}/<name>.mp4")
        return self


def _copy_fonts(target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    for font in FONTS_DIR.glob("*.ttf"):
        shutil.copy2(font, target / font.name)


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = RenderPayload.model_validate(raw_payload)
    settings = ctx.settings
    root = settings.storage_root
    source = resolve_storage_path(payload.sourcePath, root)
    output = resolve_storage_path(payload.outputPath, root)
    if not source.is_file():
        raise JobError("SOURCE_MISSING", "The original video file is missing, so the Short can't be exported.",
                       retryable=False)  # fmt: skip
    ffprobe_bin = ffmpeg.require_binary("ffprobe", settings.ffprobe_path)
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", settings.ffmpeg_path)
    started = time.monotonic()

    ctx.progress(1, "Reading video details")
    info = analyse(ffmpeg.probe(ffprobe_bin, source))
    if info.duration_s and payload.startMs / 1000 >= info.duration_s:
        raise JobError("INVALID_RANGE", "The Short starts after the end of the video.", retryable=False)

    work_dir = output.parent
    work_dir.mkdir(parents=True, exist_ok=True)
    duration_ms = payload.endMs - payload.startMs
    if info.duration_s:
        duration_ms = min(duration_ms, round(info.duration_s * 1000) - payload.startMs)

    subtitles = None
    if (payload.captionStyle and payload.captions) or payload.hook:
        ass = build_ass(
            payload.captions,
            payload.captionStyle,
            hook_text=payload.hook.text if payload.hook else None,
            hook_end_ms=min(payload.hook.endMs, duration_ms) if payload.hook else 0,
            hook_style=payload.hook.style if payload.hook else None,
        )
        (work_dir / "captions.ass").write_text(ass, encoding="utf-8", newline="\n")
        if not ffmpeg.has_filter(ffmpeg_bin, "ass"):
            raise JobError(
                "CAPTIONS_UNSUPPORTED",
                "This FFmpeg build can't draw captions (it lacks libass). Install the full build with "
                "`winget install Gyan.FFmpeg`, or turn captions off.",
                retryable=False,
            )
        _copy_fonts(work_dir / "fonts")
        subtitles = "captions.ass"  # relative to work_dir (FFmpeg runs there) — no path escaping needed

    keyframes = [Keyframe(t_s=k.tMs / 1000, x=k.x) for k in payload.framing.keyframes]
    graph = video_filter(
        payload.framing.mode,
        info.width,
        info.height,
        keyframes,
        fps_cap=MAX_FPS if info.fps and info.fps > MAX_FPS + 0.5 else None,
        subtitles=subtitles,
    )
    preset, crf = QUALITY[payload.quality]
    audio = (
        ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"] if info.audio_codec else ["-an"]
    )
    partial = output.with_name(output.stem + ".partial.mp4")
    cmd = [
        ffmpeg_bin, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-ss", f"{payload.startMs / 1000:.3f}", "-t", f"{duration_ms / 1000:.3f}", "-i", str(source),
        "-filter_complex", graph, "-map", "[v]", *audio,
        "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p", "-profile:v", "high",
        "-threads", str(max(0, settings.render_threads)),
        "-movflags", "+faststart", "-max_muxing_queue_size", "1024",
        "-f", "mp4", "-progress", "pipe:1", "-nostats", str(partial),
    ]  # fmt: skip

    ctx.progress(3, "Exporting")
    ffmpeg.run_with_progress(
        cmd,
        partial,
        output,
        duration_ms / 1000,
        lambda fraction: ctx.progress(3 + 94 * fraction, "Exporting"),
        failure=("RENDER_FAILED", "Exporting the Short failed."),
        stall=("FFMPEG_STALLED", "Exporting got stuck."),
        stall_timeout_s=180,
        cwd=work_dir,
    )
    shutil.rmtree(work_dir / "fonts", ignore_errors=True)

    ctx.progress(98, "Checking the exported file")
    out = analyse(ffmpeg.probe(ffprobe_bin, output))
    if (out.width, out.height) != (OUT_W, OUT_H):
        output.unlink(missing_ok=True)
        raise JobError("RENDER_FAILED", "The exported file has the wrong size.", retryable=True)
    return {
        "outputPath": payload.outputPath,
        "sizeBytes": output.stat().st_size,
        "durationMs": round(out.duration_s * 1000) if out.duration_s else duration_ms,
        "width": out.width,
        "height": out.height,
        "fps": out.fps,
        "videoCodec": out.video_codec[:50],
        "audioCodec": out.audio_codec[:50] if out.audio_codec else None,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "preset": preset,
        "crf": int(crf),
    }
