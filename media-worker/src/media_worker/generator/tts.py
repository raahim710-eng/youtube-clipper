"""Text-to-speech providers for narration (GEN-03). Each returns a WAV file, its duration and word start
times when the engine reports them. Providers are chosen with TTS_PROVIDER (D-051)."""

import json
import logging
import os
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from media_worker.config import Settings
from media_worker.errors import JobError

log = logging.getLogger(__name__)

_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
SAPI_SCRIPT = Path(__file__).with_name("sapi_speak.ps1")


@dataclass
class Speech:
    duration_ms: int
    # (start_ms, end_ms, text) per word, or None when the engine doesn't report timings.
    words: list[tuple[int, int, str]] | None


class TTSProvider(Protocol):
    name: str
    voice: str

    def check(self) -> None: ...

    def speak(self, text: str, target: Path, rate: int = 0) -> Speech: ...


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as wav:
        return round(wav.getnframes() / wav.getframerate() * 1000)


def word_ends(starts: list[tuple[int, str]], duration_ms: int) -> list[tuple[int, int, str]]:
    """Turns word start times into (start, end, text): a word ends where the next starts, the last one
    roughly 70 ms per character later (never past the audio)."""
    result = []
    for i, (start, text) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else min(duration_ms, start + max(250, 70 * len(text)))
        result.append((start, max(start + 1, end), text))
    return result


class SapiProvider:
    """Windows' built-in voices (System.Speech). Free, offline, no download; robotic but clear."""

    name = "sapi"

    def __init__(self, settings: Settings, voice: str | None = None):
        # A voice chosen for the project must exist; TTS_VOICE from .env is only a default (it may name a
        # Kokoro voice), so a missing one falls back to Windows' default voice.
        self.explicit = bool(voice)
        self.voice = voice or settings.tts_voice

    def _run(self, args: list[str], timeout: int) -> dict:
        if os.name != "nt":
            raise JobError(
                "TTS_UNAVAILABLE", "Windows voices are only available on Windows. Set TTS_PROVIDER.", retryable=False
            )
        cmd = [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SAPI_SCRIPT),
            *args,
        ]
        try:
            out = subprocess.run(
                cmd, capture_output=True, text=True, encoding="utf-8", timeout=timeout, creationflags=_NO_WINDOW
            )
        except subprocess.TimeoutExpired as error:
            raise JobError("TTS_TIMEOUT", "The Windows voice took too long.", retryable=True) from error
        if out.returncode != 0:
            log.warning("Windows voice failed: %s", (out.stderr or out.stdout).strip()[-1000:])
            raise JobError("TTS_FAILED", "The Windows voice couldn't speak this text.", retryable=False)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def voices(self) -> list[dict]:
        with tempfile.TemporaryDirectory() as tmp:
            dummy = Path(tmp) / "x.txt"
            dummy.write_text("x", encoding="utf-8")
            return self._run(["-ListVoices", "-TextFile", str(dummy), "-OutWav", str(Path(tmp) / "x.wav")], 60)[
                "voices"
            ]

    def check(self) -> None:
        if not self.voice or self.voice in {v["name"] for v in self.voices()}:
            return
        if self.explicit:
            raise JobError(
                "TTS_VOICE_MISSING", f"The voice “{self.voice}” isn't installed on this computer.", retryable=False
            )
        log.warning("TTS_VOICE “%s” isn't a Windows voice on this computer; using the default voice.", self.voice)
        self.voice = ""

    def speak(self, text: str, target: Path, rate: int = 0) -> Speech:
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".partial.wav")
        with tempfile.TemporaryDirectory() as tmp:
            text_file = Path(tmp) / "text.txt"
            text_file.write_text(text, encoding="utf-8")
            args = ["-TextFile", str(text_file), "-OutWav", str(partial), "-Rate", str(rate)]
            if self.voice:
                args += ["-Voice", self.voice]
            data = self._run(args, timeout=max(60, len(text) // 5))
        partial.replace(target)
        duration = wav_duration_ms(target)
        starts = [(int(w["ms"]), str(w["text"])) for w in data.get("words", []) if str(w.get("text", "")).strip()]
        return Speech(duration_ms=duration, words=word_ends(starts, duration) if starts else None)


class KokoroProvider:
    """Kokoro-82M (Apache-2.0), local and much more natural. Optional and not in the lockfile, because it
    pulls in PyTorch: install with `uv pip install --python media-worker/.venv kokoro soundfile`
    (~1.5–2 GB with model weights). Not installed on the owner's PC, so untested here (D-051)."""

    name = "kokoro"

    def __init__(self, settings: Settings, voice: str | None = None):
        self.voice = voice or settings.tts_voice or "af_heart"

    def check(self) -> None:
        try:
            import kokoro  # noqa: F401
        except ImportError as error:
            raise JobError(
                "TTS_NOT_INSTALLED",
                "Kokoro isn't installed. Install it with `uv pip install --python media-worker/.venv kokoro soundfile` "
                "(about 1.5–2 GB), or set TTS_PROVIDER=sapi to use Windows' built-in voices.",
                retryable=False,
            ) from error

    def speak(self, text: str, target: Path, rate: int = 0) -> Speech:  # pragma: no cover - optional dependency
        self.check()
        import numpy as np
        import soundfile
        from kokoro import KPipeline

        pipeline = KPipeline(lang_code=self.voice[0])
        audio = np.concatenate([chunk for _, _, chunk in pipeline(text, voice=self.voice, speed=1 + rate / 20)])
        target.parent.mkdir(parents=True, exist_ok=True)
        soundfile.write(str(target), audio, 24000, subtype="PCM_16")
        return Speech(duration_ms=wav_duration_ms(target), words=None)


def get_tts_provider(name: str, settings: Settings, voice: str | None = None) -> TTSProvider:
    """`voice` is the project's choice; without it the provider uses TTS_VOICE or its own default."""
    if name == "sapi":
        return SapiProvider(settings, voice)
    if name == "kokoro":
        return KokoroProvider(settings, voice)
    raise JobError("TTS_NOT_CONFIGURED", f"Unknown text-to-speech provider “{name}” (TTS_PROVIDER).", retryable=False)


def proportional_words(
    text: str, duration_ms: int, lead_ms: int = 150, tail_ms: int = 250
) -> list[tuple[int, int, str]]:
    """Fallback word timings for engines that don't report them: spread the words over the audio in
    proportion to their length. Less exact than real timings; captions may drift by a few hundred ms."""
    words = text.split()
    if not words:
        return []
    span = max(1, duration_ms - lead_ms - tail_ms)
    total = sum(len(w) + 1 for w in words)
    result, cursor = [], float(lead_ms)
    for word in words:
        length = span * (len(word) + 1) / total
        result.append((round(cursor), round(cursor + length), word))
        cursor += length
    return result
