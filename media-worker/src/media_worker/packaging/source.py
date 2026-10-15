"""The real content the AI may use: transcript text (whole video or a Short's range), excerpts with real
times for thumbnail frames, and word chunks for summarising long transcripts."""

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Segment:
    start_ms: int
    end_ms: int
    text: str


def load_segments(path: Path, start_ms: int | None = None, end_ms: int | None = None) -> list[Segment]:
    """Transcript segments, optionally only those overlapping [start_ms, end_ms) and trimmed to its words."""
    data = json.loads(path.read_text(encoding="utf-8"))
    segments: list[Segment] = []
    for raw in data.get("segments", []):
        words = [w for w in raw.get("words", []) if len(w) == 3]
        if start_ms is not None and end_ms is not None:
            words = [w for w in words if start_ms <= (w[0] + w[1]) / 2 < end_ms]
            if not words:
                continue
            text = " ".join(str(w[2]).strip() for w in words).strip()
            segments.append(Segment(int(words[0][0]), int(words[-1][1]), text))
        else:
            text = str(raw.get("text", "")).strip()
            if text:
                segments.append(Segment(int(raw["startMs"]), int(raw["endMs"]), text))
    return segments


def word_count(text: str) -> int:
    return len(text.split())


def chunk_words(text: str, size: int) -> list[str]:
    words = text.split()
    return [" ".join(words[i : i + size]) for i in range(0, len(words), size)]


@dataclass(frozen=True)
class Excerpt:
    id: int
    start_ms: int
    text: str


def excerpts(segments: list[Segment], count: int = 10, max_chars: int = 160) -> list[Excerpt]:
    """Up to `count` segments spread across the content; the AI picks one for each thumbnail concept,
    so frame times always come from the transcript."""
    if not segments:
        return []
    step = max(1, len(segments) // count)
    picked = segments[::step][:count]
    return [
        Excerpt(
            id=i + 1, start_ms=s.start_ms, text=s.text if len(s.text) <= max_chars else s.text[: max_chars - 1] + "…"
        )
        for i, s in enumerate(picked)
    ]
