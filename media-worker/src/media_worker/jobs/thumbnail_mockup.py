"""media.thumbnail_mockup — make a thumbnail image (PKG-06): a video frame, a frame with a headline
(mock-up), or the creator's uploaded image re-encoded. Output: JPEG under 2 MB, metadata removed.

Result fields match `mediaThumbnailResultSchema` in src/server/jobs/media-thumbnail.ts.
"""

import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field, model_validator

from media_worker import ffmpeg
from media_worker.errors import JobError
from media_worker.job_context import JobContext
from media_worker.packaging.checks import clean_headline
from media_worker.packaging.thumbnail import add_headline, cover, save_jpeg
from media_worker.storage import resolve_storage_path

MAX_UPLOAD_PIXELS = 50_000_000


class ThumbnailPayload(BaseModel):
    thumbnailId: str = Field(min_length=1)
    mode: Literal["frame", "mockup", "upload"]
    sourcePath: str = Field(min_length=1)
    outputPath: str = Field(min_length=1)
    frameMs: int | None = Field(default=None, ge=0)
    headline: str | None = Field(default=None, max_length=120)
    width: int = Field(ge=320, le=1920)
    height: int = Field(ge=320, le=1920)

    @model_validator(mode="after")
    def _check(self) -> "ThumbnailPayload":
        if PurePosixPath(self.outputPath) != PurePosixPath(f"thumbnails/{self.thumbnailId}.jpg"):
            raise ValueError("outputPath must be thumbnails/{thumbnailId}.jpg")
        if self.mode != "upload" and self.frameMs is None:
            raise ValueError("frameMs is required for frames and mock-ups")
        return self


def _frame(payload: ThumbnailPayload, ctx: JobContext, source: Path) -> Image.Image:
    ffmpeg_bin = ffmpeg.require_binary("ffmpeg", ctx.settings.ffmpeg_path)
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "frame.jpg"
        at = (payload.frameMs or 0) / 1000
        if not ffmpeg.extract_frame(ffmpeg_bin, source, target, at, max_width=3840):
            raise JobError("FRAME_FAILED", "No picture could be taken from the video at that time.", retryable=False)
        with Image.open(target) as image:
            image.load()
            return image.copy()


def _upload(source: Path) -> Image.Image:
    try:
        with Image.open(source) as image:
            if image.format not in ("JPEG", "PNG"):
                raise JobError("UNSUPPORTED_IMAGE", "Only JPEG and PNG images can be used.", retryable=False)
            if image.width * image.height > MAX_UPLOAD_PIXELS:
                raise JobError("UNSUPPORTED_IMAGE", "That image is too large (over 50 megapixels).", retryable=False)
            image.load()  # fully decodes: damaged files fail here
            if image.mode in ("RGBA", "LA", "P"):
                background = Image.new("RGB", image.size, (0, 0, 0))
                rgba = image.convert("RGBA")
                background.paste(rgba, mask=rgba.getchannel("A"))
                return background
            return image.convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise JobError("UNSUPPORTED_IMAGE", "That file isn't a readable JPEG or PNG image.", retryable=False) from error


def run(raw_payload: Any, ctx: JobContext) -> dict[str, Any]:
    payload = ThumbnailPayload.model_validate(raw_payload)
    root = ctx.settings.storage_root
    source = resolve_storage_path(payload.sourcePath, root)
    output = resolve_storage_path(payload.outputPath, root)
    if not source.is_file():
        raise JobError("SOURCE_MISSING", "The source file is missing.", retryable=False)
    output.parent.mkdir(parents=True, exist_ok=True)

    ctx.progress(10, "Taking the picture" if payload.mode != "upload" else "Checking the image")
    image = _upload(source) if payload.mode == "upload" else _frame(payload, ctx, source)
    image = cover(image, payload.width, payload.height)
    headline = clean_headline(payload.headline or "") if payload.mode == "mockup" else ""
    if headline:
        ctx.progress(60, "Adding the headline")
        image = add_headline(image, headline)
    size = save_jpeg(image, output)
    if payload.mode == "upload":
        source.unlink(missing_ok=True)  # the original upload isn't kept
    return {
        "outputPath": payload.outputPath,
        "width": payload.width,
        "height": payload.height,
        "sizeBytes": size,
        "headline": headline or None,
    }
