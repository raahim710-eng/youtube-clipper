"""gen.render — assemble a generated video (GEN-05): each scene's footage trimmed (or looped) to its narration,
scaled to the target size, joined with short crossfades, narration (+ optional music, ducked under the voice),
burned-in captions. Every clip must really move — still images are refused (D-011).

Result fields match `genRenderResultSchema` in src/server/jobs/gen-render.ts.
"""

import shutil
import time
from pathlib import Path, PurePosixPath
from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field, model_validator

from media_worker import ffmpeg
from media_worker.config import FONTS_DIR
from media_worker.errors import JobError
from media_worker.generator import stock
from media_worker.generator.motion import has_motion
from media_worker.job_context import JobContext
from media_worker.jobs.ingest import analyse
from media_worker.shorts.ass import Cue, TextStyle, build_ass
from media_worker.storage import resolve_storage_path

QUALITY = {"standard": ("veryfast", "21"), "high": ("medium", "19")}
FPS = 30


class Footage(BaseModel):
    path: str = Field(min_length=1)
    startMs: int = Field(default=0, ge=0)
    # Stock clips not downloaded yet are fetched first (official hosts only).
    provider: Literal["pexels", "pixabay"] | None = None
    downloadUrl: str | None = None


class RenderScene(BaseModel):
    id: str = Field(min_length=1)
    number: int = Field(ge=1)
    audioPath: str = Field(min_length=1)
    durationMs: int = Field(gt=0, le=120_000)
    footage: Footage


class Music(BaseModel):
    path: str = Field(min_length=1)
    volumeDb: float = Field(default=-18, ge=-40, le=0)


class GenRenderPayload(BaseModel):
    projectId: str = Field(min_length=1)
    outputPath: str = Field(min_length=1)
    width: int = Field(ge=320, le=1920)
    height: int = Field(ge=320, le=1920)
    quality: Literal["standard", "high"] = "standard"
    transitionMs: int = Field(default=400, ge=0, le=1500)
    scenes: list[RenderScene] = Field(min_length=1, max_length=40)
    captions: list[Cue] = Field(default_factory=list, max_length=4000)
    captionStyle: TextStyle | None = None
    music: Music | None = None

    @model_validator(mode="after")
    def _check(self) -> "GenRenderPayload":
        out = PurePosixPath(self.outputPath)
        if out.name != "source.mp4" or out.parent.parent != PurePosixPath("videos"):
            raise ValueError("outputPath must be videos/{videoId}/source.mp4")
        if self.width % 2 or self.height % 2:
            raise ValueError("width and height must be even")
        return self


def _seconds(ms: int) -> str:
    return f"{ms / 1000:.3f}"


# At most this many videos are decoded at once when joining. Measured at 1080×1920: 30 inputs in one pass
# peaked at 2.1 GB of RAM, 8 inputs at 1.0 GB (about 50 MB per input plus the encoder).
MAX_JOIN_INPUTS = 8


def _xfade_chain(durations_ms: list[int], t_ms: int, out: str) -> list[str]:
    """Crossfades inputs 0..n-1 into [out]; input k fades in when the narration before it has ended."""
    if len(durations_ms) == 1:
        return [f"[0:v]null[{out}]"]
    graph = []
    offset = 0
    previous = "0:v"
    for k in range(1, len(durations_ms)):
        offset += durations_ms[k - 1]
        label = f"v{k}" if k < len(durations_ms) - 1 else out
        graph.append(
            f"[{previous}][{k}:v]xfade=transition=fade:duration={_seconds(t_ms)}:offset={_seconds(offset)}[{label}]"
        )
        previous = label
    return graph


def _join_video(ffmpeg_bin: str, group: list[tuple[Path, int]], t_ms: int, target: Path, ctx: JobContext) -> None:
    """Joins a batch of segments (video only, near-lossless) into one part of narration-sum + transition length."""
    inputs: list[str] = []
    for path, _ in group:
        inputs += ["-i", str(path)]
    length_ms = sum(ms for _, ms in group) + t_ms
    cmd = [
        ffmpeg_bin, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *inputs,
        "-filter_complex", ";".join(_xfade_chain([ms for _, ms in group], t_ms, "vx")),
        "-map", "[vx]", "-t", _seconds(length_ms), "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-progress", "pipe:1", "-nostats", str(target.with_suffix(".partial.mp4")),
    ]  # fmt: skip
    ffmpeg.run_with_progress(
        cmd,
        target.with_suffix(".partial.mp4"),
        target,
        length_ms / 1000,
        lambda _fraction: ctx.progress(58),
        failure=("RENDER_FAILED", "Joining the scenes failed."),
        stall=("FFMPEG_STALLED", "Rendering got stuck."),
    )


