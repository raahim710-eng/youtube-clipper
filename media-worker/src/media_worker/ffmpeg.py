"""FFmpeg/ffprobe helpers. Programs always run with argument lists, never through a shell (SECURITY.md §4)."""

import contextlib
import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from media_worker.errors import JobError

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
log = logging.getLogger(__name__)

# RENDER_THREADS (0 = FFmpeg decides). Set once by the runner; applied to every long FFmpeg run so a
# 2-core computer stays usable while videos are processed.
_thread_limit = 0


def set_thread_limit(threads: int) -> None:
    global _thread_limit
    _thread_limit = max(0, threads)


def limit_threads(cmd: list[str]) -> list[str]:
    """Adds the thread limit to an FFmpeg command: for every input's decoder, the filters and the encoder."""
    if _thread_limit <= 0 or not cmd:
        return cmd
    n = str(_thread_limit)
    out = [cmd[0], "-filter_threads", n, "-filter_complex_threads", n]
    for arg in cmd[1:-1]:
        if arg == "-i":
            out += ["-threads", n]
        out.append(arg)
    if "-threads" not in cmd:  # encoder threads, unless the command sets its own
        out += ["-threads", n]
    return [*out, cmd[-1]]


MISSING_FFMPEG_MESSAGE = (
    "FFmpeg isn't installed on this computer (or FFMPEG_PATH/FFPROBE_PATH in .env is wrong). "
    "Install it with `winget install Gyan.FFmpeg`, restart the worker, then choose Retry processing."
)


def find_binary(name: str, configured: str = "") -> str | None:
    if configured:
        return configured if Path(configured).is_file() else None
    return shutil.which(name)


def require_binary(name: str, configured: str = "") -> str:
    path = find_binary(name, configured)
    if not path:
        raise JobError("FFMPEG_MISSING", MISSING_FFMPEG_MESSAGE, retryable=False)
    return path


def ffmpeg_version(ffmpeg: str | None) -> str | None:
    if not ffmpeg:
        return None
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-version"], capture_output=True, text=True, timeout=10, creationflags=_NO_WINDOW
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    first = out.stdout.splitlines()[0] if out.stdout else ""
    parts = first.split()
    return parts[2] if len(parts) > 2 else None


def probe(ffprobe: str, source: Path) -> dict[str, Any]:
    """Runs ffprobe and returns its JSON. A file ffprobe can't read is reported as INVALID_VIDEO."""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(source)],
            capture_output=True,
            text=True,
            timeout=120,
            creationflags=_NO_WINDOW,
        )
    except subprocess.TimeoutExpired as error:
        raise JobError("PROBE_TIMEOUT", "Reading the video took too long.", retryable=True) from error
    except OSError as error:
        raise JobError("FFMPEG_MISSING", MISSING_FFMPEG_MESSAGE, retryable=False) from error
    if out.returncode != 0:
        raise JobError(
            "INVALID_VIDEO",
            "This file couldn't be read as a video. It may be damaged or use an unsupported format.",
            retryable=False,
        )
    try:
        return json.loads(out.stdout or "{}")
    except json.JSONDecodeError as error:
        raise JobError("INVALID_VIDEO", "This file couldn't be read as a video.", retryable=False) from error


def extract_frame(ffmpeg: str, source: Path, target: Path, at_seconds: float, max_width: int = 640) -> bool:
    """Writes one JPEG frame. Returns False if no frame could be decoded at that time."""
    partial = target.with_name(target.stem + ".partial.jpg")
    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-ss", f"{max(at_seconds, 0):.3f}", "-i", str(source),
        "-frames:v", "1", "-vf", f"scale='min({max_width},iw)':-2", "-q:v", "3",
        "-f", "image2", "-update", "1", str(partial),
    ]  # fmt: skip
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=120, creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired:
        partial.unlink(missing_ok=True)
        return False
    if out.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
        partial.unlink(missing_ok=True)
        return False
    os.replace(partial, target)
    return True


