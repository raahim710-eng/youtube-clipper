from media_worker.shorts.framing import Keyframe, center_expression, crop_box, crop_x
from media_worker.shorts.tracking import (
    Face,
    Sample,
    build_path,
    detect_cuts,
    simplify,
    smooth,
    subject_path,
)


def face(cx: float, size: float = 0.2, score: float = 0.9) -> Face:
    return Face(cx=cx, cy=0.4, w=size, h=size * 1.3, score=score)


def test_crop_box_for_common_shapes() -> None:
    assert crop_box(1920, 1080).__dict__ == {"width": 606, "height": 1080, "y": 0, "horizontal": True}
    assert crop_box(1080, 1920).__dict__ == {"width": 1080, "height": 1920, "y": 0, "horizontal": False}
    square = crop_box(1080, 1080)
    assert square.horizontal and square.width == 606
    tall = crop_box(1000, 3000)  # narrower than 9:16: crop the height, centred
    assert (tall.width, tall.height, tall.y, tall.horizontal) == (1000, 1776, 612, False)


def test_crop_position_stays_inside_the_frame() -> None:
    assert crop_x(0.0, 1920, 606) == 0
    assert crop_x(1.0, 1920, 606) == 1920 - 606
    assert crop_x(0.5, 1920, 606) == 657


def test_center_expression_is_piecewise_linear_with_jumps() -> None:
    assert center_expression([]) == "0.5"
    assert center_expression([Keyframe(0, 0.3)]) == "0.3"
    expr = center_expression([Keyframe(0, 0.3), Keyframe(2, 0.3), Keyframe(2, 0.7), Keyframe(4, 0.6)])
    # before the first keyframe, then 0.3 until 2 s, a jump to 0.7, then easing to 0.6 by 4 s
    assert expr.startswith("if(lt(t,0),0.3,if(lt(t,2),0.3+(0)*(t-0)/2,if(lt(t,4),0.7+(-0.1)*(t-2)/2,0.6)))")


def test_cuts_need_a_big_change_and_a_minimum_shot_length() -> None:
    times = [i * 100 for i in range(40)]
    scores = [0.0] * 40
    scores[5] = 80.0  # cut at 0.5 s
    scores[8] = 90.0  # too soon after the previous cut (< 1 s): ignored
    scores[20] = 12.0  # ordinary motion: ignored
    scores[30] = 45.0  # cut at 3.0 s
    assert detect_cuts(scores, times) == [500, 3000]


def test_main_face_is_the_biggest_consistent_one() -> None:
    samples = [Sample(t_ms=i * 200, faces=[face(0.3, 0.25), face(0.75, 0.08)]) for i in range(10)]
    samples[4].faces = [face(0.75, 0.08)]  # main face missed once: filled in from its neighbours
    path = subject_path(samples)
    assert path is not None
    assert all(abs(x - 0.3) < 1e-6 for x in path)
    assert subject_path([Sample(t_ms=0, faces=[])]) is None


def test_smoothing_keeps_small_wobble_still_and_removes_glitches() -> None:
    assert len(set(smooth([0.50, 0.51, 0.49, 0.505, 0.5, 0.495]))) == 1
    glitchy = [0.3] * 5 + [0.9] + [0.3] * 5
    assert max(smooth(glitchy)) < 0.35


def test_simplify_keeps_corners_only() -> None:
    line = [(i * 100, 0.2 + i * 0.01) for i in range(50)]
    assert simplify(line, 0.004) == [line[0], line[-1]]
    corner = [(i * 100, 0.2) for i in range(10)] + [(1000 + i * 100, 0.2 + i * 0.05) for i in range(10)]
    assert len(simplify(corner, 0.004)) == 3
    long = [(i, 0.5 + (i % 2) * 0.1) for i in range(5000)]  # no recursion limit on long inputs
    assert len(simplify(long, 0.004)) == 5000


def test_path_follows_a_moving_face_and_jumps_at_cuts() -> None:
    samples = [Sample(t_ms=i * 200, faces=[face(0.2 + 0.02 * i)]) for i in range(25)]  # 0–4.8 s, moving right
    samples += [Sample(t_ms=5000 + i * 200, faces=[face(0.8)]) for i in range(10)]  # new shot at 5 s
    path = build_path(samples, [5000], crop_fraction=606 / 1920, end_ms=7000)
    keyframes = path.keyframes
    assert path.shots == 2 and path.shots_with_face == 2
    first_shot = [x for t, x in keyframes if t < 5000]
    assert first_shot == sorted(first_shot) and first_shot[-1] - first_shot[0] > 0.3
    assert [x for t, x in keyframes if t == 5000] == [0.8]
    assert any(t == 4999 for t, _ in keyframes), "the crop jumps at the cut instead of sliding"
    assert all(606 / 1920 / 2 - 1e-6 <= x <= 1 - 606 / 1920 / 2 + 1e-6 for _, x in keyframes)


def test_shots_without_faces_are_centred() -> None:
    samples = [Sample(t_ms=i * 200, faces=[]) for i in range(10)]
    path = build_path(samples, [], crop_fraction=0.32, end_ms=2000)
    assert path.face_samples == 0 and path.shots_with_face == 0
    assert {x for _, x in path.keyframes} == {0.5}
