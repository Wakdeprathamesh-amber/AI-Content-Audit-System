"""
Duplicate Image Detector Service
Detects duplicate images within a property using perceptual hashing
"""

import imagehash
from PIL import Image
from typing import List, Dict, Optional
import logging

logger = logging.getLogger(__name__)

class DuplicateDetector:
    """Detects duplicate images using perceptual hashing (pHash)"""
    
    def __init__(self, similarity_threshold: float = 95.0):
        """
        Initialize duplicate detector
        
        Args:
            similarity_threshold: Percentage threshold for duplicate detection (0-100)
                                 Default 95% matches the original algorithm
        """
        self.similarity_threshold = similarity_threshold
        
    def calculate_hash(self, image: Image.Image) -> str:
        """
        Calculate perceptual hash for an image
        
        Args:
            image: PIL Image object
            
        Returns:
            Hash string (hex format)
        """
        try:
            # Use pHash (perceptual hash) - same as original algorithm
            hash_obj = imagehash.phash(image)
            return str(hash_obj)
        except Exception as e:
            logger.error(f"Error calculating image hash: {str(e)}")
            return None
    
    def calculate_similarity(self, hash1: str, hash2: str) -> Optional[float]:
        """
        Calculate similarity percentage between two hashes
        
        Args:
            hash1: First image hash (hex string)
            hash2: Second image hash (hex string)
            
        Returns:
            Similarity percentage (0-100) or None if error
        """
        try:
            if not hash1 or not hash2:
                return None
            
            # Convert hex strings back to hash objects
            hash_obj1 = imagehash.hex_to_hash(hash1)
            hash_obj2 = imagehash.hex_to_hash(hash2)
            
            # Calculate Hamming distance
            distance = hash_obj1 - hash_obj2
            
            # Convert to similarity percentage
            # pHash uses 8x8 = 64 bits
            hash_length = len(hash_obj1.hash) ** 2
            similarity = (1 - distance / hash_length) * 100
            
            return round(similarity, 2)
        except Exception as e:
            logger.error(f"Error calculating similarity: {str(e)}")
            return None
    
    def detect_duplicates(self, images_data: List[Dict]) -> List[Dict]:
        """
        Detect duplicate images within a list
        
        Args:
            images_data: List of dicts with 'image_id', 'image' (PIL Image), and 'hash'
            
        Returns:
            List of dicts with duplicate detection results:
            {
                'image_id': str,
                'hash': str,
                'is_duplicate': bool,
                'duplicate_of_image_id': str or None,
                'similarity_percentage': float or None
            }
        """
        results = []
        seen_hashes = []  # Store non-duplicate hashes
        
        logger.info(f"Checking {len(images_data)} images for duplicates...")
        
        for img_data in images_data:
            image_id = img_data.get('image_id')
            image_hash = img_data.get('hash')
            
            if not image_hash:
                # No hash available, skip duplicate check
                results.append({
                    'image_id': image_id,
                    'hash': None,
                    'is_duplicate': False,
                    'duplicate_of_image_id': None,
                    'similarity_percentage': None
                })
                continue
            
            # Compare with all previously seen (non-duplicate) images
            max_similarity = 0.0
            duplicate_of = None
            
            for prev_data in seen_hashes:
                prev_hash = prev_data['hash']
                similarity = self.calculate_similarity(image_hash, prev_hash)
                
                if similarity and similarity > max_similarity:
                    max_similarity = similarity
                    if similarity >= self.similarity_threshold:
                        duplicate_of = prev_data['image_id']
            
            # Determine if duplicate
            is_duplicate = max_similarity >= self.similarity_threshold
            
            if is_duplicate:
                logger.info(f"Duplicate detected: {image_id} is {max_similarity}% similar to {duplicate_of}")
            
            results.append({
                'image_id': image_id,
                'hash': image_hash,
                'is_duplicate': is_duplicate,
                'duplicate_of_image_id': duplicate_of,
                'similarity_percentage': max_similarity if max_similarity > 0 else None
            })
            
            # Only add to seen_hashes if NOT a duplicate
            if not is_duplicate:
                seen_hashes.append({
                    'image_id': image_id,
                    'hash': image_hash
                })
        
        duplicate_count = sum(1 for r in results if r['is_duplicate'])
        logger.info(f"Duplicate detection complete: {duplicate_count} duplicates found out of {len(images_data)} images")
        
        return results
    
    def check_single_duplicate(self, image_hash: str, existing_hashes: List[Dict]) -> Dict:
        """
        Check if a single image is a duplicate of existing images
        
        Args:
            image_hash: Hash of the image to check
            existing_hashes: List of dicts with 'image_id' and 'hash'
            
        Returns:
            Dict with duplicate detection result
        """
        if not image_hash or not existing_hashes:
            return {
                'is_duplicate': False,
                'duplicate_of_image_id': None,
                'similarity_percentage': None
            }
        
        max_similarity = 0.0
        duplicate_of = None
        
        for existing in existing_hashes:
            similarity = self.calculate_similarity(image_hash, existing['hash'])
            
            if similarity and similarity > max_similarity:
                max_similarity = similarity
                if similarity >= self.similarity_threshold:
                    duplicate_of = existing['image_id']
        
        return {
            'is_duplicate': max_similarity >= self.similarity_threshold,
            'duplicate_of_image_id': duplicate_of,
            'similarity_percentage': max_similarity if max_similarity > 0 else None
        }