def transcode_preview(
    ffmpeg: str,
    source: Path,
    target: Path,
    duration_s: float | None,
    on_progress: Callable[[float], None],
    *,
    max_side: int = 1280,
    stall_timeout_s: float = 120.0,
) -> None:
    """Makes a browser-friendly H.264/AAC MP4 (longest side ≤ max_side)."""
    partial = target.with_name(target.stem + ".partial.mp4")
    scale = (
        f"scale=w='min({max_side},iw)':h='min({max_side},ih)':force_original_aspect_ratio=decrease,"
        "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    )
    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", "-nostats", str(partial),
    ]  # fmt: skip
    run_with_progress(
        cmd,
        partial,
        target,
        duration_s,
        on_progress,
        failure=("TRANSCODE_FAILED", "Creating the browser preview failed."),
        stall=("FFMPEG_STALLED", "Creating the preview got stuck."),
        stall_timeout_s=stall_timeout_s,
    )


def run_with_progress(
    cmd: list[str],
    partial: Path,
    target: Path,
    duration_s: float | None,
    on_progress: Callable[[float], None],
    *,
    failure: tuple[str, str],
    stall: tuple[str, str],
    stall_timeout_s: float = 120.0,
    cwd: Path | None = None,
) -> None:
    """Runs an FFmpeg command that writes `partial` (with `-progress pipe:1`) and moves it to `target` on success.

    `on_progress(fraction)` is called regularly — also when FFmpeg reports nothing — so it can
    send heartbeats; it may raise JobCancelled, which stops FFmpeg. A run with no output for
    `stall_timeout_s` is treated as stuck. `failure`/`stall` are (code, user message) pairs.
    """
    process = subprocess.Popen(
        limit_threads(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        errors="replace", cwd=cwd, creationflags=_NO_WINDOW,
    )  # fmt: skip
    lines: queue.Queue[str | None] = queue.Queue()
    stderr_tail: list[str] = []

    def pump_stdout() -> None:
        if process.stdout is None:
            lines.put(None)
            return
        for line in process.stdout:
            lines.put(line.strip())
        lines.put(None)

    def pump_stderr() -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            stderr_tail.append(line.strip())
            del stderr_tail[:-20]

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    fraction = 0.0
    last_output = time.monotonic()
    try:
        while True:
            try:
                line = lines.get(timeout=5)
            except queue.Empty:
                if time.monotonic() - last_output > stall_timeout_s:
                    raise JobError(stall[0], stall[1], retryable=True) from None
                on_progress(fraction)  # keep the lease alive and check for cancellation
                continue
            if line is None:
                break
            last_output = time.monotonic()
            if line.startswith("out_time_us=") and duration_s:
                with contextlib.suppress(ValueError):
                    fraction = min(1.0, max(0.0, int(line.split("=", 1)[1]) / 1_000_000 / duration_s))
                on_progress(fraction)
        code = process.wait(timeout=60)
        if code != 0:
            # FFmpeg's own words contain file paths: they go to the log, the user gets the plain message.
            log.warning("FFmpeg exited with %s: %s", code, " | ".join(stderr_tail[-5:])[:1000])
            raise JobError(failure[0], failure[1], retryable=True)
        os.replace(partial, target)
    except BaseException:
        stop_process(process)
        partial.unlink(missing_ok=True)
        raise


def stop_process(process: subprocess.Popen) -> None:
    """Kills a child process; never lets a slow exit hide the error that caused the stop."""
    with contextlib.suppress(OSError):
        process.kill()
    with contextlib.suppress(subprocess.TimeoutExpired):
        process.wait(timeout=30)


def has_filter(ffmpeg: str | None, name: str) -> bool:
    """True when this FFmpeg build includes the named filter (e.g. "ass" needs libass)."""
    if not ffmpeg:
        return False
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=20, creationflags=_NO_WINDOW
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return any(len(parts) > 1 and parts[1] == name for parts in (line.split() for line in out.stdout.splitlines()))
