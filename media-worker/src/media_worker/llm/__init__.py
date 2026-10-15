"""AI (LLM) providers for clip analysis. Each returns JSON that the caller validates.

Providers are chosen per user (Settings › AI & processing). Models and secrets come from `.env`
only (DECISIONS.md D-020). Add a provider by implementing `LLMProvider` and registering it in
`get_llm_provider`."""

from typing import Any, Protocol

import httpx

from media_worker.config import Settings
from media_worker.errors import JobError

PROVIDER_LABELS = {
    "ollama": "Ollama (local)",
    "gemini": "Google Gemini API",
    "openai_compatible": "OpenAI-compatible server",
}


class LLMProvider(Protocol):
    name: str
    model: str

    def check(self) -> None:
        """Raise JobError with a fix-it message when the provider can't be used."""

    def generate_json(self, system: str, user: str, schema: dict[str, Any]) -> Any:
        """Return the parsed JSON reply. Raise LLMReplyError for unusable replies."""


class LLMReplyError(Exception):
    """The provider answered, but not with usable JSON (worth one retry)."""


def unreachable(provider: str, detail: str, fix: str) -> JobError:
    return JobError(
        "LLM_UNAVAILABLE",
        f"{PROVIDER_LABELS.get(provider, provider)} isn't reachable ({detail}). {fix}",
        retryable=False,
    )


def http_error(provider: str, error: httpx.HTTPStatusError) -> JobError:
    status = error.response.status_code
    label = PROVIDER_LABELS.get(provider, provider)
    if status in (401, 403):
        return JobError(
            "LLM_CREDENTIALS", f"{label} rejected the API key (HTTP {status}). Check the key in .env.", retryable=False
        )
    if status == 429:
        return JobError(
            "LLM_RATE_LIMITED", f"{label} says too many requests or the free quota is used up.", retryable=True
        )
    if status == 404:
        return JobError(
            "LLM_MODEL_MISSING", f"{label} doesn't know the configured model (HTTP 404). Check .env.", retryable=False
        )
    return JobError("LLM_ERROR", f"{label} returned HTTP {status}.", retryable=status >= 500)


def get_llm_provider(name: str, settings: Settings, *, transport: httpx.BaseTransport | None = None) -> LLMProvider:
    if name == "ollama":
        from media_worker.llm.ollama import OllamaProvider

        return OllamaProvider(settings, transport=transport)
    if name == "gemini":
        from media_worker.llm.gemini import GeminiProvider

        return GeminiProvider(settings, transport=transport)
    if name == "openai_compatible":
        from media_worker.llm.openai_compatible import OpenAICompatibleProvider

        return OpenAICompatibleProvider(settings, transport=transport)
    raise JobError("LLM_NOT_CONFIGURED", f"Unknown AI provider “{name}”.", retryable=False)
