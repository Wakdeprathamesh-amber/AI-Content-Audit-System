import fixtures from './__fixtures__/text-qc-golden-fixtures.json';
import { PropertyTextBundle } from './PropertyTextReader';
import { TextExtractor } from './TextExtractor';
import * as OpenAiStructuredClient from './OpenAiStructuredClient';

describe('TextExtractor', () => {
  const extractor = new TextExtractor();
  const runStructuredCompletionSpy = jest.spyOn(OpenAiStructuredClient, 'runStructuredCompletion');

  beforeEach(() => {
    runStructuredCompletionSpy.mockResolvedValue({
      claims: [
        {
          claimType: 'rent',
          claimLabel: 'rent_per_week',
          claimValue: '£250 per week',
          normalizedValue: '250 per week',
          unit: 'per_week',
          sourceSection: 'description',
          sourceText: 'Rooms from £250 per week.',
        },
        {
          claimType: 'deposit',
          claimLabel: 'deposit_amount',
          claimValue: '£300 deposit',
          normalizedValue: '300 deposit',
          unit: null,
          sourceSection: 'description',
          sourceText: '£300 deposit.',
        },
        {
          claimType: 'distance',
          claimLabel: 'distance_to_campus',
          claimValue: '5 min walk',
          normalizedValue: '5 minute walk',
          unit: 'minute',
          sourceSection: 'description',
          sourceText: '5 min walk to campus.',
        },
        {
          claimType: 'room_size',
          claimLabel: 'room_size',
          claimValue: '120 sq ft',
          normalizedValue: '120 square feet',
          unit: 'sq_ft',
          sourceSection: 'description',
          sourceText: 'Rooms are 120 sq ft.',
        },
        {
          claimType: 'amenity',
          claimLabel: 'amenity_gym',
          claimValue: 'gym',
          normalizedValue: 'gym',
          unit: null,
          sourceSection: 'amenities_blurbs',
          sourceText: 'Onsite gym, laundry, wifi and study room.',
        },
      ],
      missingInformation: [],
    } as never);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('extracts claims from golden fixtures without duplicate claim IDs', async () => {
    for (const fixture of fixtures as PropertyTextBundle[]) {
      const result = await extractor.extract(fixture);
      const ids = new Set(result.claims.map((claim) => claim.claimId));

      expect(result.model).toBeTruthy();
      expect(result.extractedAt).toBeTruthy();
      expect(ids.size).toBe(result.claims.length);
    }
  });

  it('captures quantitative and amenity signals for rich text content', async () => {
    const bundle = (fixtures as PropertyTextBundle[])[0];
    const result = await extractor.extract(bundle);
    const claimTypes = new Set(result.claims.map((claim) => claim.claimType));

    expect(claimTypes.has('rent')).toBe(true);
    expect(claimTypes.has('deposit')).toBe(true);
    expect(claimTypes.has('distance')).toBe(true);
    expect(claimTypes.has('room_size')).toBe(true);
    expect(claimTypes.has('amenity')).toBe(true);
    expect(result.claims.length).toBeGreaterThanOrEqual(5);
  });
});
