import json
import subprocess
from pathlib import Path

import httpx
import numpy as np
import pytest
from conftest import FFMPEG, FFPROBE, RecordingSink, make_video, requires_ffmpeg
from pydantic import ValidationError

from media_worker.config import Settings
from media_worker.errors import JobCancelled, JobError
from media_worker.job_context import JobContext
from media_worker.jobs import reframe, render_short
from media_worker.shorts.face_model import YUNET_FILE, ensure_model, model_path

CAPTION_STYLE = {
    "fontName": "Geist Black",
    "bold": False,
    "fontSize": 96,
    "textColor": "#FFFFFF",
    "background": "outline",
    "backgroundColor": "#000000",
    "backgroundAlpha": 0,
    "outline": 7,
    "centerY": 1344,
    "marginX": 90,
}
HOOK_STYLE = {**CAPTION_STYLE, "fontName": "Geist", "bold": True, "background": "box", "backgroundColor": "#FFFFFF",
              "textColor": "#111111", "outline": 14, "centerY": 307}  # fmt: skip


def probe(path: Path) -> dict:
    assert FFPROBE
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    return json.loads(out.stdout)


def render_payload(**overrides: object) -> dict:
    payload = {
        "shortId": "s1",
        "sourcePath": "videos/v1/source.mp4",
        "outputPath": "shorts/s1/render-a.mp4",
        "startMs": 1000,
        "endMs": 4500,
        "framing": {"mode": "crop", "keyframes": [{"tMs": 0, "x": 0.5}]},
        "captions": [],
        "captionStyle": None,
        "hook": None,
        "quality": "standard",
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def source(storage: Path) -> Path:
    return make_video(storage / "videos/v1/source.mp4", seconds=6, size="640x360")


@requires_ffmpeg
def test_render_makes_a_vertical_h264_aac_mp4_with_captions(storage: Path, settings: Settings, source: Path) -> None:
    captions = [
        {"startMs": 0, "endMs": 1200, "text": "Curly {braces} and back\\slash"},
        {"startMs": 1200, "endMs": 2400, "text": "Time 1:30 — C:\\N 😀"},
        {"startMs": 2400, "endMs": 3500, "text": "Last line"},
    ]
    hook = {"text": "Watch {this}", "endMs": 3000, "style": HOOK_STYLE}
    result = render_short.run(
        render_payload(captions=captions, captionStyle=CAPTION_STYLE, hook=hook),
        JobContext("j1", settings, RecordingSink()),
    )
    output = storage / "shorts/s1/render-a.mp4"
    info = probe(output)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["width"], video["height"], video["pix_fmt"]) == ("h264", 1080, 1920, "yuv420p")
    assert (audio["codec_name"], audio["sample_rate"], audio["channels"]) == ("aac", "48000", 2)
    assert abs(float(info["format"]["duration"]) - 3.5) <= 0.1  # SHORT-05: ±100 ms of the range
    assert abs(float(video.get("start_time", 0))) < 0.05 and abs(float(audio.get("start_time", 0))) < 0.05
    data = output.read_bytes()
    assert data.index(b"moov") < data.index(b"mdat"), "faststart: the index comes first"
    assert result["outputPath"] == "shorts/s1/render-a.mp4" and result["sizeBytes"] == len(data)
    assert (result["width"], result["height"]) == (1080, 1920)
    ass = (storage / "shorts/s1/captions.ass").read_text(encoding="utf-8")
    assert "Curly \\{braces\\} and back\\\u2060slash" in ass
    assert not (storage / "shorts/s1/fonts").exists(), "temporary font copies are removed"


