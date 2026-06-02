import { TextClaim, TextFactCheckResult, TextIssue } from '../../../../shared/types';
import { TextQcScorer } from './TextQcScorer';

function claim(overrides: Partial<TextClaim> = {}): TextClaim {
  return {
    claimId: 'claim-1',
    claimType: 'rent',
    claimLabel: 'rent',
    claimValue: '£250 per week',
    unit: 'per_week',
    sourceSection: 'description',
    sourceText: 'Rooms from £250 per week.',
    ...overrides,
  };
}

function fact(overrides: Partial<TextFactCheckResult> = {}): TextFactCheckResult {
  return {
    claimId: 'claim-1',
    status: 'verified',
    confidence: 0.85,
    evidenceUrl: 'https://www.wearehomesforstudents.com/properties/sample',
    evidenceSnippet: 'Rooms from £250 per week',
    checkedAt: new Date().toISOString(),
    source: 'pmg',
    notes: null,
    ...overrides,
  };
}

describe('TextQcScorer', () => {
  const scorer = new TextQcScorer();

  it('builds warning/critical issues from fact-check outcomes', () => {
    const claims: TextClaim[] = [
      claim({ claimId: 'c1', claimType: 'rent', claimLabel: 'rent' }),
      claim({ claimId: 'c2', claimType: 'deposit', claimLabel: 'deposit' }),
      claim({ claimId: 'c3', claimType: 'amenity', claimLabel: 'amenity:gym' }),
    ];
    const facts: TextFactCheckResult[] = [
      fact({ claimId: 'c1', status: 'verified' }),
      fact({ claimId: 'c2', status: 'conflict' }),
      fact({ claimId: 'c3', status: 'missing_evidence' }),
    ];
    const issues = scorer.buildIssues(
      { claims, missingInformation: [], model: 'gpt-4o-mini', extractedAt: new Date().toISOString() },
      facts,
      ['extraction', 'fact_check', 'missing_info']
    );

    const categories = new Set(issues.map((issue: TextIssue) => issue.category));
    expect(categories.has('fact_conflict')).toBe(true);
    expect(categories.has('missing_info')).toBe(true);
    expect(issues.some((issue) => issue.severity === 'critical')).toBe(true);
  });

  it('computes bounded score and summary fields', () => {
    const claims: TextClaim[] = [
      claim({ claimId: 'c1', claimType: 'rent' }),
      claim({ claimId: 'c2', claimType: 'deposit' }),
      claim({ claimId: 'c3', claimType: 'amenity' }),
    ];
    const facts: TextFactCheckResult[] = [
      fact({ claimId: 'c1', status: 'verified' }),
      fact({ claimId: 'c2', status: 'not_found' }),
      fact({ claimId: 'c3', status: 'verified' }),
    ];
    const issues = scorer.buildIssues(
      { claims, missingInformation: [], model: 'gpt-4o-mini', extractedAt: new Date().toISOString() },
      facts,
      ['extraction', 'fact_check', 'missing_info']
    );
    const summary = scorer.buildSummary(claims, facts, issues);

    expect(summary.totalClaims).toBe(3);
    expect(summary.verifiedClaims).toBe(2);
    expect(summary.missingEvidenceClaims).toBe(1);
    expect(summary.score).toBeGreaterThanOrEqual(0);
    expect(summary.score).toBeLessThanOrEqual(100);
  });

  it('does not emit fact-check issues when fact_check check is disabled', () => {
    const claims: TextClaim[] = [
      claim({ claimId: 'c1', claimType: 'rent' }),
      claim({ claimId: 'c2', claimType: 'deposit' }),
    ];
    const issues = scorer.buildIssues(
      { claims, missingInformation: [], model: 'gpt-4o-mini', extractedAt: new Date().toISOString() },
      [],
      ['extraction']
    );

    expect(issues.some((issue) => issue.category === 'fact_conflict')).toBe(false);
    expect(issues.some((issue) => issue.description.includes('fact-check result'))).toBe(false);
  });
});
