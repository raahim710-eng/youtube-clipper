"""Chapter start times for long-form descriptions (PKG-03). Times come from transcript segment starts —
the AI only writes the chapter titles. YouTube needs the first chapter at 0:00, at least 3 chapters and
each at least 10 seconds long."""

from dataclasses import dataclass

from media_worker.packaging.source import Segment

MIN_VIDEO_MS = 180_000  # shorter videos get no chapters
MIN_CHAPTER_MS = 30_000  # stricter than YouTube's 10 s, so chapters are useful
TARGET_CHAPTER_MS = 120_000
MAX_CHAPTERS = 12


@dataclass(frozen=True)
class ChapterSlot:
    start_ms: int
    text: str  # transcript of the chapter, for the AI to name it


def chapter_slots(segments: list[Segment], duration_ms: int) -> list[ChapterSlot]:
    if duration_ms < MIN_VIDEO_MS or len(segments) < 3:
        return []
    count = max(3, min(MAX_CHAPTERS, round(duration_ms / TARGET_CHAPTER_MS)))
    starts = [0]
    for i in range(1, count):
        target = duration_ms * i / count
        candidates = [s.start_ms for s in segments if s.start_ms - starts[-1] >= MIN_CHAPTER_MS]
        candidates = [c for c in candidates if duration_ms - c >= MIN_CHAPTER_MS]
        if not candidates:
            break
        starts.append(min(candidates, key=lambda c: abs(c - target)))
    starts = sorted(set(starts))
    if len(starts) < 3:
        return []
    slots = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else duration_ms + 1
        text = " ".join(s.text for s in segments if start <= s.start_ms < end)
        slots.append(ChapterSlot(start_ms=start, text=text))
    return slots


def timestamp(ms: int) -> str:
    seconds = ms // 1000
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def chapter_block(chapters: list[tuple[int, str]]) -> str:
    return "Chapters\n" + "\n".join(f"{timestamp(start)} {title}" for start, title in chapters)
