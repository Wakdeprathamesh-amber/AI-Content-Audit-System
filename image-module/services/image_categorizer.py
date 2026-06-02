"""
Image Categorizer Service.

Categorises property images via OpenAI Vision. Two notable behaviours:
  - Image is sent as base64 (not URL) so auth-gated images still work.
  - The existing_tag (from DB) is sanitised before being interpolated into
    the prompt — defends against prompt injection from user-controlled tags.

Categories use the lowercase_underscore form that the `inventories.images[].type`
field already uses in the database (see scripts/inspect-all-image-tags.js).
This is intentional: a strict case-sensitive comparison against the LLM
response used to demote ~every result to "other" when the LLM returned
"Bedroom" instead of "bedroom". Now we normalise on the way in AND validate
case-insensitively.
"""

from __future__ import annotations

import logging
import os
from typing import Dict, Optional

from openai import AsyncOpenAI
from PIL import Image

from ._json_utils import parse_llm_json
from ._openai_utils import pil_to_data_url, sanitise_tag

logger = logging.getLogger(__name__)


def normalize_tag(tag: Optional[str]) -> Optional[str]:
    """Canonicalise a tag string to lowercase_underscore form.

    Handles: 'Bedroom', 'BEDROOM', ' bedroom ', 'floor plan', 'Floor-Plan' …
    Returns None for null/empty input.
    """
    if tag is None:
        return None
    s = str(tag).strip()
    if not s:
        return None
    return s.lower().replace('-', '_').replace(' ', '_')


def parse_optional_bool(value) -> Optional[bool]:
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
    return None


class ImageCategorizer:
    # Canonical tags. MUST stay in sync with inventories.images[].type values
    # (confirmed by scripts/inspect-all-image-tags.js across 134k images).
    # Closed list for model output. Legacy DB tag "room" is folded into bedroom.
    CATEGORIES = [
        "bedroom",
        "kitchen",
        "bathroom",
        "common_area",
        "amenities",
        "floor_plan",
        "exterior",
        "other",  # fallback only — not stored upstream
    ]

    SLEEPING_TAGS = frozenset({"bedroom", "room"})

    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            logger.warning("OPENAI_API_KEY not set. Categorization will fail.")
        self.client = AsyncOpenAI(api_key=self.api_key) if self.api_key else None
        self.model = os.getenv("IMAGE_CATEGORY_MODEL", "gpt-4o-mini")
        self.max_tokens = int(os.getenv("IMAGE_CATEGORY_MAX_TOKENS", "300"))
        self.temperature = float(os.getenv("IMAGE_CATEGORY_TEMPERATURE", "0.1"))

    async def categorize(
        self,
        image: Image.Image,
        image_url: str,  # kept for logging only
        existing_tag: Optional[str] = None,
    ) -> Dict:
        try:
            if not self.client:
                logger.error("OpenAI client not initialized")
                return self._fallback_response(existing_tag)

            logger.info("Categorizing image using OpenAI Vision...")

            categories_list = ", ".join(self.CATEGORIES)
            # Sanitise THEN normalise: defence in depth.
            safe_tag = sanitise_tag(existing_tag) if existing_tag else None
            normalised_existing = normalize_tag(safe_tag)
            existing_tag_prompt = ""
            if normalised_existing:
                legacy_note = ""
                if normalised_existing == "room":
                    legacy_note = (
                        ' Note: upstream tag "room" is legacy — the correct tag is "bedroom" '
                        "for any sleeping space with a bed."
                    )
                existing_tag_prompt = f"""

EXISTING TAG VALIDATION:
The image currently has the tag: "{normalised_existing}"{legacy_note}
Please evaluate if this tag is correct or if it should be changed.
Include in your response:
- is_correct: true/false (is the existing tag accurate?)
- suggested_correction: "new category" (if existing tag is wrong)
"""

            prompt = f"""Categorize this property image into one of these categories (use the exact lowercase_underscore form):
{categories_list}

Guidelines:
- bedroom: ANY interior photo where a bed is the main subject — studio, ensuite, PBSA private room, apartment bedroom, shared-flat sleeping room. Always use "bedroom" for lettable sleeping spaces (never use a separate "room" tag).
- kitchen: Cooking areas with appliances, counters, cabinets (including kitchenettes)
- bathroom: Toilets, sinks, showers, bathtubs, ensuite wash areas
- common_area: INDOOR shared/living space: lounge, dining, hallway, study desk area, internal corridor — NOT gym/pool/lobby facilities
- amenities: Dedicated facility spaces: gym, pool, laundry, cinema, game room, parking, study hub — NOT a flat's living room
- floor_plan: Architectural floor plans, layouts, blueprints only
- exterior: OUTDOOR or shot from outside: building façade, entrance, courtyard, terrace with sky/outdoor context — NOT indoor lobby or indoor pool
- other: ONLY when none of the above fit{existing_tag_prompt}

If the image could fit multiple categories, provide alternatives.

Respond in JSON format:
{{
  "primary": "category name (lowercase_underscore)",
  "confidence": 0-100,
  "alternatives": ["alternative1", "alternative2"],
  "reasoning": "brief explanation",
  "is_correct": true/false (only if existing tag provided),
  "suggested_correction": "new category" (only if existing tag is wrong)
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
                logger.warning("Categorizer: could not parse JSON — using safe fallback")
                return self._fallback_response(existing_tag)

            # Normalise BEFORE validation. If the LLM gave us "Bedroom" we
            # accept it as "bedroom"; we no longer punish case mismatches.
            primary_raw = parsed.get("primary", "other")
            primary = normalize_tag(primary_raw) or "other"
            if primary == "room":
                primary = "bedroom"
            try:
                confidence = float(parsed.get("confidence", 0))
            except (TypeError, ValueError):
                confidence = 0.0
            alternatives_raw = parsed.get("alternatives") or None
            alternatives = (
                [normalize_tag(a) for a in alternatives_raw if normalize_tag(a)]
                if alternatives_raw
                else None
            )
            suggested_correction = normalize_tag(parsed.get("suggested_correction"))
            is_correct = parse_optional_bool(parsed.get("is_correct"))
            reasoning = parsed.get("reasoning", "")

            if primary not in self.CATEGORIES:
                logger.warning(f"Invalid category '{primary_raw}' (normalised: '{primary}'), defaulting to 'other'")
                primary = "other"
                confidence = min(confidence, 50.0)

            if normalised_existing in self.SLEEPING_TAGS and primary == "bedroom":
                is_correct = True
                suggested_correction = None

            return {
                "primary": primary,
                "confidence": round(confidence, 2),
                "alternatives": alternatives,
                "existing_tag": normalised_existing,
                "is_tag_correct": is_correct,
                "suggested_correction": suggested_correction,
                "reasoning": reasoning,
                "degraded": False,
            }

        except Exception as e:
            logger.error(f"Error categorizing image: {e}", exc_info=True)
            return self._fallback_response(existing_tag)

    def _fallback_response(self, existing_tag: Optional[str] = None) -> Dict:
        """Return a safe fallback.

        Confidence is intentionally 0 — below the category gate — so the
        engine flags it as "low confidence" rather than silently passing.
        """
        return {
            "primary": "other",
            "confidence": 0.0,
            "alternatives": None,
            "existing_tag": normalize_tag(existing_tag),
            "is_tag_correct": None,
            "suggested_correction": None,
            "reasoning": "Fallback: categorization failed or response could not be parsed",
            "degraded": True,
        }
