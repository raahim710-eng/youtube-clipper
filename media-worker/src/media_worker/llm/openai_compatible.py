import json
from typing import Any

import httpx

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.llm import LLMReplyError, http_error, unreachable


class OpenAICompatibleProvider:
    """Any server with an OpenAI-style /chat/completions endpoint — e.g. LM Studio or llama.cpp running
    locally. Only use paid hosted services after an explicit decision (CLAUDE.md cost rules)."""

    name = "openai_compatible"

    def __init__(self, settings: Settings, *, transport: httpx.BaseTransport | None = None):
        self.model = settings.openai_compat_model
        self._base = settings.openai_compat_base_url.rstrip("/")
        headers = (
            {"Authorization": f"Bearer {settings.openai_compat_api_key}"} if settings.openai_compat_api_key else {}
        )
        self._client = httpx.Client(
            base_url=self._base or "http://invalid.local",
            headers=headers,
            timeout=httpx.Timeout(settings.llm_timeout_sec, connect=5.0),
            transport=transport,
        )

    def check(self) -> None:
        if not self._base or not self.model:
            raise JobError(
                "LLM_NOT_CONFIGURED",
                "Set OPENAI_COMPAT_BASE_URL (for example http://127.0.0.1:1234/v1) and OPENAI_COMPAT_MODEL in .env.",
                retryable=False,
            )

    def generate_json(self, system: str, user: str, schema: dict[str, Any]) -> Any:
        body = {
            "model": self.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        try:
            response = self._client.post("/chat/completions", json=body)
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise JobError("LLM_TIMEOUT", "The AI server took too long to answer.", retryable=True) from error
        except httpx.TransportError as error:
            raise unreachable("openai_compatible", type(error).__name__, "Start the server, then retry.") from error
        except httpx.HTTPStatusError as error:
            raise http_error("openai_compatible", error) from error
        try:
            return json.loads(response.json()["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise LLMReplyError("The server replied without usable JSON") from error
