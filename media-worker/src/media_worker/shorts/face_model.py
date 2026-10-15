"""YuNet face detector (OpenCV Zoo, MIT licence). The model file is downloaded once and verified by hash."""

import hashlib
import os
from pathlib import Path
from typing import Protocol

import httpx
import numpy as np

from media_worker.errors import JobError
from media_worker.shorts.tracking import Face

YUNET_FILE = "face_detection_yunet_2023mar.onnx"
YUNET_URL = f"https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/{YUNET_FILE}"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
SCORE_THRESHOLD = 0.6


class FaceDetector(Protocol):
    def detect(self, frame_bgr: np.ndarray) -> list[Face]: ...


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def model_path(models_dir: Path) -> Path:
    return models_dir / YUNET_FILE


def ensure_model(models_dir: Path, *, transport: httpx.BaseTransport | None = None) -> Path:
    """Returns the verified model file, downloading it first if needed."""
    target = model_path(models_dir)
    if target.is_file() and _sha256(target) == YUNET_SHA256:
        return target
    models_dir.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".partial")
    try:
        with httpx.Client(follow_redirects=True, timeout=60, transport=transport) as client:
            response = client.get(YUNET_URL)
            response.raise_for_status()
            partial.write_bytes(response.content)
    except httpx.HTTPError as error:
        partial.unlink(missing_ok=True)
        raise JobError(
            "FACE_MODEL_DOWNLOAD_FAILED",
            "The face detection model (about 230 KB) couldn't be downloaded. Check the internet connection and "
            f"try again, or place {YUNET_FILE} from the OpenCV Zoo in {models_dir}. "
            "Centre, Blur and Manual framing work without it.",
            retryable=True,
        ) from error
    if _sha256(partial) != YUNET_SHA256:
        partial.unlink(missing_ok=True)
        raise JobError(
            "FACE_MODEL_INVALID",
            "The downloaded face detection model didn't match the expected file, so it wasn't used. "
            "Choose Centre, Blur or Manual framing instead.",
            retryable=False,
        )
    os.replace(partial, target)
    return target


class YuNetDetector:
    def __init__(self, model_file: Path, width: int, height: int, score_threshold: float = SCORE_THRESHOLD):
        import cv2

        # Errors only: OpenCV 5 warns about DNN targets on every model load.
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
        self._width, self._height = width, height
        self._detector = cv2.FaceDetectorYN.create(str(model_file), "", (width, height), score_threshold, 0.3, 50)

    def detect(self, frame_bgr: np.ndarray) -> list[Face]:
        _, faces = self._detector.detect(frame_bgr)
        if faces is None:
            return []
        return [
            Face(
                cx=float((row[0] + row[2] / 2) / self._width),
                cy=float((row[1] + row[3] / 2) / self._height),
                w=float(row[2] / self._width),
                h=float(row[3] / self._height),
                score=float(row[-1]),
            )
            for row in faces
        ]
