from media_worker.clips.candidates import (
    Window,
    build_windows,
    load_words,
    padded_bounds,
    pick_final,
    score_windows,
    shortlist,
    split_sentences,
)


def transcript_from(sentences: list[tuple[float, str]], gap_s: float = 0.3, word_s: float = 0.4) -> dict:
    """Builds a transcript where each sentence starts at the given second and words last `word_s`."""
    segments = []
    for start_s, text in sentences:
        words, t = [], start_s
        for token in text.split():
            words.append([round(t * 1000), round((t + word_s) * 1000), token])
            t += word_s + 0.05
        segments.append({"startMs": words[0][0], "endMs": words[-1][1], "text": text, "words": words})
    last_end = segments[-1]["endMs"] if segments else 0
    return {"version": 1, "durationMs": last_end + round(gap_s * 1000) + 2000, "segments": segments,
            "loudness": {"windowMs": 500, "db": [-30.0] * (last_end // 500 + 10)}}  # fmt: skip


TALK = transcript_from([
    (0, "Welcome back to the channel everyone."),
    (4, "Did you know most editing time is spent searching?"),
    (9, "It is true and it surprised me a lot!"),
    (14, "So I started using transcripts for every single video."),
    (20, "Now I find any moment in a few seconds."),
    (26, "That saved me about eleven hours every week."),
    (32, "Here is how you can do the same thing today."),
])  # fmt: skip


def test_words_and_sentences_follow_the_transcript() -> None:
    words = load_words(TALK)
    assert words[0].text == "Welcome" and words[0].start_ms == 0
    sentences = split_sentences(words)
    assert len(sentences) == 7
    assert sentences[1].text.endswith("searching?")


def test_long_pauses_also_end_sentences() -> None:
    words = load_words(transcript_from([(0, "no punctuation here"), (5, "and none here either")]))
    assert [s.text for s in split_sentences(words)] == ["no punctuation here", "and none here either"]


def test_windows_start_and_end_on_sentence_boundaries_within_limits() -> None:
    words = load_words(TALK)
    sentences = split_sentences(words)
    windows = build_windows(words, sentences, 8_000, 20_000)
    starts = {s.start_ms for s in sentences}
    ends = {s.end_ms for s in sentences}
    assert windows
    for w in windows:
        assert w.start_ms in starts and w.end_ms in ends
        assert 8_000 <= w.duration_ms <= 20_000
        assert w.text.startswith(words[w.first_word].text)


def test_padding_never_reaches_into_neighbouring_words() -> None:
    words = load_words(TALK)
    windows = build_windows(words, split_sentences(words), 8_000, 20_000)
    for w in windows:
        start, end = padded_bounds(w, words, TALK["durationMs"])
        assert start <= w.start_ms and end >= w.end_ms
        if w.first_word > 0:
            assert start >= words[w.first_word - 1].end_ms
        if w.last_word + 1 < len(words):
            assert end <= words[w.last_word + 1].start_ms


def test_heuristic_score_is_explainable_and_rewards_questions() -> None:
    def scored(text: str) -> Window:
        transcript = transcript_from([(0, "Intro sentence here."), (3, text), (10, "Outro sentence here.")])
        words = load_words(transcript)
        windows = [w for w in build_windows(words, split_sentences(words), 1_000, 5_000) if w.text == text]
        score_windows(windows, words, transcript)
        return windows[0]

    question = scored("Is editing really that slow for everyone?")
    statement = scored("Is editing really that slow for everyone.")
    assert "asks a question" in question.signals and "asks a question" not in statement.signals
    assert question.heuristic > statement.heuristic
    assert 0 <= statement.heuristic <= 100


def test_shortlist_covers_the_whole_video_and_skips_near_duplicates() -> None:
    windows = [Window(i, 0, 0, i * 10_000, i * 10_000 + 9_000, f"w{i}", heuristic=100 - i) for i in range(10)]
    windows.append(Window(99, 0, 0, 500, 9_400, "dup", heuristic=100))  # overlaps window 0 almost entirely
    picked = shortlist(windows, 4, 100_000)
    assert len(picked) == 4
    assert max(w.start_ms for w in picked) >= 50_000  # something from the second half
    assert not ({0, 99} <= {w.id for w in picked})


def test_final_selection_has_no_overlaps() -> None:
    a = Window(1, 0, 0, 0, 10_000, "a")
    b = Window(2, 0, 0, 5_000, 15_000, "b")
    c = Window(3, 0, 0, 20_000, 30_000, "c")
    chosen = pick_final([(a, 50), (b, 90), (c, 70)], 5)
    assert [w.id for w, _ in chosen] == [2, 3]
