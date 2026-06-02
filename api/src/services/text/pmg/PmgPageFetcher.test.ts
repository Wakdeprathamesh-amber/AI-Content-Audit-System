import axios from 'axios';
import { PmgPageFetcher } from './PmgPageFetcher';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('PmgPageFetcher', () => {
  afterEach(() => jest.resetAllMocks());

  it('strips HTML and returns plain text', async () => {
    mockedAxios.get.mockResolvedValue({
      data: '<html><body><h1>Property</h1><p>5 min walk to campus.</p></body></html>',
    } as any);

    const fetcher = new PmgPageFetcher();
    const result = await fetcher.fetch('https://wearehomesforstudents.com/example');

    expect(result.ok).toBe(true);
    expect(result.text).toContain('5 min walk to campus');
    expect(result.text).not.toContain('<p>');
  });

  it('returns ok=false when fetch fails', async () => {
    mockedAxios.get.mockRejectedValue(new Error('timeout'));

    const fetcher = new PmgPageFetcher();
    const result = await fetcher.fetch('https://wearehomesforstudents.com/example');

    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
  });
});
