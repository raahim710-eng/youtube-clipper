"""media.transcribe — extract the audio and create a word-level transcript (TECHNICAL_SPEC.md §7.2).

Result fields match `mediaTranscribeResultSchema` in src/server/jobs/media-transcribe.ts.
The transcript file format is documented in DATABASE_SCHEMA.md (Transcript).
"""

import json
import os
from typing import Any

from pydantic import BaseModel, Field

from media_worker import audio, ffmpeg
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.storage import resolve_storage_path
from media_worker.transcription import Segment, TranscriptionProvider, get_transcription_provider

CHUNK_SECONDS = 600.0  # 10-minute pieces keep memory low on long videos


class TranscribePayload(BaseModel):
    videoId: str = Field(min_length=1)
    sourcePath: str = Field(min_length=1)
    outputPath: str = Field(min_length=1)
    language: str = Field(default="auto", max_length=10)


def _segment_json(segment: Segment) -> dict[str, Any]:
    return {
        "startMs": segment.start_ms,
        "endMs": segment.end_ms,
        "text": segment.text,
        "words": [[w.start_ms, w.end_ms, w.text] for w in segment.words],
    }


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = TranscribePayload.model_validate(raw_payload)
    settings = ctx.settings
    root = settings.storage_root
    source = resolve_storage_path(payload.sourcePath, root)
    output = resolve_storage_path(payload.outputPath, root)
    if not source.is_file():
        raise JobError(
            "SOURCE_MISSING", "The video file is missing. Delete the video and upload it again.", retryable=False
        )

    ffprobe_bin = ffmpeg.require_binary("ffprobe", settings.ffprobe_path)
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", settings.ffmpeg_path)

    ctx.progress(2, "Checking the audio")
    if not audio.has_audio_stream(ffmpeg.probe(ffprobe_bin, source)):
        raise JobError("NO_AUDIO", "This video has no audio track, so there's nothing to transcribe.", retryable=False)

    wav = output.with_name("audio.transcribe.wav")
    provider: TranscriptionProvider | None = None
    try:
        with ctx.keepalive("Extracting the audio"):
            audio.extract_speech_wav(ffmpeg_bin, source, wav)
        total_s = max(audio.wav_duration_s(wav), 0.001)

        provider = get_transcription_provider(settings)
        with ctx.keepalive("Loading the speech model"):
            provider.prepare(lambda message: None)

        language = None if payload.language in ("", "auto") else payload.language
        segments: list[Segment] = []
        loudness: list[float] = []
        detected: tuple[str | None, float | None] = (None, None)
        for chunk in audio.read_wav_chunks(wav, CHUNK_SECONDS):
            loudness.extend(audio.loudness_db(chunk.samples))
            chunk_s = len(chunk.samples) / audio.SAMPLE_RATE

            def report(fraction: float, offset: float = chunk.offset_s, length: float = chunk_s) -> None:
                done = (offset + fraction * length) / total_s
                ctx.progress(5 + 90 * done, f"Transcribing ({round(done * 100)}%)")

            with ctx.keepalive("Transcribing"):
                result = provider.transcribe(chunk.samples, round(chunk.offset_s * 1000), language, report)
            segments.extend(result.segments)
            if detected[0] is None:
                detected = (result.language, result.language_probability)
                language = language or result.language  # keep later chunks in the same language
    finally:
        wav.unlink(missing_ok=True)
        if provider is not None:
            provider.release()

    words = sum(len(segment.words) for segment in segments)
    document = {
        "version": 1,
        "provider": provider.name,
        "model": provider.model,
        "language": detected[0],
        "languageProbability": detected[1],
        "durationMs": round(total_s * 1000),
        "segments": [_segment_json(segment) for segment in segments],
        "loudness": {"windowMs": 500, "db": loudness},
    }
    ctx.progress(97, "Saving the transcript")
    partial = output.with_name(output.stem + ".partial.json")
    partial.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(partial, output)

    return {
        "transcriptPath": payload.outputPath,
        "provider": provider.name,
        "model": provider.model,
        "language": detected[0],
        "languageProbability": detected[1],
        "durationMs": document["durationMs"],
        "wordCount": words,
        "segmentCount": len(segments),
    }
