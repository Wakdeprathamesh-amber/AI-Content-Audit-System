import axios from 'axios';
import { runStructuredCompletion } from './OpenAiStructuredClient';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OpenAiStructuredClient', () => {
  const prevKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    jest.resetAllMocks();
  });

  afterAll(() => {
    process.env.OPENAI_API_KEY = prevKey;
  });

  it('retries transient failures and returns parsed JSON payload', async () => {
    mockedAxios.post
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'server error' } as any)
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: '{"ok":true}' } }],
        },
      } as any);

    const result = await runStructuredCompletion<{ ok: boolean }>({
      model: 'gpt-4o-mini',
      schemaName: 'test_schema',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      systemPrompt: 'system',
      userPrompt: 'user',
    });

    expect(result.ok).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});
