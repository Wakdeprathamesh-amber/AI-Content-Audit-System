"""
AI Content Audit System - Image Audit Module
FastAPI service for image quality analysis, watermark detection, and categorization.
"""

import logging
import os
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Deque, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, HttpUrl

# Load environment exactly once from repo root.
REPO_ROOT_ENV = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(dotenv_path=REPO_ROOT_ENV, override=False)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---- Config ----
def _csv(name: str, default: List[str]) -> List[str]:
    raw = os.getenv(name)
    if not raw:
        return default
    return [s.strip() for s in raw.split(",") if s.strip()]


CORS_ALLOWED_ORIGINS = _csv("CORS_ALLOWED_ORIGINS", ["http://localhost:3000"])
API_KEY = os.getenv("API_KEY", "")
RATE_LIMIT_WINDOW_MS = int(os.getenv("RATE_LIMIT_WINDOW_MS", "60000"))
RATE_LIMIT_MAX = int(os.getenv("RATE_LIMIT_MAX", "60"))
NODE_ENV = os.getenv("NODE_ENV", "development")
VALID_CHECKS = {"quality", "watermark", "category"}

_quality_analyzer = None
_watermark_detector = None
_categorizer = None

app = FastAPI(
    title="AI Content Audit - Image Module",
    description="Image quality analysis, watermark detection, and categorization service",
    version="1.0.0",
)

# CORS — explicit allowlist, never `*` in prod.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "x-api-key"],
)


# ---- Auth dependency ----
_warned_no_api_key = False


async def require_api_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """API-key check using constant-time compare.

    If API_KEY is empty, auth is disabled and we warn (instead of failing closed)
    so a fresh deploy works out of the box. This module has a public URL and makes
    paid OpenAI calls, so setting API_KEY in production is strongly recommended.
    """
    global _warned_no_api_key
    if not API_KEY:
        if NODE_ENV == "production" and not _warned_no_api_key:
            _warned_no_api_key = True
            logger.warning(
                "API_KEY is not set — /api/v1 is UNAUTHENTICATED. Set API_KEY "
                "(same value as the API service) to require x-api-key."
            )
        return
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Missing or invalid x-api-key header")


# ---- Rate limiter (per-IP, fixed window in a deque) ----
_rate_buckets: Dict[str, Deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # Only rate-limit the analyze endpoint; health/root stay cheap and uncapped.
    if request.url.path.startswith("/api/"):
        now_ms = time.time() * 1000
        window_start = now_ms - RATE_LIMIT_WINDOW_MS
        ip = _client_ip(request)
        bucket = _rate_buckets[ip]
        while bucket and bucket[0] < window_start:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_MAX:
            retry_after_sec = max(1, int((bucket[0] + RATE_LIMIT_WINDOW_MS - now_ms) / 1000) + 1)
            return JSONResponse(
                status_code=429,
                content={
                    "error": "Too Many Requests",
                    "message": f"Rate limit exceeded. Try again in {retry_after_sec}s.",
                },
                headers={"Retry-After": str(retry_after_sec)},
            )
        bucket.append(now_ms)
    return await call_next(request)


# ---- Models ----
class ImageAnalysisRequest(BaseModel):
    image_url: HttpUrl
    checks: List[str] = ["quality", "watermark", "category"]
    image_id: Optional[str] = None
    existing_tag: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "image_url": "https://example.com/image.jpg",
                "checks": ["quality", "watermark", "category"],
                "image_id": "12430-img-0",
                "existing_tag": "Bedroom",
            }
        }


class ResolutionResult(BaseModel):
    width: int
    height: int


class QualityResult(BaseModel):
    resolution: ResolutionResult
    width: int
    height: int
    megapixels: float
    format: Optional[str] = None  # wire format e.g. "JPEG", "PNG", "WEBP"
    file_size_bytes: Optional[int] = None
    blur: float
    sharpness: float
    passed: bool


class WatermarkResult(BaseModel):
    detected: bool
    confidence: float
    text: Optional[str] = None
    reasoning: Optional[str] = None


class CategoryResult(BaseModel):
    primary: str
    confidence: float
    alternatives: Optional[List[str]] = None
    existing_tag: Optional[str] = None
    is_tag_correct: Optional[bool] = None
    suggested_correction: Optional[str] = None
    reasoning: Optional[str] = None


class ImageAnalysisResponse(BaseModel):
    image_url: str
    image_hash: Optional[str] = None
    quality: Optional[QualityResult] = None
    watermark: Optional[WatermarkResult] = None
    category: Optional[CategoryResult] = None
    processing_time_ms: float
    cache_hit: bool = False


