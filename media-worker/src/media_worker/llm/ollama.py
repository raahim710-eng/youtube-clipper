import json
from typing import Any

import httpx

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.llm import LLMReplyError, http_error, unreachable


class OllamaProvider:
    """Local models via Ollama's REST API. Uses JSON-schema constrained output (`format`)."""

    name = "ollama"

    def __init__(self, settings: Settings, *, transport: httpx.BaseTransport | None = None):
        self.model = settings.ollama_model
        self.num_ctx = settings.ollama_num_ctx
        self.num_predict = settings.ollama_num_predict
        self._client = httpx.Client(
            base_url=settings.ollama_base_url.rstrip("/"),
            timeout=httpx.Timeout(settings.llm_timeout_sec, connect=5.0),
            transport=transport,
        )

    def check(self) -> None:
        if not self.model:
            raise JobError(
                "LLM_NOT_CONFIGURED",
                "No Ollama model is set. Add OLLAMA_MODEL to .env (for example qwen2.5:1.5b) and restart the app.",
                retryable=False,
            )
        try:
            tags = self._client.get("/api/tags", timeout=10)
            tags.raise_for_status()
        except httpx.TransportError as error:
            raise unreachable(
                "ollama", type(error).__name__, "Start the Ollama app (or run `ollama serve`), then retry."
            ) from error
        except httpx.HTTPStatusError as error:
            raise http_error("ollama", error) from error
        names = {m.get("name") for m in tags.json().get("models", [])} | {
            m.get("model") for m in tags.json().get("models", [])
        }
        wanted = self.model if ":" in self.model else f"{self.model}:latest"
        if self.model not in names and wanted not in names:
            raise JobError(
                "LLM_MODEL_MISSING",
                f"The Ollama model “{self.model}” isn't downloaded yet. Run `ollama pull {self.model}`, then retry.",
                retryable=False,
            )

    def generate_json(self, system: str, user: str, schema: dict[str, Any]) -> Any:
        body = {
            "model": self.model,
            "stream": False,
            "format": schema,
            "keep_alive": "10m",
            "options": {"temperature": 0.2, "num_ctx": self.num_ctx, "num_predict": self.num_predict},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        try:
            response = self._client.post("/api/chat", json=body)
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise JobError(
                "LLM_TIMEOUT", "The local AI model took too long to answer (LLM_TIMEOUT_SEC).", retryable=True
            ) from error
        except httpx.TransportError as error:
            raise unreachable("ollama", type(error).__name__, "Start the Ollama app, then retry.") from error
        except httpx.HTTPStatusError as error:
            raise http_error("ollama", error) from error
        content = response.json().get("message", {}).get("content", "")
        try:
            return json.loads(content)
        except json.JSONDecodeError as error:
            raise LLMReplyError("Ollama replied with invalid JSON") from error
