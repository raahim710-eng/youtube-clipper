"""gen.script — write a scene-by-scene script for a generated video (GEN-02).

Result fields match `genScriptResultSchema` in src/server/jobs/gen-script.ts.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from media_worker.errors import JobError
from media_worker.generator import script as scripting
from media_worker.job_context import JobContext
from media_worker.jobs.package import ask
from media_worker.llm import get_llm_provider


class ScriptPayload(BaseModel):
    projectId: str = Field(min_length=1)
    topic: str = Field(min_length=1, max_length=300)
    niche: str = Field(min_length=1, max_length=60)
    audience: str | None = Field(default=None, max_length=200)
    tone: str = Field(min_length=1, max_length=60)
    durationSec: int = Field(ge=30, le=300)
    aspectRatio: Literal["16:9", "9:16"]
    language: str = Field(default="English", max_length=40)
    notes: str | None = Field(default=None, max_length=1000)
    provider: str = Field(min_length=1)


def _clean(text: str) -> str:
    return " ".join(text.replace("<", "").replace(">", "").split())


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = ScriptPayload.model_validate(raw_payload)
    provider = get_llm_provider(payload.provider, ctx.settings)
    with ctx.keepalive("Checking the AI provider"):
        provider.check()
    brief = payload.model_dump()

    ctx.progress(10, "Writing the script")
    system = scripting.SYSTEM_PROMPT
    script = ask(
        provider, ctx, "Writing the script", scripting.prompt(brief), scripting.SCHEMA, scripting.Script, system=system
    )
    if script is None:
        raise JobError(
            "LLM_BAD_OUTPUT",
            f"The AI model ({provider.model}) didn't return a usable script. Try again or choose another model.",
            retryable=False,
        )
    warnings: list[str] = []
    feedback = scripting.fit_feedback(script, payload.durationSec)
    if feedback:
        ctx.progress(55, "Adjusting the script length")
        retry = ask(
            provider, ctx, "Adjusting the script length", scripting.prompt(brief, feedback), scripting.SCHEMA,
            scripting.Script, system=system,
        )  # fmt: skip
        target = scripting.target_words(payload.durationSec)

        def distance(candidate: scripting.Script) -> int:
            return abs(scripting.total_words(candidate) - target)

        if retry is not None and distance(retry) < distance(script):
            script = retry
    low, high = scripting.word_range(payload.durationSec)
    words = scripting.total_words(script)
    if not low <= words <= high:
        warnings.append(
            f"The script has {words} words; about {scripting.target_words(payload.durationSec)} fit "
            f"{payload.durationSec} seconds. Edit it, or the video will be {'longer' if words > high else 'shorter'}."
        )
    scenes = []
    for scene in script.scenes[:40]:
        narration = _clean(scene.narration)
        if not narration:
            continue
        scenes.append({
            "narration": narration[:1500],
            "visualQuery": " ".join(_clean(scene.visualQuery).split()[:6])[:120] or "abstract background",
            "onScreenText": _clean(scene.onScreenText)[:80] if scene.onScreenText else None,
            "estimatedMs": round(scripting.word_count(narration) / scripting.WORDS_PER_MINUTE * 60_000),
        })  # fmt: skip
    if not scenes:
        raise JobError("LLM_BAD_OUTPUT", "The script had no usable scenes. Try again.", retryable=False)
    return {
        "provider": provider.name,
        "model": provider.model,
        "title": _clean(script.title)[:120],
        "hook": _clean(script.hook)[:300],
        "scenes": scenes,
        "wordCount": sum(scripting.word_count(s["narration"]) for s in scenes),
        "targetWords": scripting.target_words(payload.durationSec),
        "warnings": warnings,
    }
