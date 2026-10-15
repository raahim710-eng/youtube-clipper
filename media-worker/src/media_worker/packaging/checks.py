"""Checks applied to AI packaging before anyone sees it (PKG-02, and the brief's "no misleading titles,
unrelated hashtags or unsupported claims"). Limits mirror src/lib/packaging/limits.ts.

YouTube Data API: title ≤ 100 characters, description ≤ 5,000 bytes, neither may contain < or >.
"""

import re
import unicodedata

TITLE_MAX_CHARS = 100
DESCRIPTION_MAX_BYTES = 5000
HASHTAGS_MAX = 15
HASHTAG_MAX_CHARS = 30
HEADLINE_MAX_WORDS = 5

# Wording that promises more than a video usually delivers. Flagged for the creator, not removed.
CLICKBAIT = (
    "you won't believe",
    "you wont believe",
    "shocking",
    "gone wrong",
    "exposed",
    "insane",
    "mind-blowing",
    "mind blowing",
    "this changes everything",
    "secret they",
    "nobody tells you",
    "will blow your mind",
    "100% guaranteed",
    "guaranteed",
)

_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_PLACEHOLDER = re.compile(r"\[[^\]]{1,40}\]|\{[^}]{1,40}\}|\bX{3,}\b|\bTBD\b")
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_NUMBER_WORDS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "twenty": "20",
    "thirty": "30", "forty": "40", "fifty": "50", "hundred": "100", "thousand": "1000",
}  # fmt: skip


def clean_line(text: str) -> str:
    """One line of text: no control characters, no < or >, single spaces."""
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C" or ch == " ")
    return " ".join(text.replace("<", "").replace(">", "").split())


def clean_title(text: str) -> tuple[str, bool]:
    """Returns the title within YouTube's limits and whether it had to be shortened."""
    text = clean_line(text).strip("\"'“”")
    if len(text) <= TITLE_MAX_CHARS:
        return text, False
    cut = text[:TITLE_MAX_CHARS]
    if " " in cut[60:]:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-–—"), True


def clean_description(text: str) -> tuple[str, bool]:
    """Keeps paragraphs, removes < and >, and cuts at a line or word boundary to fit 5,000 bytes."""
    text = text.replace("\r\n", "\n").replace("<", "").replace(">", "")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if len(text.encode("utf-8")) <= DESCRIPTION_MAX_BYTES:
        return text, False
    encoded = text.encode("utf-8")[:DESCRIPTION_MAX_BYTES]
    cut = encoded.decode("utf-8", errors="ignore")
    boundary = max(cut.rfind("\n"), cut.rfind(" "))
    if boundary > len(cut) * 0.8:
        cut = cut[:boundary]
    return cut.rstrip(), True


def source_vocabulary(*texts: str) -> set[str]:
    words: set[str] = set()
    for text in texts:
        for word in _WORD.findall(text.lower()):
            words.add(word)
            if word in _NUMBER_WORDS:
                words.add(_NUMBER_WORDS[word])
    return words


def source_numbers(*texts: str) -> set[str]:
    numbers = {n.replace(",", "") for text in texts for n in _NUMBER.findall(text)}
    return numbers | {digit for text in texts for word, digit in _NUMBER_WORDS.items() if word in text.lower().split()}


def flags_for(text: str, numbers: set[str]) -> list[str]:
    """Plain-language warnings shown next to a suggestion."""
    flags: list[str] = []
    missing = sorted({n.replace(",", "") for n in _NUMBER.findall(text)} - numbers)
    if missing:
        flags.append(f"Mentions {', '.join(missing)}, which isn't in the transcript — check it's accurate.")
    lower = text.lower()
    bait = [phrase for phrase in CLICKBAIT if phrase in lower]
    if bait:
        flags.append(f"Sensational wording (“{bait[0]}”) — make sure the video delivers it.")
    if _PLACEHOLDER.search(text):
        flags.append("Contains a placeholder such as [Name] — fill it in or remove it.")
    letters = [ch for ch in text if ch.isalpha()]
    if len(letters) > 10 and sum(ch.isupper() for ch in letters) / len(letters) > 0.6:
        flags.append("Mostly capital letters — can read as shouting.")
    return flags


_SENTENCE_WORD = re.compile(r"(^|[.!?:;]\s+|\n\s*)?\b([A-Z][a-z]{2,})\b")
# Capitalised words that are fine without appearing in the transcript.
_COMMON_CAPITALS = {
    "the", "this", "that", "these", "those", "join", "learn", "watch", "discover", "find", "how", "why", "what",
    "when", "where", "who", "in", "on", "with", "and", "but", "or", "for", "from", "our", "your", "you", "we",
    "they", "he", "she", "it", "its", "my", "today", "here", "there", "chapters", "youtube", "shorts", "video",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
}  # fmt: skip


def unsupported_names(text: str, vocabulary: set[str]) -> list[str]:
    """Capitalised words inside sentences (likely names of people, places or products) that never appear in
    the transcript, title or notes — small models sometimes invent who is speaking."""
    names: list[str] = []
    for match in _SENTENCE_WORD.finditer(text):
        sentence_start, word = match.group(1) is not None, match.group(2)
        if sentence_start or match.start(2) == 0:
            continue
        lowered = word.lower()
        if lowered in _COMMON_CAPITALS or lowered in vocabulary or lowered.rstrip("s") in vocabulary:
            continue
        if word not in names:
            names.append(word)
    return names


def name_flags(text: str, vocabulary: set[str]) -> list[str]:
    names = unsupported_names(text, vocabulary)
    if not names:
        return []
    return [f"Mentions {', '.join(names[:3])}, which isn't in the transcript — check it's correct."]


def normalize_hashtag(raw: str) -> str | None:
    """'#Video Editing!' → 'VideoEditing'. Letters, digits and underscores only."""
    parts = _WORD.findall(raw.replace("#", " "))
    tag = "".join(part[:1].upper() + part[1:] if i else part for i, part in enumerate(parts))
    tag = tag.replace("_", "")
    if not tag or tag.isdigit() or len(tag) > HASHTAG_MAX_CHARS:
        return None
    return tag


def _parts(tag: str) -> list[str]:
    """CamelCase and digit runs → lower-case words: 'VideoEditing2024' → ['video', 'editing', '2024']."""
    return [p.lower() for p in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+|[^\W\d_]+", tag)]


def is_related(tag: str, vocabulary: set[str]) -> bool:
    """A hashtag is related when one of its words (4+ letters, compared by their first 5 letters) appears in
    the transcript, title or notes. Short tags are compared whole."""
    lowered = tag.lower()
    if lowered in vocabulary:
        return True
    stems = {word[:5] for word in vocabulary if len(word) >= 4}
    return any(len(part) >= 4 and part[:5] in stems for part in _parts(tag))


def clean_hashtags(
    raw: list[str], vocabulary: set[str], *, extra: list[str] | None = None
) -> tuple[list[str], list[str]]:
    """Normalised, de-duplicated (case-insensitive), related hashtags (≤ 15) and the ones dropped as unrelated."""
    kept: list[str] = []
    dropped: list[str] = []
    seen: set[str] = set()
    for value in [*(extra or []), *raw]:
        tag = normalize_hashtag(value)
        if not tag or tag.lower() in seen:
            continue
        seen.add(tag.lower())
        if tag in (extra or []) or is_related(tag, vocabulary):
            kept.append(tag)
        else:
            dropped.append(tag)
    return kept[:HASHTAGS_MAX], dropped


def clean_headline(text: str) -> str:
    words = clean_line(text).strip("\"'“”").split()
    return " ".join(words[:HEADLINE_MAX_WORDS])
