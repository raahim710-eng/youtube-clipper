"""Local transcription with faster-whisper (MIT). Models download once into WHISPER_MODELS_DIR."""

import logging
import os
from collections.abc import Callable
from typing import Any

import numpy as np

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.transcription import ChunkTranscript, Segment, Word

# Loaded models, kept between jobs only with WHISPER_KEEP_LOADED=true: loading takes seconds, but on a
# 4 GB computer the memory is better spent on Ollama and FFmpeg the rest of the time.
_MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
log = logging.getLogger(__name__)

_SIZES = {"tiny": "~75 MB", "base": "~145 MB", "small": "~480 MB", "medium": "~1.5 GB"}


class FasterWhisperProvider:
    name = "faster-whisper"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model = settings.whisper_model
        self._whisper: Any = None

    def _device(self) -> str:
        if self.settings.whisper_device in ("cpu", "cuda"):
            return self.settings.whisper_device
        try:
            import ctranslate2

            return "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            return "cpu"

    def prepare(self, on_status: Callable[[str], None]) -> None:
        device = self._device()
        key = (self.model, device, self.settings.whisper_compute_type)
        if key in _MODEL_CACHE:
            self._whisper = _MODEL_CACHE[key]
            return
        on_status(f"Loading the speech model “{self.model}” (first use downloads {_SIZES.get(self.model, 'it')})")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
        try:
            from faster_whisper import WhisperModel

            self.settings.whisper_models_root.mkdir(parents=True, exist_ok=True)
            self._whisper = WhisperModel(
                self.model,
                device=device,
                compute_type=self.settings.whisper_compute_type,
                download_root=str(self.settings.whisper_models_root),
                cpu_threads=max(0, self.settings.render_threads),
            )
        except ImportError as error:
            raise JobError(
                "TRANSCRIPTION_UNAVAILABLE",
                "faster-whisper couldn't load. Run `npm run worker:setup`. On Windows it also needs the Microsoft "
                "Visual C++ Redistributable (`winget install Microsoft.VCRedist.2015+.x64`).",
                retryable=False,
            ) from error
        except (OSError, ValueError, RuntimeError) as error:
            log.warning("Loading the speech model failed: %s", error)
            raise JobError(
                "TRANSCRIPTION_MODEL_FAILED",
                f"Couldn't load the speech model “{self.model}”. Check WHISPER_MODEL and your internet connection "
                "for the first download.",
                retryable=True,
            ) from error
        if self.settings.whisper_keep_loaded:
            _MODEL_CACHE[key] = self._whisper

    def release(self) -> None:
        """Frees the model's memory after a job (unless WHISPER_KEEP_LOADED is on)."""
        if not self.settings.whisper_keep_loaded:
            self._whisper = None

    def transcribe(
        self,
        samples: np.ndarray,
        offset_ms: int,
        language: str | None,
        on_progress: Callable[[float], None],
    ) -> ChunkTranscript:
        duration_s = max(len(samples) / 16_000, 0.001)
        segments_iter, info = self._whisper.transcribe(
            samples, language=language, word_timestamps=True, vad_filter=True, beam_size=5
        )
        segments: list[Segment] = []
        for seg in segments_iter:  # lazy generator: decoding happens while we iterate
            words = [
                Word(offset_ms + round(w.start * 1000), offset_ms + round(w.end * 1000), w.word.strip())
                for w in (seg.words or [])
                if w.word.strip()
            ]
            text = seg.text.strip()
            if text:
                segments.append(
                    Segment(offset_ms + round(seg.start * 1000), offset_ms + round(seg.end * 1000), text, words)
                )
            on_progress(min(1.0, seg.end / duration_s))
        return ChunkTranscript(info.language, round(float(info.language_probability), 3), segments)
