from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# media-worker/src/media_worker/config.py → repository root
REPO_ROOT = Path(__file__).resolve().parents[3]


def _repo_path(value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (REPO_ROOT / path).resolve()


class Settings(BaseSettings):
    """Reads the same `.env` as the web app (real environment variables take priority).
    Documentation for every variable is in `.env.example`."""

    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    app_internal_url: str = "http://localhost:3000"
    worker_shared_secret: str = ""
    storage_dir: str = "./storage"
    ffmpeg_path: str = ""
    ffprobe_path: str = ""
    worker_poll_interval_ms: int = 2000
    log_level: str = "info"

    # Transcription (Phase 4)
    transcription_provider: str = "faster-whisper"
    whisper_model: str = "base"
    whisper_device: str = "auto"
    whisper_compute_type: str = "int8"
    whisper_models_dir: str = "./models/whisper"

    # Clip analysis AI providers (Phase 4). Secrets stay in .env only (DECISIONS.md D-020).
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = ""
    ollama_num_ctx: int = 4096
    # Longest reply (tokens). Stops a small model that keeps generating, which would otherwise run into
    # LLM_TIMEOUT_SEC.
    ollama_num_predict: int = 1024
    gemini_api_key: str = ""
    gemini_model: str = ""
    openai_compat_base_url: str = ""
    openai_compat_api_key: str = ""
    openai_compat_model: str = ""
    llm_timeout_sec: int = 600

    # Shorts editor (Phase 5)
    face_models_dir: str = "./models/face"
    # Threads for FFmpeg (every encode/decode) and the speech model; 0 = automatic (all cores).
    render_threads: int = 0
    # Keep the speech model in memory between transcriptions (faster, but uses RAM all the time).
    whisper_keep_loaded: bool = False

    # Original video generator (Phase 9)
    tts_provider: str = "sapi"
    tts_voice: str = ""
    pexels_api_key: str = ""
    pixabay_api_key: str = ""

    @field_validator(
        "ffmpeg_path",
        "ffprobe_path",
        "worker_shared_secret",
        "ollama_model",
        "gemini_api_key",
        "gemini_model",
        "openai_compat_base_url",
        "openai_compat_api_key",
        "openai_compat_model",
        "tts_voice",
        "pexels_api_key",
        "pixabay_api_key",
        mode="before",
    )
    @classmethod
    def _strip(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @property
    def storage_root(self) -> Path:
        """Relative STORAGE_DIR values resolve from the repository root, exactly like the web app."""
        return _repo_path(self.storage_dir)

    @property
    def whisper_models_root(self) -> Path:
        return _repo_path(self.whisper_models_dir)

    @property
    def face_models_root(self) -> Path:
        return _repo_path(self.face_models_dir)


# Bundled OFL fonts used for captions (same typeface as the editor preview).
FONTS_DIR = REPO_ROOT / "media-worker" / "assets" / "fonts"


@lru_cache
def get_settings() -> Settings:
    return Settings()
