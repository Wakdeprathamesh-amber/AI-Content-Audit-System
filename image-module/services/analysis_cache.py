"""
In-memory analysis cache for the image module.

Cache key = (image_hash, sorted_checks, existing_tag).

This lives in the image module — not the Node side — so a cache hit can
short-circuit BEFORE we call OpenAI. The old design cached on the Node side
*after* the OpenAI call, which only saved latency and nothing of the token
bill. This one actually saves cost.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Dict, Iterable, Optional, Tuple

logger = logging.getLogger(__name__)

CacheKey = Tuple[str, Tuple[str, ...], Optional[str]]


class AnalysisCache:
    def __init__(self):
        self.enabled = os.getenv("CACHE_ENABLED", "true").lower() not in (
            "false",
            "0",
            "no",
            "off",
        )
        self.ttl_seconds = int(os.getenv("CACHE_TTL_SECONDS", str(30 * 24 * 60 * 60)))
        self.max_entries = int(os.getenv("CACHE_MAX_ENTRIES", "10000"))
        self._store: Dict[CacheKey, Tuple[float, dict]] = {}
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        if self.enabled:
            logger.info(
                "Analysis cache enabled (TTL %ss, max %d entries)",
                self.ttl_seconds,
                self.max_entries,
            )
        else:
            logger.info("Analysis cache DISABLED")

    @staticmethod
    def _key(
        image_hash: Optional[str],
        checks: Iterable[str],
        existing_tag: Optional[str],
    ) -> Optional[CacheKey]:
        if not image_hash:
            return None
        normalised_checks = tuple(sorted({c.strip().lower() for c in checks if c}))
        return (image_hash, normalised_checks, existing_tag or None)

    def get(
        self,
        image_hash: Optional[str],
        checks: Iterable[str],
        existing_tag: Optional[str],
    ) -> Optional[dict]:
        if not self.enabled:
            return None
        key = self._key(image_hash, checks, existing_tag)
        if key is None:
            return None
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None
            stored_at, value = entry
            if (time.time() - stored_at) > self.ttl_seconds:
                self._store.pop(key, None)
                self._misses += 1
                return None
            self._hits += 1
            # Return a copy so callers can't mutate the cached object.
            return dict(value)

    def set(
        self,
        image_hash: Optional[str],
        checks: Iterable[str],
        existing_tag: Optional[str],
        value: dict,
    ) -> None:
        if not self.enabled:
            return
        key = self._key(image_hash, checks, existing_tag)
        if key is None:
            return
        with self._lock:
            if len(self._store) >= self.max_entries:
                # Drop the oldest entry (FIFO eviction is plenty for this workload).
                oldest_key = next(iter(self._store))
                self._store.pop(oldest_key, None)
            self._store[key] = (time.time(), dict(value))

    def stats(self) -> dict:
        with self._lock:
            total = self._hits + self._misses
            return {
                "hits": self._hits,
                "misses": self._misses,
                "hit_rate": (self._hits / total * 100) if total else 0.0,
                "size": len(self._store),
                "enabled": self.enabled,
                "ttl_seconds": self.ttl_seconds,
            }

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self._hits = 0
            self._misses = 0


analysis_cache = AnalysisCache()
