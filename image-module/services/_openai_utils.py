"""
Shared helpers for OpenAI Vision calls.

  - pil_to_data_url: encode an in-memory PIL image as a base64 data: URL so
    OpenAI doesn't have to re-fetch the URL (works for auth-gated / private
    image sources and avoids paying OpenAI to re-download what we already have).
  - sanitise_tag: scrub user-controlled tag strings before prompt interpolation.
"""

from __future__ import annotations

import base64
import io
import logging
import re
from typing import Optional

from PIL import Image

logger = logging.getLogger(__name__)

# OpenAI's chat-completion vision API has a per-image size cap. Keep payloads
# small by re-encoding to JPEG and downscaling the long edge to 2048 px.
_MAX_EDGE = 2048
_JPEG_QUALITY = 85


def pil_to_data_url(image: Image.Image, max_edge: int = _MAX_EDGE) -> str:
    """Encode a PIL image as a base64 data: URL suitable for OpenAI vision."""
    img = image.copy()

    # Ensure RGB for JPEG.
    if img.mode not in ("RGB",):
        img = img.convert("RGB")

    # Downscale if needed (preserves aspect ratio).
    w, h = img.size
    long_edge = max(w, h)
    if long_edge > max_edge:
        scale = max_edge / float(long_edge)
        img = img.resize((int(w * scale), int(h * scale)))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


_TAG_SAFE_RE = re.compile(r"[^A-Za-z0-9 _\-]")


def sanitise_tag(tag: Optional[str], max_len: int = 64) -> Optional[str]:
    """Return a prompt-safe version of `tag`.

    - Strips control chars, quotes, newlines, backticks — common prompt-injection
      payloads.
    - Caps to `max_len`.
    - Returns None on empty input.
    """
    if tag is None:
        return None
    cleaned = _TAG_SAFE_RE.sub("", str(tag)).strip()
    cleaned = cleaned[:max_len]
    return cleaned or None