def _prepare_footage(
    payload: GenRenderPayload, ctx: JobContext, ffprobe_bin: str, ffmpeg_bin: str
) -> dict[str, tuple[Path, float]]:
    """Resolves (downloading if needed) every clip, checks it's a readable moving video. Returns path + duration."""
    root = ctx.settings.storage_root
    ready: dict[str, tuple[Path, float]] = {}
    problems: list[str] = []
    with httpx.Client(headers={"User-Agent": "CreatorStudioAssistant/1.0"}) as client:
        for scene in payload.scenes:
            path = resolve_storage_path(scene.footage.path, root)
            try:
                if not path.is_file() and scene.footage.provider and scene.footage.downloadUrl:
                    candidate = stock.Candidate(
                        provider=scene.footage.provider, providerAssetId=path.stem, pageUrl="", creatorName="",
                        creatorUrl=None, downloadUrl=scene.footage.downloadUrl, previewImageUrl=None, width=0, height=0,
                        durationMs=0, licenseName="",
                    )  # fmt: skip
                    stock.download(client, candidate, path)
                if not path.is_file():
                    problems.append(f"scene {scene.number}: the footage file is missing")
                    continue
                info = analyse(ffmpeg.probe(ffprobe_bin, path))
                duration = info.duration_s or 0.0
                start = min(scene.footage.startMs / 1000, max(0.0, duration - 0.5))
                if not has_motion(ffmpeg_bin, path, start, min(4.0, max(1.0, duration - start))):
                    problems.append(f"scene {scene.number}: the footage doesn't move (still images aren't allowed)")
                    continue
                ready[scene.id] = (path, duration)
            except JobError as error:
                problems.append(f"scene {scene.number}: {error.message}")
    if problems:
        raise JobError("SCENE_FOOTAGE", "Fix the footage first — " + "; ".join(problems[:8]) + ".", retryable=False)
    return ready


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = GenRenderPayload.model_validate(raw_payload)
    settings = ctx.settings
    root = settings.storage_root
    ffprobe_bin = ffmpeg.require_binary("ffprobe", settings.ffprobe_path)
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", settings.ffmpeg_path)
    started = time.monotonic()
    output = resolve_storage_path(payload.outputPath, root)
    work = resolve_storage_path(f"generator/{payload.projectId}/render", root)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    try:
        ctx.progress(2, "Checking the footage")
        for scene in payload.scenes:
            if not resolve_storage_path(scene.audioPath, root).is_file():
                raise JobError(
                    "NARRATION_MISSING", f"Scene {scene.number} has no narration. Narrate it again.", retryable=False
                )
        footage = _prepare_footage(payload, ctx, ffprobe_bin, ffmpeg_bin)
        preset, crf = QUALITY[payload.quality]
        fit = f"scale={payload.width}:{payload.height}:force_original_aspect_ratio=increase,"
        fit += f"crop={payload.width}:{payload.height},fps={FPS},setsar=1,format=yuv420p"
        t_ms = payload.transitionMs if len(payload.scenes) > 1 else 0
        w, h = payload.width, payload.height

        # 1) One clean video-only segment per scene, exactly narration + transition long.
        segments: list[Path] = []
        for index, scene in enumerate(payload.scenes):
            ctx.progress(5 + 55 * index / len(payload.scenes), f"Preparing scene {index + 1} of {len(payload.scenes)}")
            path, duration = footage[scene.id]
            length_ms = scene.durationMs + t_ms
            start_s = min(scene.footage.startMs / 1000, max(0.0, duration - 0.5))
            loop = ["-stream_loop", "-1"] if duration - start_s < length_ms / 1000 else []
            segment = work / f"seg_{index:03d}.mp4"
            cmd = [
                ffmpeg_bin, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *loop,
                "-ss", f"{start_s:.3f}", "-i", str(path), "-t", _seconds(length_ms), "-an",
                "-vf", fit,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-progress", "pipe:1", "-nostats",
                str(segment.with_suffix(".partial.mp4")),
            ]  # fmt: skip
            done = 5 + 55 * index / len(payload.scenes)
            ffmpeg.run_with_progress(
                cmd,
                segment.with_suffix(".partial.mp4"),
                segment,
                length_ms / 1000,
                lambda _fraction, done=done: ctx.progress(done),
                failure=("RENDER_FAILED", f"Preparing scene {index + 1} failed."),
                stall=("FFMPEG_STALLED", "Rendering got stuck."),
            )
            segments.append(segment)

        # 2) Long videos: join the segments in batches first, so FFmpeg never decodes more than
        #    MAX_JOIN_INPUTS videos at once (30 segments at 1080×1920 needed 2.1 GB of RAM in one pass).
        parts = [(segment, scene.durationMs) for segment, scene in zip(segments, payload.scenes, strict=True)]
        batch = 0
        while len(parts) > MAX_JOIN_INPUTS:
            joined: list[tuple[Path, int]] = []
            for start in range(0, len(parts), MAX_JOIN_INPUTS):
                group = parts[start : start + MAX_JOIN_INPUTS]
                if len(group) == 1:
                    joined.append(group[0])
                    continue
                batch += 1
                ctx.progress(58, f"Joining scenes (part {batch})")
                target = work / f"join_{batch:03d}.mp4"
                _join_video(ffmpeg_bin, group, t_ms, target, ctx)
                # A joined part behaves like one long scene: its narration is the sum of its scenes'.
                joined.append((target, sum(ms for _, ms in group)))
            parts = joined

        # 3) Crossfades, narration (+ music), captions, final encode.
        inputs: list[str] = []
        for part, _ in parts:
            inputs += ["-i", str(part)]
        audio_base = len(parts)
        for scene in payload.scenes:
            inputs += ["-i", str(resolve_storage_path(scene.audioPath, root))]
        graph: list[str] = _xfade_chain([ms for _, ms in parts], t_ms, "vx")
        n = len(payload.scenes)
        subtitles = None
        if payload.captionStyle and payload.captions:
            (work / "captions.ass").write_text(
                build_ass(payload.captions, payload.captionStyle, play_res=(w, h)), encoding="utf-8"
            )
            fonts = work / "fonts"
            fonts.mkdir()
            for font in FONTS_DIR.glob("*.ttf"):
                shutil.copy2(font, fonts / font.name)
            subtitles = "captions.ass"
        graph.append(f"[vx]{f'ass={subtitles}:fontsdir=fonts,' if subtitles else ''}format=yuv420p[v]")
        for k in range(n):
            graph.append(f"[{audio_base + k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{k}]")
        graph.append("".join(f"[a{k}]" for k in range(n)) + f"concat=n={n}:v=0:a=1,apad=pad_dur={_seconds(t_ms)}[narr]")
        total_ms = sum(s.durationMs for s in payload.scenes) + t_ms
        if payload.music:
            inputs += ["-stream_loop", "-1", "-i", str(resolve_storage_path(payload.music.path, root))]
            m = audio_base + n
            graph.append("[narr]asplit=2[nkey][nmix]")
            graph.append(
                f"[{m}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={payload.music.volumeDb}dB[music]"
            )
            graph.append("[music][nkey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]")
            graph.append("[nmix][ducked]amix=inputs=2:duration=first:normalize=0[aout]")
        else:
            graph.append("[narr]anull[aout]")
        final_partial = output.with_name("source.partial.mp4")
        output.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            ffmpeg_bin, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *inputs,
            "-filter_complex", ";".join(graph),
            "-map", "[v]", "-map", "[aout]", "-t", _seconds(total_ms),
            "-c:v", "libx264", "-preset", preset, "-crf", crf, "-pix_fmt", "yuv420p", "-r", str(FPS),
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
            "-threads", str(max(0, settings.render_threads)), "-movflags", "+faststart",
            "-f", "mp4", "-progress", "pipe:1", "-nostats", str(final_partial),
        ]  # fmt: skip
        ctx.progress(60, "Joining scenes, narration and captions")
        message = "Joining scenes, narration and captions"
        ffmpeg.run_with_progress(
            cmd,
            final_partial,
            output,
            total_ms / 1000,
            lambda fraction: ctx.progress(60 + 38 * fraction, message),
            failure=("RENDER_FAILED", "Rendering the video failed."),
            stall=("FFMPEG_STALLED", "Rendering got stuck."),
            stall_timeout_s=300,
            cwd=work,
        )
    finally:
        # Segments can be hundreds of MB; never leave them behind, also after a failure or cancel.
        shutil.rmtree(work, ignore_errors=True)
    info = analyse(ffmpeg.probe(ffprobe_bin, output))
    return {
        "outputPath": payload.outputPath,
        "durationMs": round((info.duration_s or total_ms / 1000) * 1000),
        "width": info.width,
        "height": info.height,
        "sizeBytes": output.stat().st_size,
        "elapsedMs": round((time.monotonic() - started) * 1000),
    }
