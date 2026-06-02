import axios from 'axios';
import { config } from '../../config';

type JsonSchema = Record<string, unknown>;

export interface StructuredCompletionRequest {
  model: string;
  schemaName: string;
  schema: JsonSchema;
  systemPrompt: string;
  userPrompt: string;
}

let openAiQueue: Promise<void> = Promise.resolve();
let lastOpenAiRequestAt = 0;

function getOpenAiApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for LLM-based Text QC.');
  }
  return apiKey;
}

export async function runStructuredCompletion<T>(request: StructuredCompletionRequest): Promise<T> {
  const apiKey = getOpenAiApiKey();
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await enqueueOpenAiCall(() =>
        axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: request.model,
            temperature: 0,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: request.schema,
              },
            },
          },
          {
            timeout: 45_000,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          }
        )
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenAI returned empty structured response.');
      }

      try {
        return JSON.parse(content) as T;
      } catch (error: any) {
        throw new Error(`OpenAI returned invalid JSON: ${error.message}`);
      }
    } catch (error: any) {
      lastError = error;
      const status = error?.response?.status as number | undefined;
      const retryable =
        !status || status === 429 || (status >= 500 && status <= 599) || error.code === 'ECONNABORTED';
      if (!retryable || attempt === 3) {
        break;
      }
      const waitMs = 1000 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw new Error(`Structured completion failed after retries: ${(lastError as any)?.message || 'unknown error'}`);
}

/** Shared rate-limited queue for all OpenAI Chat Completions (text QC structured JSON). */
export async function enqueueOpenAiCall<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    await applyOpenAiSpacing();
    return task();
  };

  const chained = openAiQueue.then(run, run);
  openAiQueue = chained.then(
    () => undefined,
    () => undefined
  );
  return chained;
}

async function applyOpenAiSpacing(): Promise<void> {
  const minIntervalMs = Math.max(0, config.textQc.openAiMinIntervalMs);
  if (minIntervalMs <= 0) {
    return;
  }
  const now = Date.now();
  const waitMs = Math.max(0, lastOpenAiRequestAt + minIntervalMs - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastOpenAiRequestAt = Date.now();
}
