import { TextClaim } from '../../../../shared/types';
import { runStructuredCompletion } from './OpenAiStructuredClient';
import { PmgFactChecker } from './PmgFactChecker';

jest.mock('./OpenAiStructuredClient', () => ({
  runStructuredCompletion: jest.fn(),
}));

const mockedStructured = runStructuredCompletion as jest.MockedFunction<typeof runStructuredCompletion>;

describe('PmgFactChecker', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  const claim: TextClaim = {
    claimId: 'p-1-txt-1',
    claimType: 'distance',
    claimLabel: 'walk to campus',
    claimValue: '11-minute walk',
    normalizedValue: '11 minute walk',
    unit: 'minutes',
    sourceSection: 'description',
    sourceText: '11-minute walk to campus.',
  };

  it('compares claims against fetched PMG page text', async () => {
    mockedStructured.mockResolvedValue({
      checks: [
        {
          claimId: 'p-1-txt-1',
          status: 'verified',
          confidence: 0.9,
          evidenceUrl: 'https://wearehomesforstudents.com/example',
          evidenceSnippet: 'Less than a 10-minute walk to campus',
          notes: null,
        },
      ],
    } as any);

    const checker = new PmgFactChecker();
    const result = await checker.checkClaims([claim], {
      resolution: { pmgUrl: 'https://wearehomesforstudents.com/example', urlSource: 'source_link' },
      page: {
        url: 'https://wearehomesforstudents.com/example',
        text: 'Less than a 10-minute walk to campus.',
        fetchedAt: new Date().toISOString(),
        ok: true,
      },
    });

    expect(result[0].status).toBe('verified');
    expect(result[0].source).toBe('pmg');
    expect(result[0].verificationMode).toBe('pmg_db');
    expect(result[0].evidenceSource?.type).toBe('pmg_db_url');
    expect(mockedStructured).toHaveBeenCalled();
  });

  it('returns missing_evidence when no PMG URL in DB', async () => {
    const checker = new PmgFactChecker();
    const result = await checker.checkClaims([claim], {
      resolution: { pmgUrl: null, urlSource: 'none' },
      page: null,
    });

    expect(result[0].status).toBe('missing_evidence');
    expect(result[0].verificationMode).toBe('no_url');
    expect(mockedStructured).not.toHaveBeenCalled();
  });

  it('returns missing_evidence when PMG page fetch failed', async () => {
    const checker = new PmgFactChecker();
    const result = await checker.checkClaims([claim], {
      resolution: { pmgUrl: 'https://wearehomesforstudents.com/example', urlSource: 'source_link' },
      page: {
        url: 'https://wearehomesforstudents.com/example',
        text: '',
        fetchedAt: new Date().toISOString(),
        ok: false,
        errorMessage: 'timeout',
      },
    });

    expect(result[0].status).toBe('missing_evidence');
    expect(result[0].verificationMode).toBe('fetch_failed');
    expect(mockedStructured).not.toHaveBeenCalled();
  });
});
