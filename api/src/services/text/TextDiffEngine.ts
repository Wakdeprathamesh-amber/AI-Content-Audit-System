import { TextClaim, TextIssue } from '../../../../shared/types';

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const GENERIC_AMENITY_VALUES = new Set([
  'available',
  'provided',
  'included',
  'available throughout',
  'yes',
  'no',
  'n a',
]);

function isGenericAmenityValue(value: string): boolean {
  const token = normalizeToken(value);
  if (!token) return true;
  if (GENERIC_AMENITY_VALUES.has(token)) return true;
  // Price-only/amount-only values are not amenity names.
  if (/^[~£$€]?\s?\d+([.,]\d+)?(\s*\/\s*\w+)?$/.test(token)) return true;
  return false;
}

export class TextDiffEngine {
  buildDiffIssues(
    claims: TextClaim[],
    baseline: { amenities?: string[]; policies?: string[]; faqs?: string[] }
  ): TextIssue[] {
    const issues: TextIssue[] = [];
    const baselineAmenities = (baseline.amenities || []).map(normalizeToken).filter(Boolean);
    const baselinePolicies = [...(baseline.policies || []), ...(baseline.faqs || [])]
      .map(normalizeToken)
      .filter(Boolean);

    const extractedAmenities = claims
      .filter((claim) => claim.claimType === 'amenity')
      .map((claim) => {
        const fromLabel = normalizeToken(claim.claimLabel || '');
        const fromValue = normalizeToken(claim.claimValue || '');
        // Prefer descriptive labels ("High-speed WiFi") over generic values
        // ("Available", "Provided") to avoid noisy consistency alerts.
        if (fromLabel && !isGenericAmenityValue(fromLabel)) return claim.claimLabel;
        if (fromValue && !isGenericAmenityValue(fromValue)) return claim.claimValue;
        return '';
      })
      .filter(Boolean);

    const seenAmenities = new Set<string>();
    extractedAmenities.forEach((amenity) => {
      const normalized = normalizeToken(amenity);
      if (!normalized || seenAmenities.has(normalized)) return;
      seenAmenities.add(normalized);
      const inBaseline = baselineAmenities.some((item) => item === normalized || item.includes(normalized));
      if (!inBaseline) {
        issues.push({
          severity: 'warning',
          category: 'consistency',
          diffType: 'missing_in_structured',
          description: `Extracted amenity "${amenity}" is not present in existing structured property amenities.`,
          recommendation: 'Human review: verify this amenity and add it to structured content if correct.',
        });
      }
    });

    const extractedPolicies = claims
      .filter((claim) => ['policy_term', 'cancellation_term', 'house_rule', 'faq'].includes(claim.claimType))
      .map((claim) => claim.claimValue)
      .filter(Boolean);
    extractedPolicies.forEach((policy) => {
      const normalized = normalizeToken(policy);
      const inBaseline = baselinePolicies.some((item) => item === normalized || item.includes(normalized));
      if (!inBaseline) {
        issues.push({
          severity: 'warning',
          category: 'consistency',
          diffType: 'missing_in_structured',
          description: `Extracted policy/rule "${policy}" is not present in existing structured policy fields.`,
          recommendation:
            'Human review: verify and add to policy/FAQ/house-rule structured content if correct.',
        });
      }
    });

    return issues;
  }
}
