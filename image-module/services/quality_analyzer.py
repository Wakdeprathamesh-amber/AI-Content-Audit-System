"""
Image Quality Analyzer Service
Analyzes image quality including resolution, blur detection, and sharpness.

Blur method:
  Normalized Laplacian variance. The image is resized to a fixed long-edge
  before computing variance, and the variance is divided by mean luminance.
  Without these steps the same scene at different sizes / exposures produces
  very different "blur scores" and the threshold becomes useless.
"""

import cv2
import numpy as np
import os
from PIL import Image
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)


# Long edge (px) we resize to before computing Laplacian variance.
# Fixed value → scores are comparable across photos of any source resolution.
BLUR_NORMALIZE_LONG_EDGE = 1024


class QualityAnalyzer:
    """Analyzes image quality metrics"""

    def __init__(self):
        """Initialize quality analyzer with configurable thresholds"""
        self.MIN_RESOLUTION_WIDTH = int(os.getenv('MIN_RESOLUTION_WIDTH', '800'))
        self.MIN_RESOLUTION_HEIGHT = int(os.getenv('MIN_RESOLUTION_HEIGHT', '800'))
        self.BLUR_THRESHOLD = float(os.getenv('BLUR_THRESHOLD', '100.0'))
        self.SHARPNESS_THRESHOLD = float(os.getenv('SHARPNESS_THRESHOLD', '50.0'))

        logger.info(
            f"Quality thresholds: resolution={self.MIN_RESOLUTION_WIDTH}x{self.MIN_RESOLUTION_HEIGHT}, "
            f"blur={self.BLUR_THRESHOLD}, sharpness={self.SHARPNESS_THRESHOLD}"
        )

    async def analyze(
        self,
        image: Image.Image,
        file_size_bytes: Optional[int] = None,
        image_format: Optional[str] = None,
    ) -> Dict:
        """
        Analyze image quality.

        Args:
            image: PIL Image (post EXIF-transpose, RGB/RGBA).
            file_size_bytes: Wire size of the downloaded file (from downloader).
            image_format: Wire format string e.g. "JPEG" (from downloader,
                captured before mode conversion).

        Returns:
            Dictionary with quality analysis results.
        """
        try:
            logger.info("Starting quality analysis...")

            width, height = image.size
            megapixels = round((width * height) / 1_000_000, 2)

            resolution = {"width": width, "height": height}

            resolution_passed = (
                width >= self.MIN_RESOLUTION_WIDTH and
                height >= self.MIN_RESOLUTION_HEIGHT
            )

            blur_score = self._detect_blur(image)
            is_blurred = blur_score < self.BLUR_THRESHOLD

            sharpness = self._calculate_sharpness(blur_score)

            passed = resolution_passed and not is_blurred

            result = {
                "resolution": resolution,
                "width": width,
                "height": height,
                "megapixels": megapixels,
                "format": image_format,
                "file_size_bytes": file_size_bytes,
                "blur": round(blur_score, 2),
                "sharpness": round(sharpness, 2),
                "passed": passed,
            }

            logger.info(f"Quality analysis complete: {result}")
            return result

        except Exception as e:
            logger.error(f"Error in quality analysis: {str(e)}")
            raise Exception(f"Quality analysis failed: {str(e)}")

    def _detect_blur(self, image: Image.Image) -> float:
        """
        Detect blur using a NORMALIZED Laplacian-variance method:
          1. Resize to a fixed long-edge so the variance scale is comparable
             across photos of any source resolution.
          2. Convert to grayscale.
          3. Compute Laplacian variance.
          4. Divide by (mean luminance + small epsilon) so dim photos aren't
             unfairly penalised and bright photos aren't unfairly rewarded.
          5. Re-scale so the resulting magnitude is in the same neighbourhood
             as the legacy raw-variance scores (~0–500), keeping existing
             BLUR_THRESHOLD env values meaningful.
        """
        try:
            image_array = np.array(image)

            if len(image_array.shape) == 3:
                gray = cv2.cvtColor(image_array, cv2.COLOR_RGB2GRAY)
            else:
                gray = image_array

            # 1. Resize to fixed long-edge for scale invariance.
            h, w = gray.shape[:2]
            long_edge = max(h, w)
            if long_edge != BLUR_NORMALIZE_LONG_EDGE and long_edge > 0:
                scale = BLUR_NORMALIZE_LONG_EDGE / float(long_edge)
                new_w = max(1, int(round(w * scale)))
                new_h = max(1, int(round(h * scale)))
                # INTER_AREA for downscale, INTER_CUBIC for upscale.
                interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
                gray = cv2.resize(gray, (new_w, new_h), interpolation=interp)

            # 3. Laplacian variance.
            laplacian = cv2.Laplacian(gray, cv2.CV_64F)
            variance = float(laplacian.var())

            # 4. Luminance normalisation. mean luminance ~128 for a well-exposed
            # photo, so multiplying by 128 keeps the magnitude in the legacy band.
            mean_luma = float(gray.mean()) + 1e-3
            normalised = (variance / mean_luma) * 128.0

            return float(normalised)

        except Exception as e:
            logger.error(f"Error detecting blur: {str(e)}")
            # Default to "not blurred" on internal failure — never block a
            # whole audit because one CV call exploded.
            return 200.0

    def _calculate_sharpness(self, blur_score: float) -> float:
        """Map blur score → 0–100 sharpness."""
        max_blur_score = 500.0
        sharpness = min(100.0, (blur_score / max_blur_score) * 100.0)
        return sharpness

    def get_quality_rating(self, sharpness: float, resolution_passed: bool) -> str:
        if not resolution_passed:
            return 'poor'
        if sharpness >= 80:
            return 'excellent'
        elif sharpness >= 60:
            return 'good'
        elif sharpness >= 40:
            return 'fair'
        else:
            return 'poor'
