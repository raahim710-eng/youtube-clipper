from pathlib import Path

import pytest

from media_worker.storage import UnsafePathError, resolve_storage_path


def test_resolves_inside_root(tmp_path: Path) -> None:
    assert resolve_storage_path("videos/a/source.mp4", tmp_path) == (tmp_path / "videos/a/source.mp4").resolve()


@pytest.mark.parametrize(
    "bad",
    ["", "../x", "videos/../../x", "videos\\..\\..\\x", "/etc/passwd", "C:\\Windows\\win.ini", "C:x", "a\0b"],
)
def test_rejects_paths_outside_root(tmp_path: Path, bad: str) -> None:
    with pytest.raises(UnsafePathError):
        resolve_storage_path(bad, tmp_path)


@pytest.mark.parametrize("dotted", ["shorts/../videos/x", "shorts\\..\\videos\\x"])
def test_rejects_dot_dot_even_inside_root(tmp_path: Path, dotted: str) -> None:
    # Mirrors resolveStoragePath (TypeScript): ".." is refused with either separator, not only when it escapes.
    with pytest.raises(UnsafePathError):
        resolve_storage_path(dotted, tmp_path)