@requires_ffmpeg
@pytest.mark.parametrize(
    "framing",
    [
        {"mode": "crop", "keyframes": [{"tMs": 0, "x": 0.0}]},
        {"mode": "crop", "keyframes": [{"tMs": 0, "x": 1.0}]},
        {"mode": "crop", "keyframes": [{"tMs": 0, "x": 0.1}, {"tMs": 1500, "x": 0.9}, {"tMs": 1500, "x": 0.2}]},
        {"mode": "blur", "keyframes": []},
    ],
    ids=["left-edge", "right-edge", "moving-with-cut", "blur"],
)
def test_every_framing_mode_renders_inside_the_frame(
    storage: Path, settings: Settings, source: Path, framing: dict
) -> None:
    render_short.run(render_payload(framing=framing, endMs=3000), JobContext("j1", settings, RecordingSink()))
    video = next(s for s in probe(storage / "shorts/s1/render-a.mp4")["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)


@requires_ffmpeg
def test_vertical_source_without_audio(storage: Path, settings: Settings) -> None:
    assert FFMPEG
    target = storage / "videos/v1/source.mp4"
    target.parent.mkdir(parents=True)
    subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=3",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(target)],
        check=True,
    )  # fmt: skip
    result = render_short.run(render_payload(startMs=0, endMs=2000), JobContext("j1", settings, RecordingSink()))
    assert result["audioCodec"] is None
    assert [s["codec_type"] for s in probe(storage / "shorts/s1/render-a.mp4")["streams"]] == ["video"]


@requires_ffmpeg
def test_cancelling_an_export_leaves_no_files(storage: Path, settings: Settings, source: Path) -> None:
    with pytest.raises(JobCancelled):
        render_short.run(render_payload(), JobContext("j1", settings, RecordingSink(cancel_after=1), min_interval_s=0))
    assert not list((storage / "shorts/s1").glob("*.mp4"))


def test_render_refuses_paths_outside_the_short_folder(settings: Settings) -> None:
    ctx = JobContext("j1", settings, RecordingSink())
    for bad in ("shorts/other/render.mp4", "videos/v1/render.mp4", "shorts/s1/render.mov"):
        with pytest.raises(ValidationError):
            render_short.run(render_payload(outputPath=bad), ctx)


def test_missing_source_is_reported(settings: Settings) -> None:
    with pytest.raises(JobError) as error:
        render_short.run(render_payload(), JobContext("j1", settings, RecordingSink()))
    assert error.value.code == "SOURCE_MISSING"


# --- Face tracking -------------------------------------------------------------------------------


def test_face_model_download_is_verified(tmp_path: Path) -> None:
    wrong = httpx.MockTransport(lambda request: httpx.Response(200, content=b"not the model"))
    with pytest.raises(JobError) as error:
        ensure_model(tmp_path, transport=wrong)
    assert error.value.code == "FACE_MODEL_INVALID" and not list(tmp_path.iterdir())

    def offline(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    with pytest.raises(JobError) as error:
        ensure_model(tmp_path, transport=httpx.MockTransport(offline))
    assert error.value.code == "FACE_MODEL_DOWNLOAD_FAILED" and error.value.retryable


DEFAULT_MODEL = model_path(Settings(_env_file=None).face_models_root)
requires_face_model = pytest.mark.skipif(
    not DEFAULT_MODEL.is_file(), reason=f"{YUNET_FILE} not downloaded yet (the worker fetches it on first use)"
)


def test_existing_model_is_used_without_network() -> None:
    if not DEFAULT_MODEL.is_file():
        pytest.skip("face model not downloaded")

    def no_network(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not download again")

    assert ensure_model(DEFAULT_MODEL.parent, transport=httpx.MockTransport(no_network)) == DEFAULT_MODEL


def make_moving_face_video(path: Path, seconds: float = 4.0, fps: int = 25) -> None:
    """A drawn face (skin-tone oval, eyes, nose, mouth) moving left → right over a plain background."""
    import cv2

    assert FFMPEG
    path.parent.mkdir(parents=True, exist_ok=True)
    width, height = 640, 360
    frames = int(seconds * fps)
    process = subprocess.Popen(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
         "-r", str(fps), "-i", "pipe:0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        stdin=subprocess.PIPE,
    )  # fmt: skip
    assert process.stdin
    for i in range(frames):
        image = np.full((height, width, 3), (90, 120, 140), np.uint8)
        cx = int(width * (0.2 + 0.6 * i / (frames - 1)))
        cv2.ellipse(image, (cx, 180), (60, 80), 0, 0, 360, (150, 180, 225), -1)
        cv2.circle(image, (cx - 22, 160), 8, (40, 40, 40), -1)
        cv2.circle(image, (cx + 22, 160), 8, (40, 40, 40), -1)
        cv2.line(image, (cx, 170), (cx - 5, 195), (110, 140, 190), 3)
        cv2.ellipse(image, (cx, 215), (22, 8), 0, 0, 180, (60, 60, 160), -1)
        process.stdin.write(image.tobytes())
    process.stdin.close()
    assert process.wait() == 0


@requires_ffmpeg
@requires_face_model
def test_auto_framing_follows_a_moving_face(storage: Path, settings: Settings) -> None:
    make_moving_face_video(storage / "videos/v1/source.mp4")
    settings = settings.model_copy(update={"face_models_dir": str(DEFAULT_MODEL.parent)})
    result = reframe.run(
        {"shortId": "s1", "sourcePath": "videos/v1/source.mp4", "startMs": 0, "endMs": 4000},
        JobContext("j1", settings, RecordingSink()),
    )
    xs = [k["x"] for k in result["keyframes"]]
    assert result["faceSamples"] >= 0.8 * result["samples"], "the drawn face is found in most frames"
    assert result["shots"] == 1 and result["warnings"] == []
    assert xs[0] < 0.35 and xs[-1] > 0.65, f"crop should travel left → right, got {xs}"
    assert xs == sorted(xs)


@requires_ffmpeg
@requires_face_model
def test_no_faces_keeps_the_crop_centred_and_says_so(storage: Path, settings: Settings, source: Path) -> None:
    settings = settings.model_copy(update={"face_models_dir": str(DEFAULT_MODEL.parent)})
    result = reframe.run(
        {"shortId": "s1", "sourcePath": "videos/v1/source.mp4", "startMs": 0, "endMs": 3000},
        JobContext("j1", settings, RecordingSink()),
    )
    assert {k["x"] for k in result["keyframes"]} == {0.5}
    assert "No faces were found" in result["warnings"][0]


@requires_ffmpeg
def test_vertical_video_needs_no_face_tracking(storage: Path, settings: Settings) -> None:
    make_video(storage / "videos/v1/source.mp4", seconds=2, size="360x640")
    result = reframe.run(
        {"shortId": "s1", "sourcePath": "videos/v1/source.mp4", "startMs": 0, "endMs": 2000},
        JobContext("j1", settings, RecordingSink()),
    )
    assert result["keyframes"] == [{"tMs": 0, "x": 0.5}] and "already vertical" in result["warnings"][0]
