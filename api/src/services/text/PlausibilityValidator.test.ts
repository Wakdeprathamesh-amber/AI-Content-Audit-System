import { TextClaim } from '../../../../shared/types';
import { PlausibilityValidator } from './PlausibilityValidator';

function distanceClaim(overrides: Partial<TextClaim> = {}): TextClaim {
  return {
    claimId: 'c1',
    claimType: 'distance',
    claimLabel: 'distance',
    claimValue: '',
    normalizedValue: null,
    unit: null,
    sourceSection: 'description',
    sourceText: '',
    ...overrides,
  };
}

describe('PlausibilityValidator', () => {
  const validator = new PlausibilityValidator();

  it('flags a walk time that is physically impossible for the distance', () => {
    const issues = validator.validate([
      distanceClaim({ claimValue: '2 miles', sourceText: 'Just a 5 min walk to campus.' }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('implausible_value');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].description).toMatch(/impossible/i);
  });

  it('does not flag a realistic walk time', () => {
    const issues = validator.validate([
      distanceClaim({ claimValue: '0.4 km', sourceText: 'A 5 minute walk to the station.' }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('is conservative with ranges (uses the slowest reading)', () => {
    const issues = validator.validate([
      distanceClaim({ claimValue: '1 to 2 miles', sourceText: 'A 30 min walk away.' }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('flags nearby/walkable language attached to a far distance', () => {
    const issues = validator.validate([
      distanceClaim({ claimValue: '3 km', sourceText: 'Within walking distance of campus.' }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toMatch(/nearby|walkable/i);
  });

  it('does not flag nearby language for a genuinely close distance', () => {
    const issues = validator.validate([
      distanceClaim({ claimValue: '0.5 km', sourceText: 'Within walking distance of campus.' }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('ignores non-distance claims and distance claims without a parseable distance', () => {
    const issues = validator.validate([
      distanceClaim({ claimType: 'rent', claimValue: '£250 in 2 min', sourceText: '' }),
      distanceClaim({ claimValue: 'near campus', sourceText: 'A short walk away.' }),
    ]);
    expect(issues).toHaveLength(0);
  });
});
