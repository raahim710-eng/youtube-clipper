"""gen.footage — find real moving stock footage for each scene (GEN-04). Up to 5 candidates per scene;
the best one is downloaded so the scene is ready to render. Scenes fail independently.

Result fields match `genFootageResultSchema` in src/server/jobs/gen-footage.ts.
"""

from typing import Any, Literal

import httpx
from pydantic import BaseModel, Field

from media_worker.errors import JobError
from media_worker.generator import stock
from media_worker.job_context import JobContext
from media_worker.storage import resolve_storage_path

CANDIDATES_PER_SCENE = 5


class SceneQuery(BaseModel):
    id: str = Field(min_length=1)
    query: str = Field(min_length=1, max_length=120)
    minDurationMs: int = Field(ge=0, le=600_000)


class FootagePayload(BaseModel):
    projectId: str = Field(min_length=1)
    orientation: Literal["landscape", "portrait"]
    scenes: list[SceneQuery] = Field(min_length=1, max_length=40)


def asset_path(candidate: stock.Candidate) -> str:
    return f"stock-cache/{candidate.provider}/{candidate.providerAssetId}.mp4"


def run(raw_payload: Any, ctx: JobContext, *, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    payload = FootagePayload.model_validate(raw_payload)
    settings = ctx.settings
    providers = [
        name for name, key in (("pexels", settings.pexels_api_key), ("pixabay", settings.pixabay_api_key)) if key
    ]
    if not providers:
        raise JobError(
            "STOCK_NOT_CONFIGURED",
            "No stock video provider is set up. Get a free Pexels API key at https://www.pexels.com/api/ and put it in "
            ".env as PEXELS_API_KEY — or use clips from your library or your own uploads.",
            retryable=False,
        )
    root = settings.storage_root
    cache = stock.SearchCache(root / "stock-cache")
    results: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    with httpx.Client(transport=transport, headers={"User-Agent": "CreatorStudioAssistant/1.0"}) as client:
        for index, scene in enumerate(payload.scenes):
            ctx.progress(
                5 + 90 * index / len(payload.scenes), f"Finding footage for scene {index + 1} of {len(payload.scenes)}"
            )
            found: list[stock.Candidate] = []
            errors: list[str] = []
            for provider in providers:
                try:
                    if provider == "pexels":
                        found += stock.search_pexels(
                            client, settings.pexels_api_key, scene.query, payload.orientation, cache
                        )
                    else:
                        found += stock.search_pixabay(
                            client, settings.pixabay_api_key, scene.query, payload.orientation, cache
                        )
                except JobError as error:
                    if error.code == "STOCK_CREDENTIALS":
                        raise
                    errors.append(error.message)
            ranked = stock.rank(found, scene.minDurationMs, CANDIDATES_PER_SCENE)
            if not ranked:
                failed.append(
                    {
                        "id": scene.id,
                        "error": errors[0]
                        if errors
                        else f"No suitable clips found for “{scene.query}”. Try other keywords.",
                    }
                )
                continue
            candidates = []
            for position, candidate in enumerate(ranked):
                entry = {**candidate.to_dict(), "filePath": None}
                if position == 0:  # the best match is downloaded now; others when chosen
                    target = resolve_storage_path(asset_path(candidate), root)
                    try:
                        if not target.is_file():
                            stock.download(client, candidate, target)
                        entry["filePath"] = asset_path(candidate)
                    except JobError as error:
                        errors.append(error.message)
                candidates.append(entry)
            results.append({"id": scene.id, "candidates": candidates, "warnings": errors[:2]})
    if not results:
        raise JobError(
            "STOCK_NONE_FOUND", f"No footage was found. {failed[0]['error'] if failed else ''}".strip(), retryable=False
        )
    return {"providers": providers, "scenes": results, "failed": failed}
