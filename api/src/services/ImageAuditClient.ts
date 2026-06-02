import axios, { AxiosInstance, AxiosError } from 'axios';
import { ImageAnalysisResult } from '../../../shared/types';
import { config } from '../config';

/**
 * Client for the Python image-module.
 *
 * Notes:
 *  - The real OpenAI-token-saving cache lives in the Python module
 *    (services/analysis_cache.py). It runs BEFORE the OpenAI call. The previous
 *    Node-side cache only ran after Python had already paid the bill.
 *  - Retries are restricted to network / 5xx / 429 errors. We never retry 4xx
 *    validation errors.
 */
export class ImageAuditClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || config.imageModuleUrl;

    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: config.imageClient.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
      },
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const cfg: any = error.config ?? {};
        const status = error.response?.status;
        const retryable = this.isRetryableStatus(status) || !error.response;

        if (!retryable) {
          return Promise.reject(error);
        }

        cfg.retry = (cfg.retry ?? 0) + 1;
        if (cfg.retry > config.imageClient.maxRetries) {
          return Promise.reject(error);
        }

        const retryAfterMs = this.parseRetryAfterMs(error);
        const backoffMs = this.exponentialBackoffMs(cfg.retry);
        const delay = retryAfterMs !== null ? Math.max(retryAfterMs, backoffMs) : backoffMs;
        console.log(
          `Retrying request (attempt ${cfg.retry}/${config.imageClient.maxRetries}) after ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.client(cfg);
      }
    );
  }

  private isRetryableStatus(status?: number): boolean {
    if (!status) return true;
    if (status === 429) return true;
    return status >= 500 && status <= 599;
  }

  private parseRetryAfterMs(error: AxiosError): number | null {
    const rawHeader = error.response?.headers?.['retry-after'];
    if (!rawHeader) return null;
    const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return Math.max(0, Math.round(seconds * 1000));
    }
    const dateMillis = Date.parse(String(raw));
    if (Number.isNaN(dateMillis)) return null;
    return Math.max(0, dateMillis - Date.now());
  }

  private exponentialBackoffMs(attempt: number): number {
    const base = config.imageClient.baseRetryDelayMs;
    const cap = config.imageClient.maxRetryDelayMs;
    const jitter = Math.floor(Math.random() * Math.max(1, config.imageClient.jitterMs));
    return Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)) + jitter);
  }

  async analyzeImage(
    imageUrl: string,
    checks: string[] = ['quality', 'watermark', 'category'],
    existingTag?: string,
    imageId?: string
  ): Promise<ImageAnalysisResult> {
    try {
      const response = await this.client.post('/api/v1/image/analyze', {
        image_url: imageUrl,
        checks,
        existing_tag: existingTag,
        image_id: imageId,
      });

      const data = response.data;
      if (data.cache_hit) {
        console.log(`   💾 Cache HIT: ${(data.image_hash ?? '').substring(0, 8)}…`);
      } else {
        console.log(`   ✅ Analysis complete: ${data.processing_time_ms}ms`);
      }

      const result: ImageAnalysisResult = {
        imageId: '',
        imageUrl: data.image_url,
        imageHash: data.image_hash,
        quality: data.quality,
        watermark: data.watermark,
        category: data.category,
      };
      return result;
    } catch (error: any) {
      console.error('Error calling Image Module:', error.message);
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error || error.message;
        if (status === 403) {
          throw new Error(`IMAGE_SOURCE_FORBIDDEN: ${status} - ${message}`);
        }
        if (status === 429) {
          throw new Error(`IMAGE_RATE_LIMITED: ${status} - ${message}`);
        }
        if (status >= 400 && status < 500) {
          throw new Error(`IMAGE_NON_RETRYABLE_CLIENT_ERROR: ${status} - ${message}`);
        }
        throw new Error(
          `Image Module error: ${status} - ${message}`
        );
      } else if (error.request) {
        throw new Error('Image Module is not responding. Please check if the service is running.');
      } else {
        throw new Error(`Failed to analyze image: ${error.message}`);
      }
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.get('/health', { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      console.error('Image Module connection test failed:', error);
      return false;
    }
  }

  async getHealth(): Promise<any> {
    try {
      const response = await this.client.get('/health');
      return response.data;
    } catch (error) {
      throw new Error('Failed to get Image Module health status');
    }
  }
}
