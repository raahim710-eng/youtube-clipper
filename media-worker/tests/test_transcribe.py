import json
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path

import numpy as np
import pytest
from conftest import FFMPEG, RecordingSink, make_video, requires_ffmpeg

from media_worker import audio
from media_worker.config import Settings
from media_worker.errors import JobCancelled, JobError
from media_worker.job_context import JobContext
from media_worker.jobs import transcribe

SPEECH = Path(__file__).parent / "fixtures" / "speech-sample.wav"


def faster_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except Exception:
        return False
    return True


requires_whisper = pytest.mark.skipif(not faster_whisper_available(), reason="faster-whisper can't load here")


def video_with_speech(storage: Path) -> Path:
    """A real MP4: moving test pattern + the committed speech recording."""
    assert FFMPEG
    target = storage / "videos/v1/source.mp4"
    target.parent.mkdir(parents=True, exist_ok=True)
    picture = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25"]
    encode = ["-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *picture, "-i", str(SPEECH), *encode, str(target)]
    subprocess.run(cmd, check=True, capture_output=True)
    return target


def payload() -> dict:
    return {"videoId": "v1", "sourcePath": "videos/v1/source.mp4", "outputPath": "videos/v1/transcript.json"}


@requires_ffmpeg
@requires_whisper
def test_real_speech_is_transcribed_with_word_timings(storage: Path, settings: Settings) -> None:
    video_with_speech(storage)
    tiny = settings.model_copy(update={"whisper_model": "tiny"})
    result = transcribe.run({**payload(), "language": "en"}, JobContext("j1", tiny, RecordingSink(), min_interval_s=0))

    assert result["provider"] == "faster-whisper" and result["model"] == "tiny"
    assert result["language"] == "en" and result["wordCount"] >= 8
    doc = json.loads((storage / "videos/v1/transcript.json").read_text(encoding="utf-8"))
    text = " ".join(s["text"] for s in doc["segments"]).lower()
    assert "editing" in text and "transcripts" in text
    words = [w for s in doc["segments"] for w in s["words"]]
    assert all(start <= end for start, end, _ in words)
    assert [w[0] for w in words] == sorted(w[0] for w in words)
    assert doc["loudness"]["db"], "loudness envelope is stored for clip scoring"
    assert not (storage / "videos/v1/audio.transcribe.wav").exists(), "temporary audio is removed"


@requires_ffmpeg
@requires_whisper
def test_long_videos_are_processed_in_pieces_with_correct_offsets(
    storage: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    video_with_speech(storage)
    monkeypatch.setattr(transcribe, "CHUNK_SECONDS", 3.0)  # pretend a short video is long
    tiny = settings.model_copy(update={"whisper_model": "tiny"})
    transcribe.run({**payload(), "language": "en"}, JobContext("j1", tiny, RecordingSink(), min_interval_s=0))
    doc = json.loads((storage / "videos/v1/transcript.json").read_text(encoding="utf-8"))
    starts = [s["startMs"] for s in doc["segments"]]
    assert starts == sorted(starts) and max(starts) >= 3000, "later pieces keep their real position in the video"


@requires_ffmpeg
def test_video_without_audio_is_explained(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", "-an", seconds=2)
    with pytest.raises(JobError) as error:
        transcribe.run(payload(), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "NO_AUDIO" and not error.value.retryable


def test_unknown_transcription_provider_is_rejected(storage: Path, settings: Settings) -> None:
    (storage / "videos/v1").mkdir(parents=True)
    shutil.copy(SPEECH, storage / "videos/v1/source.mp4")  # content doesn't matter; we fail before using it
    other = settings.model_copy(update={"transcription_provider": "magic"})
    if not FFMPEG:
        pytest.skip("needs ffprobe to get past the audio check")
    with pytest.raises(JobError):
        transcribe.run(payload(), JobContext("j1", other, RecordingSink()))


def test_wav_is_read_in_chunks_with_offsets(tmp_path: Path) -> None:
    path = tmp_path / "tone.wav"
    samples = (np.sin(np.linspace(0, 2000, 16_000 * 5)) * 10_000).astype(np.int16)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(samples.tobytes())
    chunks = list(audio.read_wav_chunks(path, chunk_s=2.0))
    assert [round(c.offset_s, 3) for c in chunks] == [0.0, 2.0, 4.0]
    assert sum(len(c.samples) for c in chunks) == len(samples)
    assert max(audio.loudness_db(chunks[0].samples)) > -20


def test_keepalive_beats_during_long_steps_and_honours_cancellation(settings: Settings) -> None:
    sink = RecordingSink()
    ctx = JobContext("j1", settings, sink, min_interval_s=0)
    with ctx.keepalive("Loading", interval_s=0.05):
        time.sleep(0.3)
    assert len(sink.calls) >= 3

    cancelling = RecordingSink(cancel_after=1)
    ctx = JobContext("j2", settings, cancelling, min_interval_s=0)
    with pytest.raises(JobCancelled), ctx.keepalive("Waiting for AI", interval_s=0.05):
        time.sleep(0.3)
    assert threading.active_count() >= 1
