import { hammingDistanceHex, hashSimilarityPercent } from './hashSimilarity';

describe('hashSimilarity', () => {
  describe('hammingDistanceHex', () => {
    it('identical hashes → 0', () => {
      expect(hammingDistanceHex('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
    });

    it('single bit flip is exactly 1 distance', () => {
      // 0xf = 1111, 0xe = 1110 → 1 bit different
      expect(hammingDistanceHex('f000000000000000', 'e000000000000000')).toBe(1);
    });

    it('all bits flipped → 64 distance for 16-char hex', () => {
      expect(hammingDistanceHex('ffffffffffffffff', '0000000000000000')).toBe(64);
    });

    it('counts intra-nibble bit differences (not hex-char mismatches)', () => {
      // 0x5 = 0101, 0xa = 1010 — every bit differs → 4 distance
      expect(hammingDistanceHex('5555555555555555', 'aaaaaaaaaaaaaaaa')).toBe(64);
    });

    it('throws on length mismatch', () => {
      expect(() => hammingDistanceHex('abc', 'abcd')).toThrow();
    });

    it('throws on non-hex characters', () => {
      expect(() => hammingDistanceHex('xyz0000000000000', '0000000000000000')).toThrow();
    });
  });

  describe('hashSimilarityPercent', () => {
    it('identical → 100', () => {
      expect(hashSimilarityPercent('abcdef0123456789', 'abcdef0123456789')).toBe(100);
    });

    it('1 bit different in 64 = ~98.4%', () => {
      const s = hashSimilarityPercent('f000000000000000', 'e000000000000000');
      expect(s).toBeCloseTo((1 - 1 / 64) * 100, 5);
    });

    it('all bits different → 0', () => {
      expect(hashSimilarityPercent('ffffffffffffffff', '0000000000000000')).toBe(0);
    });

    it('null / mismatched lengths → 0', () => {
      expect(hashSimilarityPercent(null, 'abcd')).toBe(0);
      expect(hashSimilarityPercent('ab', 'abcd')).toBe(0);
      expect(hashSimilarityPercent('abcd', undefined)).toBe(0);
    });

    it('exceeds the old hex-char approximation for near-identical pairs', () => {
      // Old algorithm: any single hex-char mismatch counted as 4 bit-distance.
      // Reality: 0xf↔0xe is only 1 bit. Old would say 100*(1 - 4/64) = 93.75%.
      // New must be (1 - 1/64)*100 ≈ 98.44%, which is more permissive on
      // genuinely near-duplicate images.
      const oldApprox = (1 - 4 / 64) * 100;
      const real = hashSimilarityPercent('f000000000000000', 'e000000000000000');
      expect(real).toBeGreaterThan(oldApprox);
    });
  });
});
