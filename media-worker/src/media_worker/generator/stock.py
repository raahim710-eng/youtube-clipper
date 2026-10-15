"""Stock video search and download (GEN-04, D-011). Pexels (free key) and optionally Pixabay (free key).

- Searches are cached for 24 hours on disk (Pixabay requires it; it also saves Pexels' 200/hour quota).
- Results are filtered: orientation, length ≥ what the scene needs (or loopable), height ≥ 720 px.
- Files are downloaded only from the providers' own media hosts and never hot-linked.
"""

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx

from media_worker.errors import JobError

CACHE_SECONDS = 24 * 3600
MIN_HEIGHT = 720
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
# Official media hosts (Pexels serves video files from its own CDN and, for older items, Vimeo).
ALLOWED_HOSTS = {
    "pexels": ("videos.pexels.com", "player.vimeo.com"),
    "pixabay": ("cdn.pixabay.com",),
}
LICENSES = {"pexels": "Pexels License", "pixabay": "Pixabay Content License"}


@dataclass
class Candidate:
    provider: str
    providerAssetId: str
    pageUrl: str
    creatorName: str
    creatorUrl: str | None
    downloadUrl: str
    previewImageUrl: str | None
    width: int
    height: int
    durationMs: int
    licenseName: str

    def to_dict(self) -> dict:
        return asdict(self)


def orientation_ok(width: int, height: int, orientation: str) -> bool:
    return height > width if orientation == "portrait" else width >= height


def pick_file(files: list[dict], orientation: str, min_height: int = MIN_HEIGHT) -> dict | None:
    """The smallest file that is at least `min_height` on its short side — enough quality, fastest download."""
    usable = []
    for item in files:
        width, height = int(item.get("width") or 0), int(item.get("height") or 0)
        if min(width, height) >= min_height and orientation_ok(width, height, orientation) and item.get("link"):
            usable.append(item)
    return min(usable, key=lambda f: int(f["width"]) * int(f["height"])) if usable else None


class SearchCache:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, provider: str, key: str) -> Path:
        return self.root / "search" / provider / f"{hashlib.sha256(key.encode()).hexdigest()[:32]}.json"

    def get(self, provider: str, key: str, now: float | None = None) -> dict | None:
        path = self._path(provider, key)
        if not path.is_file():
            return None
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            fresh = (now or time.time()) - float(entry["at"]) < CACHE_SECONDS
            return entry["data"] if fresh else None
        except (OSError, ValueError, KeyError, TypeError):
            return None  # a damaged cache file is just a miss; the next search overwrites it

    def put(self, provider: str, key: str, data: dict, now: float | None = None) -> None:
        path = self._path(provider, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".partial")
        partial.write_text(json.dumps({"at": now or time.time(), "data": data}), encoding="utf-8")
        os.replace(partial, path)


def _get(client: httpx.Client, url: str, provider: str, **kwargs) -> dict:
    try:
        response = client.get(url, timeout=30, **kwargs)
    except httpx.HTTPError as error:
        raise JobError(
            "STOCK_UNAVAILABLE",
            f"{provider.title()} couldn't be reached. Check the internet connection.",
            retryable=True,
        ) from error
    if response.status_code in (401, 403):
        raise JobError(
            "STOCK_CREDENTIALS", f"{provider.title()} rejected the API key. Check it in .env.", retryable=False
        )
    if response.status_code == 429:
        raise JobError(
            "STOCK_RATE_LIMITED",
            f"{provider.title()}'s free request limit is used up for now. Try again later.",
            retryable=True,
        )
    if response.status_code >= 400:
        raise JobError(
            "STOCK_ERROR",
            f"{provider.title()} returned HTTP {response.status_code}.",
            retryable=response.status_code >= 500,
        )
    return response.json()


