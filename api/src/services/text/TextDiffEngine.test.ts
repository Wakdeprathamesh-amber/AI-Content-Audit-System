import { TextDiffEngine } from './TextDiffEngine';
import { TextClaim } from '../../../../shared/types';

function claim(partial: Partial<TextClaim>): TextClaim {
  return {
    claimId: partial.claimId || 'c1',
    claimType: partial.claimType || 'amenity',
    claimLabel: partial.claimLabel || 'amenity',
    claimValue: partial.claimValue || '',
    normalizedValue: partial.normalizedValue || '',
    unit: partial.unit || null,
    sourceSection: partial.sourceSection || 'amenities_blurbs',
    sourceText: partial.sourceText || '',
  };
}

describe('TextDiffEngine amenities normalization', () => {
  it('ignores generic amenity values and uses descriptive labels', () => {
    const engine = new TextDiffEngine();
    const claims: TextClaim[] = [
      claim({
        claimId: 'a1',
        claimLabel: 'High-speed WiFi',
        claimValue: 'Available throughout',
      }),
      claim({
        claimId: 'a2',
        claimLabel: 'On-site laundry facilities',
        claimValue: 'Available',
      }),
    ];

    const issues = engine.buildDiffIssues(claims, {
      amenities: ['High-speed WiFi', 'On-site laundry facilities'],
      policies: [],
      faqs: [],
    });

    expect(issues.filter((i) => i.category === 'consistency')).toHaveLength(0);
  });
});
