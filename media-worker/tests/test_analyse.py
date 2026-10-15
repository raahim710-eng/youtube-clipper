import pytest

from media_worker.errors import JobError
from media_worker.jobs.ingest import VideoInfo, analyse, needs_preview


def probe_with(*streams: dict, duration: str | None = "12.5") -> dict:
    return {"streams": list(streams), "format": {"duration": duration} if duration else {}}


VIDEO = {
    "codec_type": "video",
    "codec_name": "h264",
    "width": 1920,
    "height": 1080,
    "avg_frame_rate": "30000/1001",
    "pix_fmt": "yuv420p",
}
AUDIO = {"codec_type": "audio", "codec_name": "aac"}


def test_reads_basic_details() -> None:
    info = analyse(probe_with(VIDEO, AUDIO))
    assert (info.width, info.height, info.fps, info.video_codec, info.audio_codec) == (1920, 1080, 29.97, "h264", "aac")
    assert info.duration_s == 12.5


def test_swaps_size_for_rotated_phone_video() -> None:
    rotated = {**VIDEO, "side_data_list": [{"rotation": -90}]}
    info = analyse(probe_with(rotated))
    assert (info.width, info.height) == (1080, 1920)


def test_cover_art_is_not_a_video_track() -> None:
    cover = {**VIDEO, "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
    with pytest.raises(JobError) as error:
        analyse(probe_with(cover, AUDIO))
    assert error.value.code == "INVALID_VIDEO"
    assert not error.value.retryable


def test_missing_duration_is_allowed() -> None:
    assert analyse(probe_with(VIDEO, duration=None)).duration_s is None


@pytest.mark.parametrize(
    ("container", "vcodec", "acodec", "pix_fmt", "expected"),
    [
        ("mp4", "h264", "aac", "yuv420p", False),
        ("mp4", "hevc", "aac", "yuv420p", True),
        ("mp4", "h264", "aac", "yuv420p10le", True),
        ("webm", "vp9", "opus", "yuv420p", False),
        ("mov", "h264", "aac", "yuv420p", True),
        ("mkv", "h264", "aac", "yuv420p", True),
        ("mp4", "h264", "pcm_s16le", "yuv420p", True),
    ],
)
def test_preview_decision(container: str, vcodec: str, acodec: str, pix_fmt: str, expected: bool) -> None:
    info = VideoInfo(10.0, 1280, 720, 25.0, vcodec, acodec, pix_fmt)
    assert needs_preview(container, info) is expected
