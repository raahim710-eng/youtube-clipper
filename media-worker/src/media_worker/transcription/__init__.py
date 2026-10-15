"""Transcription providers. Add a provider by implementing `TranscriptionProvider` and registering it in
`get_transcription_provider` (TRANSCRIPTION_PROVIDER in .env picks one)."""

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from media_worker.config import Settings
from media_worker.errors import JobError


@dataclass
class Word:
    start_ms: int
    end_ms: int
    text: str


@dataclass
class Segment:
    start_ms: int
    end_ms: int
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class ChunkTranscript:
    language: str | None
    language_probability: float | None
    segments: list[Segment]


class TranscriptionProvider(Protocol):
    name: str
    model: str

    def prepare(self, on_status: Callable[[str], None]) -> None:
        """Load (and on first use download) the model."""

    def release(self) -> None:
        """Free the model's memory after a job, if the provider doesn't keep it loaded."""

    def transcribe(
        self,
        samples: np.ndarray,
        offset_ms: int,
        language: str | None,
        on_progress: Callable[[float], None],
    ) -> ChunkTranscript:
        """Transcribe 16 kHz mono float32 audio; timestamps are shifted by `offset_ms`."""


def get_transcription_provider(settings: Settings) -> TranscriptionProvider:
    if settings.transcription_provider == "faster-whisper":
        from media_worker.transcription.faster_whisper_provider import FasterWhisperProvider

        return FasterWhisperProvider(settings)
    raise JobError(
        "TRANSCRIPTION_NOT_CONFIGURED",
        f"Unknown TRANSCRIPTION_PROVIDER “{settings.transcription_provider}”. Supported: faster-whisper.",
        retryable=False,
    )
