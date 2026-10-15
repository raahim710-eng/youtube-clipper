"""Builds the .ass subtitle file that FFmpeg (libass) burns into a Short.

Every number here (font size, outline, position) is computed by the app (src/lib/shorts/caption-style.ts)
and used for the editor preview too, so preview and export agree (SHORT-06). This module only formats it
and makes user text safe: ASS treats `{…}` as override codes and `\\N`/`\\n`/`\\h` as escapes.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field

PLAY_RES_X = 1080
PLAY_RES_Y = 1920
FONT_NAMES = ("Geist", "Geist Black", "Geist Mono")

HexColor = Field(pattern=r"^#[0-9A-Fa-f]{6}$")


class TextStyle(BaseModel):
    fontName: Literal["Geist", "Geist Black", "Geist Mono"]
    bold: bool
    fontSize: int = Field(ge=20, le=240)
    textColor: str = HexColor
    background: Literal["none", "outline", "box"]
    backgroundColor: str = HexColor
    # ASS alpha: 0 = opaque, 255 = invisible.
    backgroundAlpha: int = Field(ge=0, le=255)
    outline: int = Field(ge=0, le=80)
    centerY: int = Field(ge=0, le=PLAY_RES_Y)
    marginX: int = Field(ge=0, le=400)


class Cue(BaseModel):
    """Times are relative to the start of the Short."""

    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)
    text: str = Field(max_length=400)


def ass_color(hex_color: str, alpha: int = 0) -> str:
    red, green, blue = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H{alpha:02X}{blue}{green}{red}".upper()


def ass_time(ms: int) -> str:
    centis = max(0, round(ms / 10))
    hours, rest = divmod(centis, 360_000)
    minutes, rest = divmod(rest, 6_000)
    seconds, centis = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_WORD_JOINER = "⁠"


def escape_text(text: str) -> str:
    """Turns user text into literal ASS dialogue text (no override codes can be injected)."""
    text = _CONTROL.sub("", text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    # A backslash followed by N, n, h, { or } is special; an invisible word joiner keeps it literal.
    text = text.replace("\\", "\\" + _WORD_JOINER)
    text = text.replace("{", "\\{").replace("}", "\\}")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    return "\\N".join(line for line in lines if line)


def _style_line(name: str, style: TextStyle) -> str:
    border_style = 3 if style.background == "box" else 1
    outline = 0 if style.background == "none" else style.outline
    back = ass_color(style.backgroundColor, style.backgroundAlpha)
    fields = [
        name,
        style.fontName,
        str(style.fontSize),
        ass_color(style.textColor),  # PrimaryColour
        ass_color(style.textColor),  # SecondaryColour
        back,  # OutlineColour: outline colour, or the box colour when BorderStyle=3
        back,  # BackColour (shadow; unused with Shadow=0)
        "-1" if style.bold else "0",
        "0",
        "0",
        "0",
        "100",
        "100",
        "0",
        "0",
        str(border_style),
        str(outline),
        "0",  # Shadow
        "5",  # Alignment: centre/middle (positioned with \pos)
        str(style.marginX),
        str(style.marginX),
        "0",
        "1",
    ]
    return "Style: " + ",".join(fields)


def build_ass(
    cues: list[Cue],
    style: TextStyle | None,
    *,
    hook_text: str | None = None,
    hook_end_ms: int = 0,
    hook_style: TextStyle | None = None,
    play_res: tuple[int, int] = (PLAY_RES_X, PLAY_RES_Y),
) -> str:
    """Returns the whole .ass document (UTF-8 text). `play_res` is the video size the numbers refer to."""
    width, height = play_res
    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: None",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
    ]
    if style:
        header.append(_style_line("Caption", style))
    if hook_style:
        header.append(_style_line("Hook", hook_style))
    events = ["", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    if style:
        for cue in cues:
            text = escape_text(cue.text)
            if not text or cue.endMs <= cue.startMs:
                continue
            events.append(
                f"Dialogue: 0,{ass_time(cue.startMs)},{ass_time(cue.endMs)},Caption,,0,0,0,,"
                f"{{\\an5\\pos({width // 2},{style.centerY})}}{text}"
            )
    if hook_style and hook_text and hook_end_ms > 0:
        text = escape_text(hook_text)
        if text:
            events.append(
                f"Dialogue: 1,{ass_time(0)},{ass_time(hook_end_ms)},Hook,,0,0,0,,"
                f"{{\\an5\\pos({width // 2},{hook_style.centerY})}}{text}"
            )
    return "\n".join(header + events) + "\n"
