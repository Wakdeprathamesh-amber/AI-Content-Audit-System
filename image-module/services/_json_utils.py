"""
Helpers for robustly parsing LLM JSON responses.

GPT-4o-mini routinely wraps JSON in ```json fences, occasionally adds a chatty
prefix/suffix, and sometimes omits a trailing brace. These helpers centralise
that cleanup so every service handles it the same way.
"""

import json
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"```(?:json)?\s*\n?(.*?)\n?```", re.DOTALL)
_BRACE_RE = re.compile(r"\{.*\}", re.DOTALL)


def strip_code_fences(text: str) -> str:
    """Remove ``` / ```json fences if present. Returns trimmed body."""
    s = (text or "").strip()
    if not s.startswith("```"):
        return s
    m = _FENCE_RE.search(s)
    if m:
        return m.group(1).strip()
    return s.strip("`").strip()


def extract_json_object(text: str) -> Optional[str]:
    """Find the first {...} block in `text`, if any."""
    if not text:
        return None
    m = _BRACE_RE.search(text)
    return m.group(0) if m else None


def parse_llm_json(text: str) -> Optional[Any]:
    """Best-effort JSON parse for an LLM response. Returns None on failure."""
    if not text:
        return None
    cleaned = strip_code_fences(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    inner = extract_json_object(cleaned)
    if inner is None:
        return None
    try:
        return json.loads(inner)
    except json.JSONDecodeError as exc:
        logger.warning("Failed to parse LLM JSON: %s", exc)
        return None
