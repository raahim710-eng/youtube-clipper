import shutil
import subprocess
from pathlib import Path

import pytest

from media_worker.config import Settings

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
requires_ffmpeg = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="FFmpeg/ffprobe not installed")


def make_video(path: Path, *args: str, seconds: float = 2.0, size: str = "320x240", vcodec: str = "libx264") -> Path:
    """Generates a real encoded test video (moving test pattern + tone) with FFmpeg."""
    assert FFMPEG
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-c:v", vcodec, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", *args, str(path),
    ]  # fmt: skip
    subprocess.run(cmd, check=True, capture_output=True)
    return path


class RecordingSink:
    """Stands in for the API client: records heartbeats and can ask to cancel."""

    def __init__(self, cancel_after: int | None = None):
        self.calls: list[tuple[float, str | None]] = []
        self.cancel_after = cancel_after

    def heartbeat(self, job_id: str, progress: float, message: str | None) -> bool:
        self.calls.append((progress, message))
        return self.cancel_after is not None and len(self.calls) > self.cancel_after


@pytest.fixture
def storage(tmp_path: Path) -> Path:
    root = tmp_path / "storage"
    root.mkdir()
    return root


@pytest.fixture
def settings(storage: Path) -> Settings:
    return Settings(
        _env_file=None,
        storage_dir=str(storage),
        worker_shared_secret="x" * 40,
        ffmpeg_path=FFMPEG or "",
        ffprobe_path=FFPROBE or "",
    )