def search_pexels(client: httpx.Client, key: str, query: str, orientation: str, cache: SearchCache) -> list[Candidate]:
    params = {"query": query, "orientation": orientation, "size": "small", "per_page": "15"}
    cache_key = json.dumps(params, sort_keys=True)
    data = cache.get("pexels", cache_key)
    if data is None:
        data = _get(
            client, "https://api.pexels.com/v1/videos/search", "pexels", params=params, headers={"Authorization": key}
        )
        cache.put("pexels", cache_key, data)
    candidates = []
    for video in data.get("videos", []):
        file = pick_file(video.get("video_files", []), orientation)
        if not file:
            continue
        user = video.get("user") or {}
        candidates.append(Candidate(
            provider="pexels",
            providerAssetId=str(video["id"]),
            pageUrl=str(video.get("url", "")),
            creatorName=str(user.get("name") or "Pexels creator"),
            creatorUrl=user.get("url"),
            downloadUrl=str(file["link"]),
            previewImageUrl=video.get("image"),
            width=int(file["width"]),
            height=int(file["height"]),
            durationMs=int(float(video.get("duration") or 0) * 1000),
            licenseName=LICENSES["pexels"],
        ))  # fmt: skip
    return candidates


def _pixabay_user_url(hit: dict) -> str | None:
    return f"https://pixabay.com/users/{hit.get('user')}-{hit.get('user_id')}/" if hit.get("user_id") else None


def search_pixabay(client: httpx.Client, key: str, query: str, orientation: str, cache: SearchCache) -> list[Candidate]:
    params = {"q": query[:100], "video_type": "film", "per_page": "20", "safesearch": "true"}
    cache_key = json.dumps(params, sort_keys=True)
    data = cache.get("pixabay", cache_key)
    if data is None:
        data = _get(client, "https://pixabay.com/api/videos/", "pixabay", params={**params, "key": key})
        cache.put("pixabay", cache_key, data)
    candidates = []
    for hit in data.get("hits", []):
        files = [
            {"width": v.get("width"), "height": v.get("height"), "link": v.get("url")}
            for v in (hit.get("videos") or {}).values()
            if isinstance(v, dict)
        ]
        file = pick_file(files, orientation)
        if not file:
            continue
        candidates.append(Candidate(
            provider="pixabay",
            providerAssetId=str(hit["id"]),
            pageUrl=str(hit.get("pageURL", "")),
            creatorName=str(hit.get("user") or "Pixabay creator"),
            creatorUrl=_pixabay_user_url(hit),
            downloadUrl=str(file["link"]),
            previewImageUrl=None,
            width=int(file["width"]),
            height=int(file["height"]),
            durationMs=int(float(hit.get("duration") or 0) * 1000),
            licenseName=LICENSES["pixabay"],
        ))  # fmt: skip
    return candidates


def rank(candidates: list[Candidate], min_duration_ms: int, limit: int = 5) -> list[Candidate]:
    """Clips long enough for the scene first (shorter ones are looped), then closer to the needed length."""

    def score(c: Candidate) -> tuple[int, int]:
        return (0 if c.durationMs >= min_duration_ms else 1, abs(c.durationMs - min_duration_ms))

    seen: set[tuple[str, str]] = set()
    unique = []
    for c in sorted(candidates, key=score):
        if (c.provider, c.providerAssetId) not in seen:
            seen.add((c.provider, c.providerAssetId))
            unique.append(c)
    return unique[:limit]


def download(client: httpx.Client, candidate: Candidate, target: Path) -> int:
    """Streams the file from an allowlisted host to `target`. Returns its size."""
    host = urlparse(candidate.downloadUrl).hostname or ""
    if urlparse(candidate.downloadUrl).scheme != "https" or host not in ALLOWED_HOSTS.get(candidate.provider, ()):
        raise JobError("STOCK_HOST_REFUSED", f"Refused to download from {host or 'an unknown host'}.", retryable=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".partial")
    size = 0
    try:
        with client.stream("GET", candidate.downloadUrl, timeout=120, follow_redirects=False) as response:
            if response.status_code != 200:
                raise JobError(
                    "STOCK_DOWNLOAD_FAILED",
                    f"Downloading the clip failed (HTTP {response.status_code}).",
                    retryable=True,
                )
            with partial.open("wb") as handle:
                for chunk in response.iter_bytes(1 << 16):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD_BYTES:
                        raise JobError("STOCK_TOO_LARGE", "The clip is larger than 200 MB.", retryable=False)
                    handle.write(chunk)
        os.replace(partial, target)
    except httpx.HTTPError as error:
        raise JobError("STOCK_DOWNLOAD_FAILED", "Downloading the clip failed. Try again.", retryable=True) from error
    finally:
        partial.unlink(missing_ok=True)
    return size
