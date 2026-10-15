import re
from pathlib import Path, PurePosixPath, PureWindowsPath


class UnsafePathError(ValueError):
    pass


_DRIVE = re.compile(r"^[a-zA-Z]:")


def resolve_storage_path(relative: str, root: Path) -> Path:
    """Mirror of resolveStoragePath in src/server/storage.ts: the only way to turn a stored
    relative path into a real path. Rejects anything that could leave the storage root."""
    if (
        not relative
        or "\0" in relative
        or PurePosixPath(relative).is_absolute()
        or PureWindowsPath(relative).is_absolute()
        or _DRIVE.match(relative)
        or ".." in re.split(r"[\\/]", relative)
    ):
        raise UnsafePathError(f"Refusing to access a path outside storage: {relative!r}")

    root = root.resolve()
    resolved = (root / relative).resolve()
    if resolved != root and root not in resolved.parents:
        raise UnsafePathError(f"Refusing to access a path outside storage: {relative!r}")
    return resolved
