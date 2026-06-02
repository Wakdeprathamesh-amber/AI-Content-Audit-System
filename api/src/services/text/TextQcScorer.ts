import {
  TextExtractionResult,
  TextAuditSummary,
  TextCheckType,
  TextClaim,
  TextFactCheckResult,
  TextIssue,
} from '../../../../shared/types';
import { isExternallyVerifiable } from './claimPolicy';

const REQUIRED_CLAIM_TYPES: Array<TextClaim['claimType']> = ['rent', 'deposit', 'amenity'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class TextQcScorer {
  /**
   * Build issues from fact-check outcomes, missing-info, and duplicate detection.
   *
   * Precision-first: we only raise an actionable issue (warning/critical) when we
   * have a verifiable CONFLICT. "Could not verify" outcomes are logged as `info`
   * (they stay in the detail log but never flood the action-items tab), and claims
   * that were never eligible for external verification (operator-asserted/dynamic)
   * produce no fact-check noise at all.
   *
   * Internal-consistency and plausibility findings are produced by their own
   * dedicated checkers and merged by {@link TextQcService} — they are not built here.
   */
  buildIssues(
    extraction: TextExtractionResult,
    factChecks: TextFactCheckResult[],
    textChecks: TextCheckType[],
    _baseline?: { amenities?: string[]; policies?: string[]; faqs?: string[] }
  ): TextIssue[] {
    const claims = extraction.claims;
    const issues: TextIssue[] = [];
    const factByClaimId = new Map(factChecks.map((fact) => [fact.claimId, fact]));
    const factCheckEnabled = textChecks.includes('fact_check');

    if (factCheckEnabled) {
      for (const claim of claims) {
        const fact = factByClaimId.get(claim.claimId);

        if (!fact) {
          // No external verification result for this claim.
          // Operator-asserted/dynamic claims are assumed correct → stay silent.
          // An externally-verifiable claim with no result is logged as info only.
          if (isExternallyVerifiable(claim.claimType)) {
            issues.push({
              severity: 'info',
              category: 'missing_info',
              description: `Claim "${claim.claimLabel}" was not returned by fact-check.`,
              recommendation: 'Confirm a PMG source URL exists for this property, then re-run fact-check.',
              claimId: claim.claimId,
              sourceSection: claim.sourceSection,
            });
          }
          continue;
        }

        if (fact.status === 'conflict') {
          const evidence = fact.evidenceUrl ? ` (PMG evidence: ${fact.evidenceUrl})` : '';
          issues.push({
            severity: 'critical',
            category: 'fact_conflict',
            description: `Claim "${claim.claimLabel}" = "${claim.claimValue}" conflicts with PMG source evidence.${evidence}`,
            recommendation: fact.evidenceUrl
              ? `Change the listing to match ${fact.evidenceUrl}, or correct the source if the listing is right.`
              : 'Reconcile the listing value with the source of truth and re-run fact-check.',
            claimId: claim.claimId,
            sourceSection: claim.sourceSection,
          });
        } else if (fact.status === 'missing_evidence' || fact.status === 'not_found') {
          // Could-not-verify is informational, never an action item.
          issues.push({
            severity: 'info',
            category: 'missing_info',
            description: `Claim "${claim.claimLabel}" could not be verified against PMG sources.`,
            recommendation: 'Add/confirm the PMG source URL for this property to enable verification.',
            claimId: claim.claimId,
            sourceSection: claim.sourceSection,
          });
        } else if (fact.status === 'unknown') {
          issues.push({
            severity: 'info',
            category: 'general',
            description: `Claim "${claim.claimLabel}" could not be conclusively verified.`,
            recommendation: 'Review evidence and refine extraction/fact-check rules.',
            claimId: claim.claimId,
            sourceSection: claim.sourceSection,
          });
        }
        // 'verified' → no issue.
      }
    }

    if (textChecks.includes('missing_info')) {
      const foundTypes = new Set(claims.map((claim) => claim.claimType));
      REQUIRED_CLAIM_TYPES.forEach((type) => {
        if (!foundTypes.has(type)) {
          issues.push({
            severity: 'warning',
            category: 'missing_info',
            description: `Required claim type "${type}" is missing from extracted content.`,
            recommendation: `Add clear ${type} information to the listing text.`,
          });
        }
      });

      (extraction.missingInformation || []).forEach((missing) => {
        issues.push({
          severity: missing.severity,
          category: 'missing_info',
          description: `Missing information in ${missing.section}: ${missing.item}. ${missing.reason}`,
          recommendation: `Add "${missing.item}" to ${missing.section.replace('_', ' ')} content.`,
          sourceSection: missing.section,
        });
      });
    }

    if (textChecks.includes('duplicate_property')) {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      claims.forEach((claim) => {
        const key = `${claim.claimType}::${(claim.normalizedValue || claim.claimValue).toLowerCase()}`;
        if (seen.has(key)) duplicates.add(claim.claimLabel);
        else seen.add(key);
      });
      duplicates.forEach((label) => {
        issues.push({
          severity: 'warning',
          category: 'duplicate_property',
          description: `Potential duplicate claim detected: "${label}" appears multiple times.`,
          recommendation: 'Review and deduplicate repeated claims in source content.',
        });
      });
    }

    return issues;
  }

  buildSummary(claims: TextClaim[], factChecks: TextFactCheckResult[], issues: TextIssue[]): TextAuditSummary {
    const totalClaims = claims.length;
    const verifiedClaims = factChecks.filter((fact) => fact.status === 'verified').length;
    const conflictingClaims = factChecks.filter((fact) => fact.status === 'conflict').length;
    const missingEvidenceClaims = factChecks.filter(
      (fact) => fact.status === 'missing_evidence' || fact.status === 'not_found'
    ).length;

    const requiredFound = new Set(claims.map((claim) => claim.claimType));
    const missingFields = REQUIRED_CLAIM_TYPES.filter((type) => !requiredFound.has(type)).length;

    // Score from the components that actually apply. Fact coverage is only a
    // component when at least one claim was eligible for external verification —
    // otherwise we renormalize so unverifiable listings aren't unfairly penalised.
    const extractionCompleteness = totalClaims === 0 ? 0 : Math.min(totalClaims / 8, 1);
    const criticalCoverage = 1 - missingFields / REQUIRED_CLAIM_TYPES.length;
    const checkedClaims = factChecks.length;
    const factCoverage = checkedClaims > 0 ? verifiedClaims / checkedClaims : null;

    const components: Array<{ value: number; weight: number }> = [
      { value: extractionCompleteness, weight: 40 },
      { value: criticalCoverage, weight: 20 },
    ];
    if (factCoverage !== null) {
      components.push({ value: factCoverage, weight: 40 });
    }
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    const weightedScore =
      totalWeight === 0 ? 0 : (components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight) * 100;

    const criticalPenalty = issues.filter((issue) => issue.severity === 'critical').length * 8;
    const warningPenalty = issues.filter((issue) => issue.severity === 'warning').length * 2;
    const score = clamp(Math.round(weightedScore - criticalPenalty - warningPenalty), 0, 100);

    return {
      totalClaims,
      verifiedClaims,
      conflictingClaims,
      missingEvidenceClaims,
      missingFields,
      score,
    };
  }
}
