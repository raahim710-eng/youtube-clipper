import json
from typing import Any

import httpx

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.llm import LLMReplyError, http_error, unreachable

API_BASE = "https://generativelanguage.googleapis.com/v1beta"


class GeminiProvider:
    """Google Gemini API (free tier available). Transcript text is sent to Google — the UI warns about this.
    The API key is sent in a header, never in the URL."""

    name = "gemini"

    def __init__(self, settings: Settings, *, transport: httpx.BaseTransport | None = None):
        self.model = settings.gemini_model
        self._key = settings.gemini_api_key
        self._client = httpx.Client(
            base_url=API_BASE, timeout=httpx.Timeout(settings.llm_timeout_sec, connect=10.0), transport=transport
        )

    def check(self) -> None:
        if not self._key:
            raise JobError(
                "LLM_CREDENTIALS",
                "Gemini needs an API key. Create a free key at https://aistudio.google.com/app/apikey, put it in "
                ".env as GEMINI_API_KEY, restart the app, and retry.",
                retryable=False,
            )
        if not self.model:
            raise JobError(
                "LLM_NOT_CONFIGURED",
                "Set GEMINI_MODEL in .env to a model listed in Google AI Studio (for example a current Flash model).",
                retryable=False,
            )

    def generate_json(self, system: str, user: str, schema: dict[str, Any]) -> Any:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            # JSON mode; the schema is also described in the prompt and validated afterwards.
            "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
        }
        try:
            response = self._client.post(
                f"/models/{self.model}:generateContent", json=body, headers={"x-goog-api-key": self._key}
            )
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise JobError("LLM_TIMEOUT", "Gemini took too long to answer.", retryable=True) from error
        except httpx.TransportError as error:
            raise unreachable("gemini", type(error).__name__, "Check your internet connection, then retry.") from error
        except httpx.HTTPStatusError as error:
            raise http_error("gemini", error) from error
        try:
            text = response.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise LLMReplyError("Gemini replied without usable JSON") from error