class HealthResponse(BaseModel):
    status: str
    version: str
    openai_configured: bool


# ---- Routes ----
@app.get("/")
async def root():
    return {
        "service": "AI Content Audit - Image Module",
        "version": "1.0.0",
        "status": "running",
    }


@app.get("/health", response_model=HealthResponse)
async def health_check():
    openai_key = os.getenv("OPENAI_API_KEY")
    return HealthResponse(
        status="healthy",
        version="1.0.0",
        openai_configured=bool(openai_key and len(openai_key) > 0),
    )


@app.post(
    "/api/v1/image/analyze",
    response_model=ImageAnalysisResponse,
    dependencies=[Depends(require_api_key)],
)
async def analyze_image(request: ImageAnalysisRequest):
    """Analyze an image for quality, watermarks, and category.

    Flow:
      1. Download image and compute perceptual hash.
      2. Check the analysis cache (hash + checks). On hit, return immediately —
         saves the OpenAI bill, not just latency.
      3. On miss, run requested checks and cache.
    """
    start_time = time.time()

    try:
        logger.info(f"Analyzing image: {request.image_url}")
        logger.info(f"Checks requested: {request.checks}")
        checks = [str(c).strip().lower() for c in request.checks if str(c).strip()]
        if not checks:
            raise HTTPException(status_code=400, detail="checks must include at least one value")
        invalid_checks = [c for c in checks if c not in VALID_CHECKS]
        if invalid_checks:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid checks: {', '.join(invalid_checks)}. Valid checks are: quality, watermark, category",
            )

        # Lazy imports to keep startup snappy.
        from services.analysis_cache import analysis_cache
        from services.image_categorizer import ImageCategorizer
        from services.image_downloader import ImageDownloader
        from services.quality_analyzer import QualityAnalyzer
        from services.watermark_detector import WatermarkDetector

        downloader = ImageDownloader()

        image, image_hash, image_meta = await downloader.download_image(
            str(request.image_url)
        )

        # Cache lookup BEFORE running any OpenAI call.
        cached = analysis_cache.get(image_hash, checks, request.existing_tag)
        if cached is not None:
            cached["image_url"] = str(request.image_url)
            cached["image_hash"] = image_hash
            cached["cache_hit"] = True
            cached["processing_time_ms"] = round((time.time() - start_time) * 1000, 2)
            logger.info(f"Cache HIT for {image_hash}; OpenAI calls skipped")
            return cached

        global _quality_analyzer
        global _watermark_detector
        global _categorizer
        if _quality_analyzer is None:
            _quality_analyzer = QualityAnalyzer()
        if _watermark_detector is None:
            _watermark_detector = WatermarkDetector()
        if _categorizer is None:
            _categorizer = ImageCategorizer()

        response = ImageAnalysisResponse(
            image_url=str(request.image_url),
            image_hash=image_hash,
            processing_time_ms=0.0,
        )

        if "quality" in checks:
            logger.info("Running quality analysis...")
            response.quality = await _quality_analyzer.analyze(
                image,
                file_size_bytes=image_meta.get("file_size_bytes"),
                image_format=image_meta.get("format"),
            )

        if "watermark" in checks:
            logger.info("Running watermark detection...")
            response.watermark = await _watermark_detector.detect(image, str(request.image_url))

        if "category" in checks:
            logger.info("Running categorization...")
            response.category = await _categorizer.categorize(
                image,
                str(request.image_url),
                existing_tag=request.existing_tag,
            )

        response.processing_time_ms = round((time.time() - start_time) * 1000, 2)

        analysis_cache.set(image_hash, checks, request.existing_tag, response.model_dump())

        logger.info(f"Analysis complete in {response.processing_time_ms}ms")
        return response

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error analyzing image: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to analyze image: {e}")


# ---- Exception handlers (return proper JSONResponse) ----
@app.exception_handler(HTTPException)
async def http_exception_handler(_request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "status_code": exc.status_code},
    )


@app.exception_handler(Exception)
async def general_exception_handler(_request, exc):
    logger.error(f"Unexpected error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc), "status_code": 500},
    )


if __name__ == "__main__":
    import uvicorn

    # Render injects PORT; local/dev can keep using IMAGE_MODULE_PORT.
    port = int(os.getenv("PORT", os.getenv("IMAGE_MODULE_PORT", "8000")))
    logger.info(f"Starting Image Audit Module on port {port}")
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True, log_level="info")
