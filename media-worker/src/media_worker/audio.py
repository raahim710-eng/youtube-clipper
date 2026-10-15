"""Audio helpers: extract speech audio with FFmpeg and read it in chunks (keeps memory low for long videos)."""

import logging
import math
import os
import subprocess
import wave
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from media_worker.errors import JobError

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def has_audio_stream(probe: dict) -> bool:
    return any(stream.get("codec_type") == "audio" for stream in probe.get("streams") or [])


def extract_speech_wav(ffmpeg: str, source: Path, target: Path) -> None:
    """16 kHz mono 16-bit WAV — the format speech models expect."""
    partial = target.with_name(target.stem + ".partial.wav")
    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(source),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", str(partial),
    ]  # fmt: skip
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired as error:
        partial.unlink(missing_ok=True)
        raise JobError("AUDIO_EXTRACT_FAILED", "Extracting the audio took too long.", retryable=True) from error
    if out.returncode != 0 or not partial.is_file():
        partial.unlink(missing_ok=True)
        log.warning("Audio extraction failed: %s", (out.stderr or "").strip()[-1000:])
        raise JobError("AUDIO_EXTRACT_FAILED", "Couldn't extract the audio.", retryable=True)
    os.replace(partial, target)


@dataclass
class AudioChunk:
    offset_s: float
    samples: np.ndarray  # float32 in [-1, 1]


def wav_duration_s(path: Path) -> float:
    with wave.open(str(path), "rb") as wav:
        return wav.getnframes() / wav.getframerate()


def read_wav_chunks(path: Path, chunk_s: float = 600.0) -> Iterator[AudioChunk]:
    """Yields the audio in pieces (default 10 minutes) so a 3-hour video never sits in memory at once."""
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise JobError("AUDIO_FORMAT", "Unexpected audio format after extraction.", retryable=False)
        rate = wav.getframerate()
        frames_per_chunk = int(chunk_s * rate)
        offset = 0
        while True:
            raw = wav.readframes(frames_per_chunk)
            if not raw:
                break
            pcm = np.frombuffer(raw, dtype=np.int16)
            yield AudioChunk(offset_s=offset / rate, samples=pcm.astype(np.float32) / 32768.0)
            offset += len(pcm)


def loudness_db(samples: np.ndarray, rate: int = SAMPLE_RATE, window_s: float = 0.5) -> list[float]:
    """RMS loudness per window in dBFS (rounded). Used to spot louder, higher-energy moments."""
    size = max(1, int(rate * window_s))
    values: list[float] = []
    for start in range(0, len(samples), size):
        window = samples[start : start + size]
        rms = float(np.sqrt(np.mean(np.square(window, dtype=np.float64)))) if len(window) else 0.0
        values.append(round(20 * math.log10(rms), 1) if rms > 1e-6 else -120.0)
    return values
