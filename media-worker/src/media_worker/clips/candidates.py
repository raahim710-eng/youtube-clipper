"""Turns a transcript into candidate clip windows and scores them with measurable speech patterns.

Every boundary comes from real transcript word timings; nothing here (or in the AI step) invents
timestamps. The heuristic score is explainable on purpose — the UI shows why a window ranked high.
"""

import re
import statistics
from dataclasses import dataclass, field
from typing import Any

SENTENCE_END = re.compile(r"[.!?…]['\"”’)]*$")
PAUSE_SPLIT_MS = 800  # a pause this long also ends a sentence
MAX_SENTENCE_MS = 25_000  # very long run-on "sentences" are split at their largest pause
START_PAD_MS = 150
END_PAD_MS = 300


@dataclass(frozen=True)
class Word:
    start_ms: int
    end_ms: int
    text: str


@dataclass
class Sentence:
    words: list[Word]

    @property
    def start_ms(self) -> int:
        return self.words[0].start_ms

    @property
    def end_ms(self) -> int:
        return self.words[-1].end_ms

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


@dataclass
class Window:
    id: int
    first_word: int
    last_word: int
    start_ms: int
    end_ms: int
    text: str
    heuristic: int = 0
    signals: list[str] = field(default_factory=list)

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def load_words(transcript: dict[str, Any]) -> list[Word]:
    words: list[Word] = []
    for segment in transcript.get("segments", []):
        for start, end, text in segment.get("words", []):
            if isinstance(text, str) and text.strip() and int(end) >= int(start):
                words.append(Word(int(start), int(end), text.strip()))
    words.sort(key=lambda w: w.start_ms)
    return words


def split_sentences(words: list[Word]) -> list[Sentence]:
    sentences: list[Sentence] = []
    current: list[Word] = []
    for index, word in enumerate(words):
        current.append(word)
        nxt = words[index + 1] if index + 1 < len(words) else None
        gap = (nxt.start_ms - word.end_ms) if nxt else 0
        if nxt is None or SENTENCE_END.search(word.text) or gap >= PAUSE_SPLIT_MS:
            sentences.extend(_split_long(current))
            current = []
    return sentences


def _split_long(words: list[Word]) -> list[Sentence]:
    if words[-1].end_ms - words[0].start_ms <= MAX_SENTENCE_MS or len(words) < 4:
        return [Sentence(words)]
    gaps = [(words[i + 1].start_ms - words[i].end_ms, i) for i in range(1, len(words) - 2)]
    _, cut = max(gaps)
    return _split_long(words[: cut + 1]) + _split_long(words[cut + 1 :])


def build_windows(words: list[Word], sentences: list[Sentence], min_ms: int, max_ms: int) -> list[Window]:
    """Windows that start at a sentence start and end at a sentence end, between min and max length.
    For each starting sentence we keep up to three lengths so the AI can pick the best-sized one."""
    index_of = {id(w): i for i, w in enumerate(words)}
    windows: list[Window] = []
    for i, first in enumerate(sentences):
        kept = 0
        for j in range(i, len(sentences)):
            duration = sentences[j].end_ms - first.start_ms
            if duration > max_ms:
                break
            if duration < min_ms:
                continue
            chosen = sentences[i : j + 1]
            text = " ".join(s.text for s in chosen)
            windows.append(
                Window(
                    id=len(windows) + 1,
                    first_word=index_of[id(first.words[0])],
                    last_word=index_of[id(chosen[-1].words[-1])],
                    start_ms=first.start_ms,
                    end_ms=chosen[-1].end_ms,
                    text=text,
                )
            )
            kept += 1
            if kept == 3:
                break
    return windows


def padded_bounds(window: Window, words: list[Word], duration_ms: int) -> tuple[int, int]:
    """Adds a little air around the words without reaching into the neighbouring words."""
    prev_end = words[window.first_word - 1].end_ms if window.first_word > 0 else 0
    next_start = words[window.last_word + 1].start_ms if window.last_word + 1 < len(words) else duration_ms
    start = max(prev_end, window.start_ms - START_PAD_MS, 0)
    end = min(next_start, window.end_ms + END_PAD_MS, duration_ms)
    return start, max(end, window.end_ms)


