/**
 * Bit-level perceptual-hash similarity.
 *
 * The previous implementation compared hex characters and treated a single
 * mismatched hex char as 4 bits of distance — over-counting near-duplicates
 * and missing real ones. This module does true Hamming distance.
 *
 * Input format: hex string from `imagehash.phash(...)` (typically 16 hex chars
 * = 64 bits, but any equal-length hex pair works).
 */

const HEX_BIT_COUNTS = (() => {
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    let v = i;
    let c = 0;
    while (v) {
      c += v & 1;
      v >>= 1;
    }
    t[i] = c;
  }
  return t;
})();

function hexCharToNibble(ch: string): number {
  // Returns 0-15, or -1 for invalid.
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;       // 0-9
  if (code >= 97 && code <= 102) return code - 87;      // a-f
  if (code >= 65 && code <= 70) return code - 55;       // A-F
  return -1;
}

/**
 * Bit-level Hamming distance between two equal-length hex strings.
 * Throws on invalid input.
 */
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`Hash length mismatch: ${a.length} vs ${b.length}`);
  }
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const na = hexCharToNibble(a[i]);
    const nb = hexCharToNibble(b[i]);
    if (na < 0 || nb < 0) {
      throw new Error(`Invalid hex char at index ${i}: '${a[i]}' / '${b[i]}'`);
    }
    dist += HEX_BIT_COUNTS[na ^ nb];
  }
  return dist;
}

/**
 * Similarity in percent (0–100) based on bit-level Hamming distance.
 * Returns 0 if hashes are missing or lengths differ.
 */
export function hashSimilarityPercent(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dist: number;
  try {
    dist = hammingDistanceHex(a, b);
  } catch {
    return 0;
  }
  const totalBits = a.length * 4;
  const similarity = (1 - dist / totalBits) * 100;
  return Math.max(0, Math.min(100, similarity));
}
