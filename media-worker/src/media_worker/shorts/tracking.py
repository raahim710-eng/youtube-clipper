"""Auto framing: shot cuts + face tracking → a smooth path for the crop centre (DECISIONS.md D-015/D-039).

Pure functions over sampled frames, so they can be tested without video files or the face model.
"""

from dataclasses import dataclass, field

import numpy as np

# Shot cuts: average per-channel HSV change between consecutive frames (0–255 scale, like PySceneDetect's
# ContentDetector). Content inside one shot rarely exceeds ~15; hard cuts are usually far above 30.
CUT_THRESHOLD = 30.0
MIN_SHOT_MS = 1000
TRACK_MATCH_DISTANCE = 0.12  # max centre jump (fraction of width) between samples of the same face
STATIC_RANGE = 0.03  # a subject moving less than this stays perfectly still in the crop
SIMPLIFY_TOLERANCE = 0.004
MAX_KEYFRAMES = 150


@dataclass(frozen=True)
class Face:
    """Normalised to the frame (0–1)."""

    cx: float
    cy: float
    w: float
    h: float
    score: float


@dataclass
class Sample:
    t_ms: int
    faces: list[Face]


@dataclass
class Track:
    last_cx: float
    points: dict[int, float] = field(default_factory=dict)  # sample index → face centre x
    weight: float = 0.0


def frame_signature(frame_bgr: np.ndarray) -> np.ndarray:
    """Small HSV thumbnail used for cut detection."""
    import cv2

    small = cv2.resize(frame_bgr, (64, 36), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(small, cv2.COLOR_BGR2HSV).astype(np.float32)


def cut_score(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a - b)))


def detect_cuts(scores: list[float], times_ms: list[int]) -> list[int]:
    """Times (ms) where a new shot starts. `scores[i]` compares frame i with frame i-1 (scores[0] is ignored)."""
    cuts: list[int] = []
    last: int | None = None  # the first cut always counts; later ones need a minimum shot length
    for i in range(1, len(scores)):
        if scores[i] >= CUT_THRESHOLD and (last is None or times_ms[i] - last >= MIN_SHOT_MS):
            cuts.append(times_ms[i])
            last = times_ms[i]
    return cuts


def subject_path(samples: list[Sample]) -> list[float] | None:
    """Horizontal centre of the main face in each sample of one shot, or None if no face was seen.

    The main face is the track with the largest total of size × confidence — the person who is
    biggest and most consistently on screen. Gaps are filled by interpolation."""
    tracks: list[Track] = []
    for index, sample in enumerate(samples):
        used: set[int] = set()
        for face in sorted(sample.faces, key=lambda f: f.w * f.h, reverse=True):
            best, best_distance = None, TRACK_MATCH_DISTANCE
            for track_index, track in enumerate(tracks):
                distance = abs(track.last_cx - face.cx)
                if track_index not in used and distance <= best_distance:
                    best, best_distance = track_index, distance
            if best is None:
                tracks.append(Track(last_cx=face.cx))
                best = len(tracks) - 1
            used.add(best)
            track = tracks[best]
            track.points[index] = face.cx
            track.last_cx = face.cx
            track.weight += face.w * face.h * face.score
    if not tracks:
        return None
    main = max(tracks, key=lambda track: track.weight)
    known = sorted(main.points)
    xs = np.interp(np.arange(len(samples)), known, [main.points[i] for i in known])
    return [float(x) for x in xs]


def smooth(xs: list[float]) -> list[float]:
    """Median filter (drops one-off detection glitches), then a moving average (a calm, camera-like move)."""
    if len(xs) < 3:
        return list(xs)
    values = np.asarray(xs, dtype=np.float64)
    if values.max() - values.min() < STATIC_RANGE:
        return [float(values.mean())] * len(xs)
    padded = np.pad(values, 2, mode="edge")
    median = np.array([np.median(padded[i : i + 5]) for i in range(len(values))])
    window = min(7, len(values))
    kernel = np.ones(window) / window
    averaged = np.convolve(np.pad(median, window // 2, mode="edge"), kernel, mode="valid")[: len(values)]
    return [float(v) for v in averaged]


def simplify(points: list[tuple[int, float]], tolerance: float) -> list[tuple[int, float]]:
    """Ramer–Douglas–Peucker on (time, x): keeps only the keyframes needed to stay within `tolerance`."""
    if len(points) <= 2:
        return list(points)
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]  # iterative, so long clips can't hit Python's recursion limit
    while stack:
        first, last = stack.pop()
        (t0, x0), (t1, x1) = points[first], points[last]
        worst_index, worst = -1, tolerance
        for i in range(first + 1, last):
            t, x = points[i]
            expected = x0 + (x1 - x0) * ((t - t0) / (t1 - t0) if t1 != t0 else 0)
            if abs(x - expected) > worst:
                worst_index, worst = i, abs(x - expected)
        if worst_index != -1:
            keep.add(worst_index)
            stack.extend([(first, worst_index), (worst_index, last)])
    return [points[i] for i in sorted(keep)]


@dataclass
class FramingPath:
    keyframes: list[tuple[int, float]]  # (absolute ms in the source, crop centre 0–1)
    shots: int
    shots_with_face: int
    face_samples: int
    samples: int


def build_path(samples: list[Sample], cuts_ms: list[int], crop_fraction: float, end_ms: int) -> FramingPath:
    """Keyframes for the crop centre. Each shot gets its own smooth path; at a cut the crop jumps."""
    low, high = crop_fraction / 2, 1 - crop_fraction / 2
    boundaries = [samples[0].t_ms if samples else 0, *cuts_ms, end_ms + 1]
    keyframes: list[tuple[int, float]] = []
    shots_with_face = 0
    for shot_start, shot_end in zip(boundaries, boundaries[1:], strict=False):
        shot = [s for s in samples if shot_start <= s.t_ms < shot_end]
        if not shot:
            continue
        path = subject_path(shot)
        if path is None:
            xs = [0.5] * len(shot)  # nobody on screen: centre crop
        else:
            shots_with_face += 1
            xs = smooth(path)
        points = [(s.t_ms, float(min(max(x, low), high))) for s, x in zip(shot, xs, strict=True)]
        points[0] = (shot_start, points[0][1])
        points.append((min(shot_end - 1, end_ms), points[-1][1]))
        keyframes.extend(simplify(points, SIMPLIFY_TOLERANCE))

    tolerance = SIMPLIFY_TOLERANCE
    while len(keyframes) > MAX_KEYFRAMES:  # extremely busy footage: accept a slightly looser path
        tolerance *= 2
        keyframes = simplify(keyframes, tolerance)
    return FramingPath(
        keyframes=[(t, round(x, 4)) for t, x in keyframes],
        shots=len(cuts_ms) + 1,
        shots_with_face=shots_with_face,
        face_samples=sum(1 for s in samples if s.faces),
        samples=len(samples),
    )