def _loudness(transcript: dict[str, Any], start_ms: int, end_ms: int) -> float | None:
    info = transcript.get("loudness") or {}
    values, step = info.get("db") or [], info.get("windowMs") or 500
    chunk = values[start_ms // step : max(start_ms // step + 1, end_ms // step)]
    voiced = [v for v in chunk if v > -60]
    return statistics.fmean(voiced) if voiced else None


def score_windows(windows: list[Window], words: list[Word], transcript: dict[str, Any]) -> None:
    """Heuristic 0–100 score from pace, energy, emphasis, a clean start and a good length."""
    if not windows:
        return
    paces = [len(range(w.first_word, w.last_word + 1)) / max(w.duration_ms / 1000, 1) for w in windows]
    median_pace = statistics.median(paces)
    all_loud = [v for v in (transcript.get("loudness") or {}).get("db", []) if v > -60]
    median_loud = statistics.median(all_loud) if all_loud else None

    for window, pace in zip(windows, paces, strict=True):
        signals: list[str] = []
        score = 0.0
        # Pace: a bit faster than the speaker's usual pace reads as energy (max 25).
        pace_ratio = pace / median_pace if median_pace else 1.0
        score += 25 * max(0.0, min(1.0, (pace_ratio - 0.8) / 0.4))
        if pace_ratio >= 1.1:
            signals.append("faster than usual speech")
        # Loudness compared with the rest of the video (max 25).
        loud = _loudness(transcript, window.start_ms, window.end_ms)
        if loud is not None and median_loud is not None:
            score += 25 * max(0.0, min(1.0, (loud - median_loud + 2) / 6))
            if loud - median_loud >= 2:
                signals.append("louder than the rest of the video")
        # Emphasis: questions, exclamations and numbers often mark hooks and facts (max 20).
        questions, exclaims = window.text.count("?"), window.text.count("!")
        numbers = len(re.findall(r"\d", window.text)) > 0
        score += min(20, 8 * questions + 8 * exclaims + (4 if numbers else 0))
        if questions:
            signals.append("asks a question")
        if exclaims:
            signals.append("has an exclamation")
        if numbers:
            signals.append("mentions a number")
        # Clean start: begins after a pause, i.e. a new thought (max 15).
        gap_before = window.start_ms - words[window.first_word - 1].end_ms if window.first_word else 1000
        if gap_before >= 400:
            score += 15
            signals.append("starts after a natural pause")
        # Length: 20–45 s is the sweet spot for Shorts (max 15).
        seconds = window.duration_ms / 1000
        score += 15 if 20 <= seconds <= 45 else 8 if 12 <= seconds <= 60 else 3
        window.heuristic = round(max(0.0, min(100.0, score)))
        window.signals = signals


def overlap_ratio(a: Window, b: Window) -> float:
    overlap = min(a.end_ms, b.end_ms) - max(a.start_ms, b.start_ms)
    return max(0, overlap) / min(a.duration_ms, b.duration_ms)


def shortlist(windows: list[Window], count: int, duration_ms: int) -> list[Window]:
    """Picks the windows sent to the AI: the best one in each part of the video first (so long videos
    are covered evenly), then the best remaining ones, skipping near-duplicates."""
    if count <= 0 or not windows:
        return []
    ranked = sorted(windows, key=lambda w: (-w.heuristic, w.start_ms))
    buckets = max(1, count // 2)
    chosen: list[Window] = []

    def add(window: Window) -> None:
        if len(chosen) < count and all(overlap_ratio(window, other) < 0.5 for other in chosen):
            chosen.append(window)

    for bucket in range(buckets):
        lo, hi = duration_ms * bucket / buckets, duration_ms * (bucket + 1) / buckets
        best = next((w for w in ranked if lo <= w.start_ms < hi), None)
        if best:
            add(best)
    for window in ranked:
        add(window)
    return sorted(chosen, key=lambda w: w.start_ms)


def pick_final(scored: list[tuple[Window, int]], limit: int) -> list[tuple[Window, int]]:
    """Highest scores first, no overlapping clips."""
    result: list[tuple[Window, int]] = []
    for window, score in sorted(scored, key=lambda item: (-item[1], item[0].start_ms)):
        if len(result) >= limit:
            break
        if all(window.end_ms <= other.start_ms or window.start_ms >= other.end_ms for other, _ in result):
            result.append((window, score))
    return result
