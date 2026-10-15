"""gen.narrate — speak each scene with the configured voice (GEN-03). Scenes fail independently: one
failure doesn't stop the others.

Result fields match `genNarrateResultSchema` in src/server/jobs/gen-narrate.ts.
"""

from pathlib import PurePosixPath
from typing import Any

from pydantic import BaseModel, Field, model_validator

from media_worker.errors import JobError
from media_worker.generator.tts import get_tts_provider, proportional_words
from media_worker.job_context import JobContext
from media_worker.storage import resolve_storage_path


class SceneText(BaseModel):
    id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=1500)
    outputPath: str = Field(min_length=1)


class NarratePayload(BaseModel):
    projectId: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    voice: str | None = Field(default=None, max_length=100)
    rate: int = Field(default=0, ge=-10, le=10)
    scenes: list[SceneText] = Field(min_length=1, max_length=40)

    @model_validator(mode="after")
    def _paths(self) -> "NarratePayload":
        folder = PurePosixPath(f"generator/{self.projectId}/narration")
        for scene in self.scenes:
            if PurePosixPath(scene.outputPath).parent != folder or not scene.outputPath.endswith(".wav"):
                raise ValueError("narration must be written to generator/{projectId}/narration/*.wav")
        return self


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = NarratePayload.model_validate(raw_payload)
    provider = get_tts_provider(payload.provider, ctx.settings, payload.voice)
    with ctx.keepalive("Preparing the voice"):
        provider.check()
    done: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for index, scene in enumerate(payload.scenes):
        ctx.progress(5 + 90 * index / len(payload.scenes), f"Speaking scene {index + 1} of {len(payload.scenes)}")
        target = resolve_storage_path(scene.outputPath, ctx.settings.storage_root)
        try:
            with ctx.keepalive(f"Speaking scene {index + 1} of {len(payload.scenes)}"):
                speech = provider.speak(scene.text, target, payload.rate)
        except JobError as error:
            if error.code in ("TTS_NOT_INSTALLED", "TTS_UNAVAILABLE", "TTS_NOT_CONFIGURED"):
                raise
            failed.append({"id": scene.id, "error": error.message})
            continue
        words = speech.words
        timing = "engine"
        if not words:
            words = proportional_words(scene.text, speech.duration_ms)
            timing = "estimated"
        done.append({
            "id": scene.id,
            "audioPath": scene.outputPath,
            "durationMs": speech.duration_ms,
            "words": [[start, end, text] for start, end, text in words],
            "timing": timing,
        })  # fmt: skip
    if not done:
        raise JobError("TTS_FAILED", f"No scene could be narrated: {failed[0]['error'] if failed else 'unknown error'}",
                       retryable=False)  # fmt: skip
    return {"provider": provider.name, "voice": provider.voice or None, "scenes": done, "failed": failed}
