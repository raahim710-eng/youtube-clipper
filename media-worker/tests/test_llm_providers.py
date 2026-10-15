import json

import httpx
import pytest

from media_worker.config import Settings
from media_worker.errors import JobError
from media_worker.llm import LLMReplyError, get_llm_provider

SCHEMA = {"type": "object", "properties": {"clips": {"type": "array"}}}


def settings(**overrides: object) -> Settings:
    return Settings(_env_file=None, ollama_model="qwen2.5:1.5b", **overrides)  # type: ignore[arg-type]


def transport(handler):  # type: ignore[no-untyped-def]
    return httpx.MockTransport(handler)


def test_ollama_reports_a_missing_model_with_the_pull_command() -> None:
    t = transport(lambda request: httpx.Response(200, json={"models": [{"name": "llama3.2:1b"}]}))
    with pytest.raises(JobError) as error:
        get_llm_provider("ollama", settings(), transport=t).check()
    assert error.value.code == "LLM_MODEL_MISSING"
    assert "ollama pull qwen2.5:1.5b" in error.value.message


def test_ollama_not_running_is_explained() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(JobError) as error:
        get_llm_provider("ollama", settings(), transport=transport(refuse)).check()
    assert error.value.code == "LLM_UNAVAILABLE" and "Start the Ollama app" in error.value.message


def test_ollama_sends_the_schema_and_parses_the_reply() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"message": {"content": '{"clips": []}'}})

    provider = get_llm_provider("ollama", settings(), transport=transport(handler))
    assert provider.generate_json("system", "user", SCHEMA) == {"clips": []}
    assert seen["format"] == SCHEMA and seen["model"] == "qwen2.5:1.5b" and seen["stream"] is False


def test_invalid_json_is_a_reply_error_not_a_crash() -> None:
    t = transport(lambda request: httpx.Response(200, json={"message": {"content": "not json"}}))
    with pytest.raises(LLMReplyError):
        get_llm_provider("ollama", settings(), transport=t).generate_json("s", "u", SCHEMA)


def test_gemini_without_a_key_explains_how_to_get_one() -> None:
    with pytest.raises(JobError) as error:
        get_llm_provider("gemini", settings(gemini_model="some-flash-model")).check()
    assert error.value.code == "LLM_CREDENTIALS" and "aistudio.google.com" in error.value.message


def test_gemini_sends_the_key_in_a_header_not_the_url() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["key"] = str(request.url), request.headers.get("x-goog-api-key")
        body = {"candidates": [{"content": {"parts": [{"text": '{"clips": []}'}]}}]}
        return httpx.Response(200, json=body)

    provider = get_llm_provider(
        "gemini", settings(gemini_api_key="secret-key", gemini_model="m"), transport=transport(handler)
    )
    assert provider.generate_json("s", "u", SCHEMA) == {"clips": []}
    assert seen["key"] == "secret-key" and "secret-key" not in seen["url"]


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [(401, "LLM_CREDENTIALS", False), (429, "LLM_RATE_LIMITED", True), (404, "LLM_MODEL_MISSING", False)],
)
def test_http_errors_map_to_clear_codes(status: int, code: str, retryable: bool) -> None:
    t = transport(lambda request: httpx.Response(status, json={}))
    provider = get_llm_provider("gemini", settings(gemini_api_key="k", gemini_model="m"), transport=t)
    with pytest.raises(JobError) as error:
        provider.generate_json("s", "u", SCHEMA)
    assert error.value.code == code and error.value.retryable is retryable


def test_openai_compatible_needs_configuration_and_parses_replies() -> None:
    with pytest.raises(JobError):
        get_llm_provider("openai_compatible", settings()).check()
    reply = {"choices": [{"message": {"content": '{"clips": [1]}'}}]}
    provider = get_llm_provider(
        "openai_compatible",
        settings(openai_compat_base_url="http://127.0.0.1:1234/v1", openai_compat_model="local"),
        transport=transport(lambda request: httpx.Response(200, json=reply)),
    )
    assert provider.generate_json("s", "u", SCHEMA) == {"clips": [1]}


def test_unknown_provider_is_rejected() -> None:
    with pytest.raises(JobError):
        get_llm_provider("magic", settings())
