import json
import os
import subprocess
import wave
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FFMPEG, FFPROBE, RecordingSink, make_video, requires_ffmpeg

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.generator import script as scripting
from media_worker.generator import stock
from media_worker.generator.motion import has_motion
from media_worker.generator.tts import SapiProvider, proportional_words, word_ends
from media_worker.job_context import JobContext
from media_worker.jobs import gen_footage, gen_narrate, gen_render, gen_script

requires_windows = pytest.mark.skipif(os.name != "nt", reason="Windows' built-in voices")


# --- Script (GEN-02) ---------------------------------------------------------------------------------


def test_word_budget_and_scene_count() -> None:
    assert scripting.target_words(60) == 150
    assert scripting.word_range(60) == (120, 180)
    assert scripting.scene_count(30) == 4 and scripting.scene_count(300) == 30 and scripting.scene_count(10) == 3


def script_reply(words: int, scenes: int = 4) -> dict:
    per = words // scenes
    return {
        "title": "Why the ocean is salty",
        "hook": "Ever tasted the sea?",
        "scenes": [
            {
                "narration": " ".join(["word"] * per) + ".",
                "visualQuery": "ocean waves sunset",
                "onScreenText": "Salty seas",
            }
            for _ in range(scenes)
        ],
    }


class ScriptProvider:
    name = "fake"
    model = "fake-model"

    def __init__(self, replies: list[Any]):
        self.replies = replies
        self.prompts: list[str] = []

    def check(self) -> None:
        pass

    def generate_json(self, system: str, user: str, schema: dict) -> Any:
        self.prompts.append(user)
        return self.replies.pop(0)


BRIEF = {
    "projectId": "p1",
    "topic": "Why is the ocean salty?",
    "niche": "science",
    "tone": "friendly",
    "durationSec": 60,
    "aspectRatio": "9:16",
    "provider": "fake",
}


