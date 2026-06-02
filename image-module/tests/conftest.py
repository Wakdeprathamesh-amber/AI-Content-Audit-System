"""Shared pytest fixtures.

Tests run from the `image-module/` directory:
    cd image-module && pytest
"""

import os
import sys

# Add `image-module/` to sys.path so `from services.X import Y` works
# regardless of where pytest is invoked from.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Defensive env — don't pick up the user's real .env (live OPENAI key) during tests.
os.environ.setdefault("OPENAI_API_KEY", "")
os.environ.setdefault("API_KEY", "")
os.environ.setdefault("CACHE_ENABLED", "true")
os.environ.setdefault("CACHE_TTL_SECONDS", "60")
os.environ.setdefault("WATERMARK_CONFIDENCE_THRESHOLD", "85")
