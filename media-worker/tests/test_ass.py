from media_worker.shorts.ass import Cue, TextStyle, ass_color, ass_time, build_ass, escape_text

STYLE = TextStyle(
    fontName="Geist Black",
    bold=False,
    fontSize=96,
    textColor="#FFE14D",
    background="outline",
    backgroundColor="#000000",
    backgroundAlpha=0,
    outline=7,
    centerY=1344,
    marginX=90,
)


def test_colors_are_ass_bgr_with_alpha() -> None:
    assert ass_color("#FFE14D") == "&H004DE1FF"
    assert ass_color("#000000", 64) == "&H40000000"


def test_times_use_centiseconds() -> None:
    assert ass_time(0) == "0:00:00.00"
    assert ass_time(1_234) == "0:00:01.23"
    assert ass_time(3_725_010) == "1:02:05.01"


def test_user_text_cannot_inject_override_codes() -> None:
    assert escape_text("{\\b1}bold{\\fs200}") == "\\{\\\u2060b1\\}bold\\{\\\u2060fs200\\}"
    # \N, \n and \h typed by the user stay literal; a real line break becomes \N.
    assert escape_text("C:\\New\nline") == "C:\\\u2060New\\Nline"
    assert escape_text("tab\there  and\x00 control\x1b") == "tab here and control"
    assert escape_text("time 1:30 — ok 😀") == "time 1:30 — ok 😀"
    assert escape_text("  \n  ") == ""


def test_document_has_styles_and_positioned_events() -> None:
    hook_style = STYLE.model_copy(
        update={"background": "box", "backgroundColor": "#FFFFFF", "outline": 19, "centerY": 307}
    )
    document = build_ass(
        [Cue(startMs=0, endMs=1200, text="Hello there"), Cue(startMs=1200, endMs=900, text="ignored: ends first")],
        STYLE,
        hook_text="Watch this",
        hook_end_ms=3000,
        hook_style=hook_style,
    )
    assert "PlayResX: 1080" in document and "PlayResY: 1920" in document
    assert (
        "Style: Caption,Geist Black,96,&H004DE1FF,&H004DE1FF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,7,0,5,90,90,0,1" in document
    )
    assert ",0,0,0,0,100,100,0,0,3,19,0,5," in document  # the hook uses an opaque box (BorderStyle 3)
    assert "Dialogue: 0,0:00:00.00,0:00:01.20,Caption,,0,0,0,,{\\an5\\pos(540,1344)}Hello there" in document
    assert "ignored" not in document
    assert "Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,{\\an5\\pos(540,307)}Watch this" in document


def test_no_background_means_no_outline() -> None:
    document = build_ass([Cue(startMs=0, endMs=500, text="x")], STYLE.model_copy(update={"background": "none"}))
    assert ",1,0,0,5,90,90,0,1" in document
