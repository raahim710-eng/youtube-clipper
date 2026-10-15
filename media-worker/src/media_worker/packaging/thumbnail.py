"""Thumbnail mock-ups (PKG-06, DECISIONS.md D-016): a real video frame (or the creator's own image),
cropped to the thumbnail shape, optionally with a headline. No image generation is involved."""

import io
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from media_worker.config import FONTS_DIR

MAX_BYTES = 2 * 1024 * 1024  # YouTube's custom thumbnail limit
HEADLINE_FONT = FONTS_DIR / "Geist-Black.ttf"


def cover(image: Image.Image, width: int, height: int) -> Image.Image:
    """Scale and centre-crop to exactly width × height."""
    return ImageOps.fit(image.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS)


def _wrap(draw: ImageDraw.ImageDraw, words: list[str], font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in words:
        attempt = f"{current} {word}".strip()
        if current and draw.textlength(attempt, font=font) > max_width:
            lines.append(current)
            current = word
        else:
            current = attempt
    if current:
        lines.append(current)
    return lines


def fit_headline(
    draw: ImageDraw.ImageDraw, text: str, max_width: int, max_height: int, start_size: int, *, max_lines: int = 3
) -> tuple[ImageFont.FreeTypeFont, list[str]]:
    """Largest font size at which the headline wraps into ≤ max_lines lines inside the box."""
    words = text.upper().split()
    size = start_size
    while True:
        font = ImageFont.truetype(str(HEADLINE_FONT), size)
        lines = _wrap(draw, words, font, max_width)
        too_wide = any(draw.textlength(line, font=font) > max_width for line in lines)
        if (len(lines) <= max_lines and not too_wide and len(lines) * size * 1.1 <= max_height) or size <= 24:
            return font, lines
        size = int(size * 0.92)


def add_headline(image: Image.Image, headline: str) -> Image.Image:
    width, height = image.size
    canvas = image.convert("RGBA")
    # A soft dark gradient behind the text keeps it readable on any frame.
    shade = Image.new("L", (1, height))
    for y in range(height):
        shade.putpixel((0, y), int(190 * max(0.0, (y / height - 0.45) / 0.55)))
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    overlay.putalpha(shade.resize((width, height)))
    canvas = Image.alpha_composite(canvas, overlay)

    draw = ImageDraw.Draw(canvas)
    margin = int(width * 0.05)
    font, lines = fit_headline(draw, headline, width - 2 * margin, int(height * 0.42), int(height * 0.16))
    line_height = int(font.size * 1.1)
    stroke = max(2, font.size // 14)
    y = height - margin - line_height * len(lines)
    for line in lines:
        line_width = draw.textlength(line, font=font)
        x = (width - line_width) / 2
        draw.text((x, y), line, font=font, fill=(255, 255, 255), stroke_width=stroke, stroke_fill=(0, 0, 0))
        y += line_height
    return canvas.convert("RGB")


def save_jpeg(image: Image.Image, target: Path, max_bytes: int = MAX_BYTES) -> int:
    """Writes a JPEG without metadata, lowering quality until it fits `max_bytes`. Returns its size."""
    for quality in (92, 88, 84, 78, 72, 65, 55, 45):
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
        if buffer.tell() <= max_bytes:
            break
    data = buffer.getvalue()
    partial = target.with_suffix(".partial.jpg")
    partial.write_bytes(data)
    partial.replace(target)
    return len(data)
