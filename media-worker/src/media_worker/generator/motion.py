"""Checks that footage really moves (GEN-04: no still-image slideshows)."""

import subprocess
from pathlib import Path

import numpy as np

from media_worker.ffmpeg import _NO_WINDOW

SAMPLE_W, SAMPLE_H = 64, 36
MOTION_THRESHOLD = 1.5  # mean absolute difference (0–255) between sampled frames


def has_motion(ffmpeg_bin: str, path: Path, start_s: float = 0.0, length_s: float = 4.0, samples: int = 6) -> bool:
    """True when frames sampled over `length_s` differ — a still image (or a frozen video) doesn't."""
    fps = max(0.5, samples / max(length_s, 0.5))
    cmd = [
        ffmpeg_bin, "-v", "error", "-ss", f"{max(0.0, start_s):.3f}", "-t", f"{max(0.5, length_s):.3f}",
        "-i", str(path),
        "-vf", f"fps={fps:.3f},scale={SAMPLE_W}:{SAMPLE_H},format=gray", "-f", "rawvideo", "pipe:1",
    ]  # fmt: skip
    out = subprocess.run(cmd, capture_output=True, timeout=120, creationflags=_NO_WINDOW)
    frames = np.frombuffer(out.stdout, dtype=np.uint8)
    count = frames.size // (SAMPLE_W * SAMPLE_H)
    if out.returncode != 0 or count < 2:
        return False
    frames = frames[: count * SAMPLE_W * SAMPLE_H].reshape(count, SAMPLE_H, SAMPLE_W).astype(np.int16)
    diffs = [float(np.mean(np.abs(frames[i] - frames[i - 1]))) for i in range(1, count)]
    return max(diffs) >= MOTION_THRESHOLD
