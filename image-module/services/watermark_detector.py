"""
Watermark Detector Service.

Sends the in-memory image as base64 to OpenAI (URL-fetch removed), and the
confidence threshold is env-driven (WATERMARK_CONFIDENCE_THRESHOLD) so the
docs sheet, README, and runtime cannot drift.
"""

from __future__ import annotations

import logging
import os
from typing import Dict

from openai import AsyncOpenAI
from PIL import Image

from ._json_utils import parse_llm_json
from ._openai_utils import pil_to_data_url

logger = logging.getLogger(__name__)


def _parse_bool(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
    return default


class WatermarkDetector:
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            logger.warning("OPENAI_API_KEY not set. Watermark detection will fail.")
        self.client = AsyncOpenAI(api_key=self.api_key) if self.api_key else None
        self.model = os.getenv("IMAGE_WATERMARK_MODEL", "gpt-4o-mini")
        self.max_tokens = int(os.getenv("IMAGE_WATERMARK_MAX_TOKENS", "300"))
        self.temperature = float(os.getenv("IMAGE_WATERMARK_TEMPERATURE", "0.1"))

        # Single source of truth for the threshold.
        try:
            self.confidence_threshold = float(
                os.getenv("WATERMARK_CONFIDENCE_THRESHOLD", "85")
            )
        except ValueError:
            self.confidence_threshold = 85.0

        # Simple circuit breaker — open on repeated failures so we stop hammering OpenAI.
        self.failure_count = 0
        self.circuit_open = False
        self.max_failures = 5

    async def detect(self, image: Image.Image, image_url: str) -> Dict:
        try:
            if self.circuit_open:
                logger.warning("Circuit breaker is open. Using fallback.")
                return self._fallback_response()

            if not self.client:
                logger.error("OpenAI client not initialized")
                return self._fallback_response()

            logger.info("Detecting watermarks using OpenAI Vision...")

            t = int(self.confidence_threshold)
            prompt = f"""Analyze this property listing image VERY CAREFULLY for watermarks, logos, or text overlays.

⚠️ IMPORTANT: Be CONSERVATIVE. Only flag as a watermark if you are HIGHLY CONFIDENT (>= {t}%).

WHAT IS A WATERMARK (flag as detected=true):
✓ Semi-transparent text/logo overlays (usually in corners, center, or diagonal)
✓ Copyright symbols (©) with photographer/company names OVERLAID on the image
✓ Website URLs or domain names OVERLAID on the image (not on signs)
✓ Photographer credits or studio names OVERLAID on the image
✓ Repeated patterns or logos across the image
✓ "Sample", "Preview", "Demo", "Watermark" text overlays
✓ Real estate agency branding OVERLAID on the image
✓ Stock photo site watermarks (Shutterstock, Getty, etc.)

WHAT IS NOT A WATERMARK (flag as detected=false):
✗ Street signs, building names, or address numbers on buildings
✗ Posters, artwork, or decorative items in the room
✗ Floor plan labels, room dimensions, or architectural text
✗ Legitimate signage (exit signs, room numbers, facility names)
✗ Text on appliances, furniture, or equipment (brands, labels)
✗ Natural reflections or shadows that look like text
✗ Architectural features or design elements
✗ TV screens, computer monitors, or digital displays
✗ Books, magazines, or printed materials in the scene
✗ Decorative text on walls, pillows, or furniture

⚠️ CRITICAL: Only set detected=true if confidence >= {t} AND you can clearly identify it as an OVERLAY.
⚠️ If unsure, set detected=false. False negatives are better than false positives.
⚠️ You MUST provide detailed reasoning explaining what you see.

Respond in JSON format:
{{
  "detected": true/false,
  "confidence": 0-100,
  "text": "watermark text if visible, or null",
  "type": "logo/text/overlay/stock_photo/none",
  "reasoning": "REQUIRED: Detailed explanation of what you see and why it is/isn't a watermark."
}}"""

            data_url = pil_to_data_url(image)
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
                max_tokens=self.max_tokens,
                temperature=self.temperature,
            )

            result_text = response.choices[0].message.content
            logger.info(f"OpenAI response: {result_text}")

            parsed = parse_llm_json(result_text)
            if not isinstance(parsed, dict):
                logger.warning("Watermark: failed to parse JSON, defaulting to not detected")
                self._handle_failure()
                return self._fallback_response()

            detected = _parse_bool(parsed.get("detected", False), default=False)
            try:
                confidence = float(parsed.get("confidence", 0))
            except (TypeError, ValueError):
                confidence = 0.0
            text = parsed.get("text")
            reasoning = parsed.get("reasoning", "") or ""

            # Apply threshold and require non-empty reasoning for a positive.
            if confidence < self.confidence_threshold:
                detected = False
                logger.info(
                    f"Confidence {confidence}% below threshold ({self.confidence_threshold}%), marking as not detected"
                )
            if detected and len(reasoning.strip()) < 10:
                logger.warning("Watermark flagged without reasoning — treating as false positive")
                detected = False
                confidence = 0.0

            self.failure_count = 0

            return {
                "detected": detected,
                "confidence": round(confidence, 2),
                "text": text,
                "reasoning": reasoning,
                "degraded": False,
            }

        except Exception as e:
            logger.error(f"Error detecting watermark: {e}", exc_info=True)
            self._handle_failure()
            return self._fallback_response()

    def _handle_failure(self):
        self.failure_count += 1
        logger.warning(
            f"Watermark detection failure count: {self.failure_count}/{self.max_failures}"
        )
        if self.failure_count >= self.max_failures:
            self.circuit_open = True
            logger.error("Circuit breaker opened due to repeated failures")

    def _fallback_response(self) -> Dict:
        return {
            "detected": False,
            "confidence": 0.0,
            "text": None,
            "reasoning": "API call failed or response could not be parsed",
            "degraded": True,
        }

    def reset_circuit(self):
        self.circuit_open = False
        self.failure_count = 0
        logger.info("Circuit breaker reset")
