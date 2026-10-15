import subprocess
from pathlib import Path

import pytest
from conftest import FFPROBE, RecordingSink, make_video, requires_ffmpeg

from media_worker.config import Settings
from media_worker.errors import JobCancelled, JobError
from media_worker.job_context import JobContext
from media_worker.jobs import ingest


def payload(source_rel: str, max_minutes: int = 180) -> dict:
    video_dir = source_rel.rsplit("/", 1)[0]
    return {"videoId": "v1", "sourcePath": source_rel, "outputDir": video_dir, "maxDurationMinutes": max_minutes}


def codec_of(path: Path) -> str:
    assert FFPROBE
    cmd = [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]
    return subprocess.run([*cmd, str(path)], capture_output=True, text=True, check=True).stdout.strip()


@requires_ffmpeg
def test_browser_friendly_mp4_gets_poster_and_no_preview(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", "-movflags", "+faststart", seconds=3)
    sink = RecordingSink()
    result = ingest.run(payload("videos/v1/source.mp4"), JobContext("j1", settings, sink))

    assert (result["width"], result["height"]) == (320, 240)
    assert 2900 <= result["durationMs"] <= 3100
    assert (result["videoCodec"], result["audioCodec"], result["fps"]) == ("h264", "aac", 25)
    assert result["posterPath"] == "videos/v1/poster.jpg"
    assert (storage / "videos/v1/poster.jpg").stat().st_size > 0
    assert result["previewPath"] is None
    assert sink.calls, "progress should be reported"


@requires_ffmpeg
def test_hevc_mkv_gets_an_h264_preview(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mkv", seconds=2, vcodec="libx265")
    result = ingest.run(payload("videos/v1/source.mkv"), JobContext("j1", settings, RecordingSink(), min_interval_s=0))

    assert result["videoCodec"] == "hevc"
    assert result["previewPath"] == "videos/v1/preview.mp4"
    assert codec_of(storage / "videos/v1/preview.mp4") == "h264"
    assert not list((storage / "videos/v1").glob("*.partial.*")), "temporary files must be cleaned up"


@requires_ffmpeg
@pytest.mark.parametrize("content", [b"this is a text file pretending to be a video", b""])
def test_non_video_content_is_rejected(storage: Path, settings: Settings, content: bytes) -> None:
    source = storage / "videos/v1/source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(content)
    with pytest.raises(JobError) as error:
        ingest.run(payload("videos/v1/source.mp4"), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "INVALID_VIDEO"
    assert not error.value.retryable


@requires_ffmpeg
def test_truncated_mp4_is_rejected(storage: Path, settings: Settings) -> None:
    good = make_video(storage / "tmp/good.mp4", seconds=2)  # index (moov) is at the end without faststart
    source = storage / "videos/v1/source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(good.read_bytes()[: good.stat().st_size // 2])
    with pytest.raises(JobError) as error:
        ingest.run(payload("videos/v1/source.mp4"), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "INVALID_VIDEO"


@requires_ffmpeg
def test_videos_over_the_duration_limit_are_rejected(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", seconds=61, size="64x64")
    with pytest.raises(JobError) as error:
        ingest.run(payload("videos/v1/source.mp4", max_minutes=1), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "TOO_LONG"
    assert "limit is 1 minutes" in error.value.message


@requires_ffmpeg
def test_cancelling_stops_the_preview_and_cleans_up(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mkv", seconds=20, size="1280x720", vcodec="libx265")
    ctx = JobContext("j1", settings, RecordingSink(cancel_after=2), min_interval_s=0)
    with pytest.raises(JobCancelled):
        ingest.run(payload("videos/v1/source.mkv"), ctx)
    assert not (storage / "videos/v1/preview.mp4").exists()
    assert not list((storage / "videos/v1").glob("*.partial.*"))


def test_missing_source_file(storage: Path, settings: Settings) -> None:
    with pytest.raises(JobError) as error:
        ingest.run(payload("videos/v1/source.mp4"), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "SOURCE_MISSING"


def test_payload_paths_must_stay_in_storage(settings: Settings) -> None:
    with pytest.raises(ValueError):
        ingest.run(payload("../outside/source.mp4"), JobContext("j1", settings, RecordingSink()))


def test_missing_ffmpeg_is_explained(storage: Path) -> None:
    source = storage / "videos/v1/source.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"x")
    missing = str(storage / "nope.exe")
    settings = Settings(_env_file=None, storage_dir=str(storage), ffmpeg_path=missing, ffprobe_path=missing)
    with pytest.raises(JobError) as error:
        ingest.run(payload("videos/v1/source.mp4"), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "FFMPEG_MISSING"
    assert "winget install Gyan.FFmpeg" in error.value.message