def run_script(provider: ScriptProvider, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(gen_script, "get_llm_provider", lambda name, s: provider)
    return gen_script.run(BRIEF, JobContext("j1", settings, RecordingSink()))


def test_script_too_long_is_rewritten_to_fit(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    provider = ScriptProvider([script_reply(260), script_reply(148)])
    result = run_script(provider, settings, monkeypatch)
    low, high = scripting.word_range(60)
    assert low <= result["wordCount"] <= high and result["warnings"] == []
    assert "had 260 words, but it must have between 120 and 180" in provider.prompts[1]
    assert "<brief>Topic: Why is the ocean salty?" in provider.prompts[0] and "vertical (9:16)" in provider.prompts[0]
    assert result["scenes"][0]["estimatedMs"] == round(37 / 150 * 60_000)
    assert result["scenes"][0]["visualQuery"] == "ocean waves sunset"


def test_script_that_still_misses_the_length_comes_with_a_warning(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = ScriptProvider([script_reply(40), script_reply(60)])
    result = run_script(provider, settings, monkeypatch)
    assert result["wordCount"] == 60  # the closer of the two
    assert "about 150 fit 60 seconds" in result["warnings"][0]


def test_unusable_script_fails_clearly(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    provider = ScriptProvider([{"title": "x"}, {"scenes": "nope"}])
    with pytest.raises(JobError) as error:
        run_script(provider, settings, monkeypatch)
    assert error.value.code == "LLM_BAD_OUTPUT"


# --- Narration (GEN-03) ------------------------------------------------------------------------------


def test_word_end_times_and_fallback() -> None:
    assert word_ends([(100, "Hello"), (600, "world")], 1200) == [(100, 600, "Hello"), (600, 950, "world")]
    words = proportional_words("one two three", 3000)
    assert [w[2] for w in words] == ["one", "two", "three"]
    assert (
        words[0][0] == 150
        and words[-1][1] <= 2750
        and all(a[1] <= b[0] + 1 for a, b in zip(words, words[1:], strict=False))
    )


@requires_windows
def test_windows_voice_speaks_with_word_timings(tmp_path: Path, settings: Settings) -> None:
    speech = SapiProvider(settings).speak("Stock footage makes this video move.", tmp_path / "a.wav")
    with wave.open(str(tmp_path / "a.wav")) as wav:
        assert wav.getframerate() == 16000 and wav.getnchannels() == 1
    assert 1200 < speech.duration_ms < 6000
    assert speech.words and [w[2] for w in speech.words] == ["Stock", "footage", "makes", "this", "video", "move"]
    starts = [w[0] for w in speech.words]
    assert starts == sorted(starts) and speech.words[-1][1] <= speech.duration_ms


@requires_windows
def test_narration_job_keeps_going_when_one_scene_fails(
    storage: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = SapiProvider.speak

    def flaky(self: SapiProvider, text: str, target: Path, rate: int = 0):  # type: ignore[no-untyped-def]
        if "broken" in text:
            raise JobError("TTS_FAILED", "The Windows voice failed: simulated", retryable=False)
        return original(self, text, target, rate)

    monkeypatch.setattr(SapiProvider, "speak", flaky)
    result = gen_narrate.run(
        {
            "projectId": "p1",
            "provider": "sapi",
            "scenes": [
                {"id": "s1", "text": "Hello there.", "outputPath": "generator/p1/narration/s1.wav"},
                {"id": "s2", "text": "This one is broken.", "outputPath": "generator/p1/narration/s2.wav"},
            ],
        },
        JobContext("j1", settings, RecordingSink()),
    )
    assert [s["id"] for s in result["scenes"]] == ["s1"] and result["scenes"][0]["timing"] == "engine"
    assert result["failed"] == [{"id": "s2", "error": "The Windows voice failed: simulated"}]
    assert (storage / "generator/p1/narration/s1.wav").is_file()


@requires_windows
def test_env_voice_is_only_a_default_but_a_chosen_voice_must_exist(settings: Settings) -> None:
    configured = settings.model_copy(update={"tts_voice": "af_heart"})  # a Kokoro voice id left in .env
    provider = SapiProvider(configured)
    provider.check()
    assert provider.voice == ""  # Windows' default voice
    with pytest.raises(JobError) as error:
        SapiProvider(configured, "No Such Voice").check()
    assert error.value.code == "TTS_VOICE_MISSING"


def test_narration_paths_are_fixed(settings: Settings) -> None:
    with pytest.raises(ValueError):
        gen_narrate.run(
            {"projectId": "p1", "provider": "sapi", "scenes": [{"id": "s", "text": "x", "outputPath": "videos/x.wav"}]},
            JobContext("j1", settings, RecordingSink()),
        )


def test_missing_tts_engine_is_explained(settings: Settings) -> None:
    from media_worker.generator.tts import KokoroProvider

    try:
        import kokoro  # noqa: F401

        pytest.skip("Kokoro is installed")
    except ImportError:
        pass
    with pytest.raises(JobError) as error:
        KokoroProvider(settings).check()
    assert error.value.code == "TTS_NOT_INSTALLED" and "uv pip install" in error.value.message


# --- Stock footage (GEN-04) --------------------------------------------------------------------------


def pexels_video(id_: int, width: int, height: int, duration: int, host: str = "videos.pexels.com") -> dict:
    return {
        "id": id_,
        "width": width,
        "height": height,
        "duration": duration,
        "url": f"https://www.pexels.com/video/{id_}/",
        "image": f"https://images.pexels.com/videos/{id_}/x.jpg",
        "user": {"name": f"Creator {id_}", "url": f"https://www.pexels.com/@c{id_}"},
        "video_files": [
            {"quality": "sd", "width": width // 3, "height": height // 3, "link": f"https://{host}/{id_}/sd.mp4"},
            {"quality": "hd", "width": width // 2, "height": height // 2, "link": f"https://{host}/{id_}/hd.mp4"},
            {"quality": "hd", "width": width, "height": height, "link": f"https://{host}/{id_}/uhd.mp4"},
        ],
    }


class FakeStock:
    def __init__(self, pexels: dict | None = None, pixabay: dict | None = None, status: int = 200):
        self.pexels = pexels or {"videos": []}
        self.pixabay = pixabay or {"hits": []}
        self.status = status
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(str(request.url))
        if request.url.host == "api.pexels.com":
            assert request.headers["Authorization"] == "pexels-key"
            return httpx.Response(self.status, json=self.pexels)
        if request.url.host == "pixabay.com":
            return httpx.Response(self.status, json=self.pixabay)
        return httpx.Response(200, content=b"\x00\x00\x00\x18ftypmp42" + b"x" * 100)


def test_pexels_results_are_filtered_and_ranked(tmp_path: Path) -> None:
    fake = FakeStock({"videos": [
        pexels_video(1, 1080, 1920, 4),  # portrait, too short → ranked after long ones
        pexels_video(2, 1920, 1080, 30),  # landscape → wrong orientation for a Short
        pexels_video(3, 2160, 3840, 20),  # portrait 4K, long enough
        pexels_video(4, 720, 1280, 15),  # portrait, its smaller files are under 720 px
    ]})  # fmt: skip
    with httpx.Client(transport=httpx.MockTransport(fake)) as client:
        found = stock.search_pexels(client, "pexels-key", "ocean waves", "portrait", stock.SearchCache(tmp_path))
    ranked = stock.rank(found, min_duration_ms=8000)
    assert [c.providerAssetId for c in ranked] == ["4", "3", "1"]
    by_id = {c.providerAssetId: c for c in ranked}
    assert (by_id["3"].width, by_id["3"].height) == (720, 1280)  # smallest file that is ≥ 720 px
    assert by_id["3"].downloadUrl == "https://videos.pexels.com/3/sd.mp4" and by_id["3"].licenseName == "Pexels License"
    assert by_id["3"].creatorName == "Creator 3" and by_id["3"].durationMs == 20_000
    assert "orientation=portrait" in fake.calls[0] and fake.calls[0].startswith(
        "https://api.pexels.com/v1/videos/search"
    )


def test_searches_are_cached_for_24_hours(tmp_path: Path) -> None:
    fake = FakeStock({"videos": [pexels_video(3, 2160, 3840, 20)]})
    cache = stock.SearchCache(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(fake)) as client:
        stock.search_pexels(client, "pexels-key", "ocean", "portrait", cache)
        stock.search_pexels(client, "pexels-key", "ocean", "portrait", cache)
    assert len(fake.calls) == 1
    entry = next((tmp_path / "search" / "pexels").glob("*.json"))
    data = json.loads(entry.read_text())
    data["at"] -= 24 * 3600 + 1
    entry.write_text(json.dumps(data))
    with httpx.Client(transport=httpx.MockTransport(fake)) as client:
        stock.search_pexels(client, "pexels-key", "ocean", "portrait", cache)
    assert len(fake.calls) == 2


def test_downloads_only_from_official_hosts(tmp_path: Path) -> None:
    fake = FakeStock()
    good = stock.Candidate("pexels", "9", "", "", None, "https://videos.pexels.com/9/hd.mp4", None, 720, 1280, 5000, "")
    bad = stock.Candidate("pexels", "9", "", "", None, "https://evil.example.com/x.mp4", None, 720, 1280, 5000, "")
    with httpx.Client(transport=httpx.MockTransport(fake)) as client:
        assert stock.download(client, good, tmp_path / "a.mp4") > 0
        with pytest.raises(JobError) as error:
            stock.download(client, bad, tmp_path / "b.mp4")
    assert error.value.code == "STOCK_HOST_REFUSED" and not (tmp_path / "b.mp4").exists()


def test_footage_job_downloads_the_best_clip_and_keeps_going(storage: Path, settings: Settings) -> None:
    fake = FakeStock({"videos": [pexels_video(3, 2160, 3840, 20), pexels_video(5, 1080, 1920, 12)]})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.pexels.com" and "nothing" in str(request.url):
            return httpx.Response(200, json={"videos": []})
        return fake(request)

    settings = settings.model_copy(update={"pexels_api_key": "pexels-key"})
    result = gen_footage.run(
        {
            "projectId": "p1",
            "orientation": "portrait",
            "scenes": [
                {"id": "s1", "query": "ocean waves", "minDurationMs": 6000},
                {"id": "s2", "query": "nothing matches", "minDurationMs": 6000},
            ],
        },
        JobContext("j1", settings, RecordingSink()),
        transport=httpx.MockTransport(handler),
    )
    assert result["providers"] == ["pexels"]
    [scene] = result["scenes"]
    assert len(scene["candidates"]) == 2
    assert (
        scene["candidates"][0]["filePath"] == "stock-cache/pexels/5.mp4" and scene["candidates"][1]["filePath"] is None
    )
    assert (storage / "stock-cache/pexels/5.mp4").is_file()
    assert result["failed"][0]["id"] == "s2" and "Try other keywords" in result["failed"][0]["error"]


def test_footage_without_any_key_is_explained(settings: Settings) -> None:
    with pytest.raises(JobError) as error:
        gen_footage.run(
            {"projectId": "p1", "orientation": "landscape", "scenes": [{"id": "s1", "query": "x", "minDurationMs": 0}]},
            JobContext("j1", settings, RecordingSink()),
        )
    assert error.value.code == "STOCK_NOT_CONFIGURED" and "https://www.pexels.com/api/" in error.value.message


def test_rejected_key_stops_the_search(settings: Settings) -> None:
    settings = settings.model_copy(update={"pexels_api_key": "pexels-key"})
    with pytest.raises(JobError) as error:
        gen_footage.run(
            {"projectId": "p1", "orientation": "landscape", "scenes": [{"id": "s1", "query": "x", "minDurationMs": 0}]},
            JobContext("j1", settings, RecordingSink()),
            transport=httpx.MockTransport(FakeStock(status=401)),
        )
    assert error.value.code == "STOCK_CREDENTIALS"


# --- Motion and rendering (GEN-05) -------------------------------------------------------------------


def still_video(path: Path, seconds: float = 3) -> Path:
    assert FFMPEG
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=steelblue:s=640x360:d={seconds}:r=25",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )  # fmt: skip
    return path


def tone(path: Path, seconds: float, frequency: int = 440) -> Path:
    assert FFMPEG
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
         "-ar", "16000", "-ac", "1", str(path)],
        check=True,
    )  # fmt: skip
    return path


@requires_ffmpeg
def test_motion_check_tells_footage_from_still_images(tmp_path: Path) -> None:
    assert FFMPEG
    assert has_motion(FFMPEG, make_video(tmp_path / "moving.mp4", seconds=3)) is True
    assert has_motion(FFMPEG, still_video(tmp_path / "still.mp4")) is False


def probe(path: Path) -> dict:
    assert FFPROBE
    out = subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                         capture_output=True, text=True, check=True)  # fmt: skip
    return json.loads(out.stdout)


CAPTION_STYLE = {
    "fontName": "Geist Black", "bold": False, "fontSize": 64, "textColor": "#FFFFFF", "background": "outline",
    "backgroundColor": "#000000", "backgroundAlpha": 0, "outline": 5, "centerY": 560, "marginX": 60,
}  # fmt: skip


@requires_ffmpeg
def test_render_assembles_moving_footage_narration_and_captions(storage: Path, settings: Settings) -> None:
    make_video(storage / "generator/p1/clips/a.mp4", seconds=1, size="640x360")  # shorter than its scene: looped
    make_video(storage / "generator/p1/clips/b.mp4", seconds=6, size="1280x720")
    tone(storage / "generator/p1/narration/s1.wav", 2.0)
    tone(storage / "generator/p1/narration/s2.wav", 1.5, 660)
    tone(storage / "generator/p1/music.wav", 1.0, 220)
    payload = {
        "projectId": "p1",
        "outputPath": "videos/v9/source.mp4",
        "width": 1280,
        "height": 720,
        "transitionMs": 400,
        "scenes": [
            {"id": "s1", "number": 1, "audioPath": "generator/p1/narration/s1.wav", "durationMs": 2000,
             "footage": {"path": "generator/p1/clips/a.mp4"}},
            {"id": "s2", "number": 2, "audioPath": "generator/p1/narration/s2.wav", "durationMs": 1500,
             "footage": {"path": "generator/p1/clips/b.mp4", "startMs": 1000}},
        ],
        "captions": [{"startMs": 0, "endMs": 1900, "text": "Hello there"},
                     {"startMs": 2000, "endMs": 3400, "text": "Second scene"}],
        "captionStyle": CAPTION_STYLE,
        "music": {"path": "generator/p1/music.wav", "volumeDb": -18},
    }  # fmt: skip
    result = gen_render.run(payload, JobContext("j1", settings, RecordingSink()))
    output = storage / "videos/v9/source.mp4"
    info = probe(output)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["width"], video["height"], video["codec_name"]) == (1280, 720, "h264")
    assert audio["codec_name"] == "aac"
    assert abs(float(info["format"]["duration"]) - 3.9) <= 0.5  # narration 3.5 s + 0.4 s transition
    assert result["outputPath"] == "videos/v9/source.mp4" and result["width"] == 1280
    assert FFMPEG and has_motion(FFMPEG, output, 0.2, 3.0)
    assert not (storage / "generator/p1/render").exists(), "temporary files removed"


@requires_ffmpeg
def test_render_refuses_still_images_and_names_the_scene(storage: Path, settings: Settings) -> None:
    make_video(storage / "generator/p1/clips/a.mp4", seconds=3)
    still_video(storage / "generator/p1/clips/still.mp4")
    tone(storage / "generator/p1/narration/s1.wav", 1.0)
    tone(storage / "generator/p1/narration/s2.wav", 1.0)
    payload = {
        "projectId": "p1",
        "outputPath": "videos/v9/source.mp4",
        "width": 720,
        "height": 1280,
        "scenes": [
            {"id": "s1", "number": 1, "audioPath": "generator/p1/narration/s1.wav", "durationMs": 1000,
             "footage": {"path": "generator/p1/clips/a.mp4"}},
            {"id": "s2", "number": 2, "audioPath": "generator/p1/narration/s2.wav", "durationMs": 1000,
             "footage": {"path": "generator/p1/clips/still.mp4"}},
        ],
    }  # fmt: skip
    with pytest.raises(JobError) as error:
        gen_render.run(payload, JobContext("j1", settings, RecordingSink()))
    assert (
        error.value.code == "SCENE_FOOTAGE"
        and "scene 2" in error.value.message
        and "doesn't move" in error.value.message
    )
    assert not (storage / "videos/v9/source.mp4").exists()


def test_render_output_path_is_fixed(settings: Settings) -> None:
    with pytest.raises(ValueError):
        gen_render.run(
            {"projectId": "p", "outputPath": "generator/p/out.mp4", "width": 640, "height": 360,
             "scenes": [{"id": "s", "number": 1, "audioPath": "a.wav", "durationMs": 1000, "footage": {"path": "x"}}]},
            JobContext("j1", settings, RecordingSink()),
        )  # fmt: skip


@requires_ffmpeg
def test_long_videos_are_joined_in_batches_with_the_same_timing(
    storage: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gen_render, "MAX_JOIN_INPUTS", 2)  # 5 scenes → 3 parts → 2 parts → final pass
    scenes = []
    for number in range(1, 6):
        make_video(storage / f"generator/p1/clips/{number}.mp4", seconds=2, size="320x180")
        tone(storage / f"generator/p1/narration/{number}.wav", 0.8, 300 + 50 * number)
        scenes.append({"id": f"s{number}", "number": number, "audioPath": f"generator/p1/narration/{number}.wav",
                       "durationMs": 800, "footage": {"path": f"generator/p1/clips/{number}.mp4"}})  # fmt: skip
    payload = {"projectId": "p1", "outputPath": "videos/v5/source.mp4", "width": 320, "height": 568, "scenes": scenes}
    gen_render.run(payload, JobContext("j1", settings, RecordingSink()))
    info = probe(storage / "videos/v5/source.mp4")
    assert abs(float(info["format"]["duration"]) - 4.4) <= 0.3  # 5 × 0.8 s + 0.4 s transition
    assert not (storage / "generator/p1/render").exists()
