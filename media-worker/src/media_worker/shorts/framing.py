"""FFmpeg filter graphs that turn any source into a 1080×1920 (9:16) picture.

Geometry mirrors src/lib/shorts/framing.ts (the editor preview): the crop keeps the full source height
(or full width for sources narrower than 9:16) and its horizontal centre follows the keyframes.
"""

from dataclasses import dataclass

OUT_W = 1080
OUT_H = 1920
TARGET_ASPECT = OUT_W / OUT_H


@dataclass(frozen=True)
class Keyframe:
    t_s: float  # seconds from the start of the Short
    x: float  # horizontal centre of the crop, 0–1 of the source width


@dataclass(frozen=True)
class CropBox:
    width: int
    height: int
    y: int
    horizontal: bool  # False when the source is already 9:16 or narrower (only a vertical crop/none)


def _even(value: float) -> int:
    return max(2, int(value) // 2 * 2)


def crop_box(src_w: int, src_h: int) -> CropBox:
    if src_w / src_h > TARGET_ASPECT:
        return CropBox(width=_even(src_h * TARGET_ASPECT), height=_even(src_h), y=0, horizontal=True)
    height = _even(src_w / TARGET_ASPECT)
    return CropBox(width=_even(src_w), height=height, y=_even((src_h - height) / 2) if src_h > height else 0,
                   horizontal=False)  # fmt: skip


def crop_x(center: float, src_w: int, crop_w: int) -> int:
    """Left edge in pixels for a crop centred at `center` (0–1), kept inside the frame."""
    return int(min(max(center * src_w - crop_w / 2, 0), src_w - crop_w))


def _num(value: float) -> str:
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def center_expression(keyframes: list[Keyframe]) -> str:
    """Piecewise-linear expression of the crop centre over time `t` (FFmpeg expression syntax)."""
    points = sorted(keyframes, key=lambda k: k.t_s)
    if not points:
        return "0.5"
    if len(points) == 1:
        return _num(points[0].x)
    expr = _num(points[-1].x)
    for a, b in reversed(list(zip(points, points[1:], strict=False))):
        span = b.t_s - a.t_s
        if span <= 0:
            continue
        segment = f"{_num(a.x)}+({_num(b.x - a.x)})*(t-{_num(a.t_s)})/{_num(span)}"
        expr = f"if(lt(t,{_num(b.t_s)}),{segment},{expr})"
    return f"if(lt(t,{_num(points[0].t_s)}),{_num(points[0].x)},{expr})"


def video_filter(
    mode: str,
    src_w: int,
    src_h: int,
    keyframes: list[Keyframe],
    *,
    fps_cap: float | None = None,
    subtitles: str | None = None,
) -> str:
    """Filter graph from input `[0:v]` to output `[v]`. `mode` is "crop" (centre/manual/auto) or "blur"."""
    pre = f"fps={_num(fps_cap)}," if fps_cap else ""
    post = f",ass={subtitles}:fontsdir=fonts" if subtitles else ""
    if mode == "blur":
        return (
            f"[0:v]{pre}split=2[a][b];"
            "[a]scale=216:384:force_original_aspect_ratio=increase,crop=216:384,gblur=sigma=10,"
            f"scale={OUT_W}:{OUT_H},eq=brightness=-0.08[bg];"
            f"[b]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p{post}[v]"
        )
    box = crop_box(src_w, src_h)
    x = f"'clip(({center_expression(keyframes)})*iw-ow/2,0,iw-ow)'" if box.horizontal else "0"
    return (
        f"[0:v]{pre}crop=w={box.width}:h={box.height}:x={x}:y={box.y},"
        f"scale={OUT_W}:{OUT_H}:flags=bicubic,setsar=1,format=yuv420p{post}[v]"
    )
