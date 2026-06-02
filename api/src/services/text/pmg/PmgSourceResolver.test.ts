import { PropertyTextBundle } from '../PropertyTextReader';
import { PmgSourceResolver } from './PmgSourceResolver';

function bundle(overrides: Partial<PropertyTextBundle> = {}): PropertyTextBundle {
  return {
    propertyId: 'p-1',
    propertyName: 'Test House',
    sections: {
      description: '',
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

describe('PmgSourceResolver', () => {
  const resolver = new PmgSourceResolver();

  it('prefers pmgSourceUrl from source_link', () => {
    const url = 'https://wearehomesforstudents.com/student-accommodation/sheffield/the-elements';
    const result = resolver.resolve(bundle({ pmgSourceUrl: url, referenceUrls: [url] }));
    expect(result.pmgUrl).toBe(url);
    expect(result.urlSource).toBe('source_link');
  });

  it('accepts valid source_link URL outside PMG allowlist', () => {
    const url = 'https://www.studentroost.co.uk/locations/sheffield/central-place';
    const result = resolver.resolve(bundle({ pmgSourceUrl: url, referenceUrls: [] }));
    expect(result.pmgUrl).toBe(url);
    expect(result.urlSource).toBe('source_link');
  });

  it('falls back to allowed reference URL when source_link missing', () => {
    const url = 'https://wearehomesforstudents.com/properties/abc';
    const result = resolver.resolve(bundle({ referenceUrls: [url] }));
    expect(result.pmgUrl).toBe(url);
    expect(result.urlSource).toBe('reference_url');
  });

  it('returns none when no allowed PMG URL in DB fields', () => {
    const result = resolver.resolve(bundle({ referenceUrls: ['https://example.com/other'] }));
    expect(result.pmgUrl).toBeNull();
    expect(result.urlSource).toBe('none');
  });
});
