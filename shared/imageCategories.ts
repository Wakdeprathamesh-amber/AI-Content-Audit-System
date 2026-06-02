/**
 * Image category tags — aligned with inventories.images[].type in production.
 * AI categorization uses the same set except legacy `room` is folded into `bedroom`.
 */

/** Tags observed in DB (inspect-all-image-tags.js). */
export const DB_IMAGE_CATEGORIES = [
  'bedroom',
  'kitchen',
  'bathroom',
  'common_area',
  'amenities',
  'floor_plan',
  'exterior',
  'room', // legacy; treat as bedroom for hero + mismatch checks
] as const;

/** Tags the Vision model may output (no legacy `room`). */
export const AI_IMAGE_CATEGORIES = [
  'bedroom',
  'kitchen',
  'bathroom',
  'common_area',
  'amenities',
  'floor_plan',
  'exterior',
] as const;

const SLEEPING = new Set(['bedroom', 'room']);

export function normalizeCategoryTag(tag: string | null | undefined): string | null {
  if (tag == null) return null;
  const s = String(tag).trim();
  if (!s) return null;
  return s.toLowerCase().replace(/[\s-]+/g, '_');
}

/** Any lettable sleeping space — upstream `room` counts as bedroom for heroes. */
export function isBedroomCategory(tag: string | null | undefined): boolean {
  const n = normalizeCategoryTag(tag);
  return n != null && SLEEPING.has(n);
}

/** Upstream vs AI comparison — room/bedroom are equivalent. */
export function categoriesMatchForAudit(
  upstream: string | null | undefined,
  detected: string | null | undefined
): boolean {
  const u = normalizeCategoryTag(upstream);
  const d = normalizeCategoryTag(detected);
  if (!u || !d) return false;
  if (u === d) return true;
  return isBedroomCategory(u) && isBedroomCategory(d);
}

/** Normalize AI output: legacy `room` → `bedroom`. */
export function canonicalizeAiCategory(tag: string | null | undefined): string | null {
  const n = normalizeCategoryTag(tag);
  if (!n) return null;
  if (n === 'room') return 'bedroom';
  return n;
}
