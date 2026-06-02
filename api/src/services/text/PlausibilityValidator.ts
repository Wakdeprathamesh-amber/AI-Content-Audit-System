/**
 * Deterministic plausibility validator (NO LLM).
 *
 * Catches two classes of self-evidently wrong location claims using arithmetic
 * only — so findings are fully explainable and carry zero hallucination risk:
 *
 *   1. IMPOSSIBLE WALK — a "walk" claim states both a distance and a time that
 *      imply a walking speed no human sustains (e.g., "2 miles, 5 min walk").
 *   2. "NEARBY" BUT FAR — walkable/nearby language attached to a distance that
 *      is clearly not nearby (e.g., "moments from campus, just 3 miles away").
 *
 * It is intentionally conservative: when a value is a range we pick the
 * interpretation LEAST likely to trip the check, so we only flag claims that are
 * wrong under every reading.
 */
import { TextClaim, TextIssue } from '../../../../shared/types';
import { config } from '../../config';

const KM_PER_UNIT: Record<string, number> = {
  km: 1,
  kilometre: 1,
  kilometres: 1,
  kilometer: 1,
  kilometers: 1,
  m: 0.001,
  metre: 0.001,
  metres: 0.001,
  meter: 0.001,
  meters: 0.001,
  mile: 1.60934,
  miles: 1.60934,
  mi: 1.60934,
  yard: 0.0009144,
  yards: 0.0009144,
  yd: 0.0009144,
  yds: 0.0009144,
};

// Longer unit spellings first so "miles" wins over "mi" and "metres" over "m".
const DISTANCE_RE =
  /(\d+(?:\.\d+)?)(?:\s*(?:[-–]|to)\s*(\d+(?:\.\d+)?))?\s*(kilometres|kilometers|kilometre|kilometer|km|miles|mile|mi|metres|meters|metre|meter|yards|yard|yds|yd|m)\b/gi;

const MINUTES_RE =
  /(\d+(?:\.\d+)?)(?:\s*(?:[-–]|to)\s*(\d+(?:\.\d+)?))?\s*(minutes|minute|mins|min)\b/gi;

const WALK_CONTEXT_RE = /\b(walk|walking|on foot|stroll|strolling|steps?)\b/i;

const NEARBY_LANGUAGE_RE =
  /\b(nearby|walkable|walking distance|short walk|stroll|steps? (?:from|away)|moments? (?:from|away)|stone'?s throw|on (?:your|the) doorstep|just outside|next to|close by)\b/i;

/** All distances found in the text, expanded to kilometres (ranges → [lo, hi]). */
function parseDistancesKm(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(DISTANCE_RE)) {
    const unit = match[3].toLowerCase();
    const perUnit = KM_PER_UNIT[unit];
    if (perUnit === undefined) continue;
    const lo = parseFloat(match[1]);
    if (Number.isFinite(lo)) out.push(lo * perUnit);
    if (match[2] !== undefined) {
      const hi = parseFloat(match[2]);
      if (Number.isFinite(hi)) out.push(hi * perUnit);
    }
  }
  return out;
}

/** All minute values found in the text (ranges → [lo, hi]). */
function parseMinutes(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(MINUTES_RE)) {
    const lo = parseFloat(match[1]);
    if (Number.isFinite(lo)) out.push(lo);
    if (match[2] !== undefined) {
      const hi = parseFloat(match[2]);
      if (Number.isFinite(hi)) out.push(hi);
    }
  }
  return out;
}

function round(value: number, dp = 1): number {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

export class PlausibilityValidator {
  /**
   * Validate distance/transit claims. Returns at most one issue per claim per
   * check. Only `distance` claims are inspected (others have no spatial meaning).
   */
  validate(claims: TextClaim[]): TextIssue[] {
    const issues: TextIssue[] = [];
    const { walkSpeedMaxKmh, nearbyMaxKm } = config.textQc.plausibility;

    for (const claim of claims) {
      if (claim.claimType !== 'distance') continue;

      const text = `${claim.claimLabel} ${claim.claimValue} ${claim.sourceText}`.toLowerCase();
      const distancesKm = parseDistancesKm(text);
      if (distancesKm.length === 0) continue;

      const minDistanceKm = Math.min(...distancesKm);
      const minutes = parseMinutes(text);

      // 1. Impossible walk: use the slowest reading (min distance, max time);
      //    if even that exceeds human walking speed, the claim is impossible.
      if (WALK_CONTEXT_RE.test(text) && minutes.length > 0) {
        const maxMinutes = Math.max(...minutes);
        if (maxMinutes > 0) {
          const impliedSpeedKmh = minDistanceKm / (maxMinutes / 60);
          if (impliedSpeedKmh > walkSpeedMaxKmh) {
            const realisticMinutes = Math.ceil((minDistanceKm / 5) * 60); // ~5 km/h
            issues.push({
              severity: 'warning',
              category: 'implausible_value',
              description: `Stated walk time is physically impossible: ${round(minDistanceKm)} km in ${maxMinutes} min implies ${round(impliedSpeedKmh)} km/h (walking is ~5 km/h).`,
              recommendation: `Change the walk time to ~${realisticMinutes} min for ${round(minDistanceKm)} km, or correct the distance.`,
              claimId: claim.claimId,
              sourceSection: claim.sourceSection,
            });
            continue; // one issue per claim is enough to action it
          }
        }
      }

      // 2. "Nearby" language attached to a far distance (closest reading still far).
      if (NEARBY_LANGUAGE_RE.test(text) && minDistanceKm > nearbyMaxKm) {
        issues.push({
          severity: 'warning',
          category: 'implausible_value',
          description: `Described as nearby/walkable but the stated distance is ${round(minDistanceKm)} km (threshold ${nearbyMaxKm} km).`,
          recommendation: `Remove the "nearby/walking distance" wording or state the real distance/transit time for ${round(minDistanceKm)} km.`,
          claimId: claim.claimId,
          sourceSection: claim.sourceSection,
        });
      }
    }

    return issues;
  }
}
