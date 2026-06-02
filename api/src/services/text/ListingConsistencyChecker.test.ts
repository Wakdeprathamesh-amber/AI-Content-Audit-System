import { ListingConsistencyChecker } from './ListingConsistencyChecker';
import { PropertyTextBundle } from './PropertyTextReader';
import { runStructuredCompletion } from './OpenAiStructuredClient';

jest.mock('./OpenAiStructuredClient', () => ({
  runStructuredCompletion: jest.fn(),
}));

const mockedStructured = runStructuredCompletion as jest.MockedFunction<typeof runStructuredCompletion>;

function bundle(overrides: Partial<PropertyTextBundle> = {}): PropertyTextBundle {
  return {
    propertyId: 'p-1',
    propertyName: 'Test House',
    sections: {
      description:
        'All rooms are en-suite with private bathrooms. Shared bathrooms are located on each floor for convenience. Studios include a private kitchen.',
      faqs: '',
      house_rules: '',
      cancellation_policy: '',
      amenities_blurbs: '',
      other: '',
    },
    pmgSourceUrl: null,
    referenceUrls: [],
    structuredBaseline: { amenities: [], policies: [], faqs: [] },
    ...overrides,
  };
}

describe('ListingConsistencyChecker', () => {
  const checker = new ListingConsistencyChecker();

  afterEach(() => jest.resetAllMocks());

  it('maps a grounded contradiction finding to a TextIssue', async () => {
    mockedStructured.mockResolvedValue({
      findings: [
        {
          type: 'internal_contradiction',
          severity: 'critical',
          quote: 'All rooms are en-suite',
          conflictingQuote: 'Shared bathrooms are located on each floor',
          explanation: 'En-suite claim contradicts shared bathrooms.',
          suggestedFix: 'Remove "shared bathrooms on each floor" or correct the en-suite claim.',
        },
      ],
    } as never);

    const issues = await checker.check(bundle());
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('internal_contradiction');
    expect(issues[0].severity).toBe('critical');
    expect(issues[0].recommendation).toMatch(/remove|correct/i);
    expect(issues[0].description).toMatch(/en-suite/i);
  });

  it('drops findings whose quote is not present in the source text (anti-hallucination)', async () => {
    mockedStructured.mockResolvedValue({
      findings: [
        {
          type: 'impossible_feature',
          severity: 'warning',
          quote: 'rooftop infinity pool on the 14th floor',
          conflictingQuote: null,
          explanation: 'Hallucinated feature not in the listing.',
          suggestedFix: 'n/a',
        },
      ],
    } as never);

    const issues = await checker.check(bundle());
    expect(issues).toHaveLength(0);
  });

  it('drops a contradiction whose conflicting quote is not grounded', async () => {
    mockedStructured.mockResolvedValue({
      findings: [
        {
          type: 'internal_contradiction',
          severity: 'critical',
          quote: 'All rooms are en-suite',
          conflictingQuote: 'rooms have no bathrooms at all anywhere',
          explanation: 'Second quote is not in the text.',
          suggestedFix: 'n/a',
        },
      ],
    } as never);

    const issues = await checker.check(bundle());
    expect(issues).toHaveLength(0);
  });

  it('returns empty and skips the model when there is too little text', async () => {
    const issues = await checker.check(
      bundle({
        sections: {
          description: 'Nice.',
          faqs: '',
          house_rules: '',
          cancellation_policy: '',
          amenities_blurbs: '',
          other: '',
        },
      })
    );
    expect(issues).toHaveLength(0);
    expect(mockedStructured).not.toHaveBeenCalled();
  });

  it('returns empty on model failure', async () => {
    mockedStructured.mockRejectedValue(new Error('boom'));
    const issues = await checker.check(bundle());
    expect(issues).toHaveLength(0);
  });
});
