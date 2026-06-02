"""
Image Downloader Service
Downloads images from URLs with caching and error handling
"""

import httpx
import io
from PIL import Image, ImageOps
from functools import lru_cache
from typing import Optional, Tuple, TypedDict
import logging
import hashlib
import imagehash


class ImageMetadata(TypedDict):
    """File-level facts about the downloaded image. Captured BEFORE any
    PIL mode conversion so `format` reflects the wire format, not RGB."""
    file_size_bytes: int
    format: Optional[str]  # 'JPEG', 'PNG', 'WEBP', 'AVIF', 'GIF', etc.

# Registers AVIF support on Pillow (side-effect import).
try:
    import pillow_avif  # noqa: F401
except Exception:  # pragma: no cover — optional dep, but listed in requirements
    pass

logger = logging.getLogger(__name__)

class ImageDownloader:
    """Downloads and caches images from URLs"""
    
    def __init__(self, timeout: int = 30, max_cache_size: int = 100):
        """
        Initialize image downloader
        
        Args:
            timeout: Request timeout in seconds
            max_cache_size: Maximum number of images to cache in memory
        """
        self.timeout = timeout
        self.max_cache_size = max_cache_size
        self._cache = {}
        
    def _is_image_url(self, url: str) -> bool:
        """
        Check if URL appears to be an image based on extension
        
        Args:
            url: URL to check
            
        Returns:
            True if URL ends with image extension
        """
        image_extensions = ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.avif', '.tiff', '.svg')
        url_lower = url.lower()
        return any(url_lower.endswith(ext) for ext in image_extensions)
    
    async def download_image(
        self, image_url: str
    ) -> Tuple[Image.Image, str, ImageMetadata]:
        """
        Download an image from URL and calculate its perceptual hash

        Args:
            image_url: URL of the image to download

        Returns:
            Tuple of (PIL Image object, perceptual hash string, file metadata)

        Raises:
            Exception: If download fails or image is invalid
        """
        try:
            # Check cache first
            cache_key = self._get_cache_key(image_url)
            if cache_key in self._cache:
                logger.info(f"Image found in cache: {image_url}")
                cached_image, cached_hash, cached_meta = self._cache[cache_key]
                return cached_image, cached_hash, cached_meta
            
            logger.info(f"Downloading image from: {image_url}")
            
            # Download image with proper headers
            headers = {
                'User-Agent': 'Mozilla/5.0 (compatible; AmberAuditBot/1.0)',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            }
            
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(image_url, headers=headers)
                response.raise_for_status()
                
                # Check content type (but be lenient)
                content_type = response.headers.get('content-type', '').lower()
                
                # Validate: either has image content-type OR has image extension
                is_valid = False
                if content_type and content_type.startswith('image/'):
                    is_valid = True
                    logger.info(f"Valid Content-Type: {content_type}")
                elif self._is_image_url(image_url):
                    is_valid = True
                    logger.info(f"Valid image extension in URL: {image_url}")
                else:
                    logger.warning(f"Ambiguous content type: {content_type}, trying to load anyway...")
                    is_valid = True  # Try anyway, PIL will fail if it's not an image
                
                if not is_valid:
                    raise ValueError(f"URL does not appear to be an image. Content-Type: {content_type}")
                
                # Load image
                image_data = response.content
                
                # Check if we got any data
                if not image_data or len(image_data) == 0:
                    raise ValueError("Downloaded image data is empty")
                
                logger.info(f"Downloaded {len(image_data)} bytes")
                
                # Try to open as image
                try:
                    image = Image.open(io.BytesIO(image_data))
                except Exception as e:
                    raise ValueError(f"Downloaded content is not a valid image: {str(e)}")
                
                # Verify image is valid
                try:
                    image.verify()
                except Exception as e:
                    raise ValueError(f"Image verification failed: {str(e)}")
                
                # Reload image after verify (verify() closes the file)
                image = Image.open(io.BytesIO(image_data))

                # Capture wire format BEFORE any mode conversion — convert()
                # drops `.format` and we want to report what the CDN served.
                image_format: Optional[str] = image.format

                # Apply EXIF rotation so a portrait shot doesn't get a
                # different pHash than its visually identical landscape twin.
                try:
                    image = ImageOps.exif_transpose(image)
                except Exception as exc:
                    logger.warning(f"EXIF transpose failed: {exc}")

                # Convert to RGB if necessary (for consistency)
                if image.mode not in ('RGB', 'RGBA'):
                    logger.info(f"Converting image from {image.mode} to RGB")
                    image = image.convert('RGB')

                metadata: ImageMetadata = {
                    "file_size_bytes": len(image_data),
                    "format": image_format,
                }

                # Calculate perceptual hash for duplicate detection
                try:
                    image_hash = str(imagehash.phash(image))
                    logger.info(f"Calculated perceptual hash: {image_hash}")
                except Exception as hash_error:
                    logger.warning(f"Failed to calculate hash: {str(hash_error)}")
                    image_hash = None
                
                # Cache image with hash + file metadata
                self._add_to_cache(cache_key, image, image_hash, metadata)

                logger.info(
                    f"Image downloaded successfully: {image.size} {image.mode} "
                    f"format={metadata['format']} size={metadata['file_size_bytes']}B"
                )
                return image, image_hash, metadata
                
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error downloading image: {e.response.status_code} - {image_url}")
            raise Exception(f"Failed to download image: HTTP {e.response.status_code}")
        except httpx.TimeoutException:
            logger.error(f"Timeout downloading image from {image_url}")
            raise Exception(f"Timeout downloading image (>{self.timeout}s)")
        except ValueError as e:
            # Re-raise validation errors as-is
            logger.error(f"Validation error: {str(e)}")
            raise Exception(str(e))
        except Exception as e:
            logger.error(f"Error downloading image from {image_url}: {str(e)}")
            raise Exception(f"Failed to download or process image: {str(e)}")
    
    def _get_cache_key(self, image_url: str) -> str:
        """Generate cache key from URL"""
        return hashlib.md5(image_url.encode()).hexdigest()
    
    def _add_to_cache(
        self,
        key: str,
        image: Image.Image,
        image_hash: Optional[str],
        metadata: ImageMetadata,
    ):
        """Add image, hash, and file metadata to cache with LRU eviction"""
        if len(self._cache) >= self.max_cache_size:
            # Remove oldest item (simple FIFO for now)
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]

        self._cache[key] = (image.copy(), image_hash, metadata)
    
    def clear_cache(self):
        """Clear the image cache"""
        self._cache.clear()
        logger.info("Image cache cleared")
    
    def get_cache_size(self) -> int:
        """Get current cache size"""
        return len(self._cache)
