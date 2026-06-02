import axios from 'axios';
import { config } from '../../../config';

export interface PmgPageContent {
  url: string;
  text: string;
  fetchedAt: string;
  ok: boolean;
  errorMessage?: string | null;
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripHtml(html: string): string {
  return compact(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * Downloads the operator (PMG) property page and returns plain text for fact-checking.
 */
export class PmgPageFetcher {
  async fetch(url: string): Promise<PmgPageContent> {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await axios.get<string>(url, {
        timeout: config.textQc.pmgFetchTimeoutMs,
        maxRedirects: 3,
        responseType: 'text',
        headers: { 'User-Agent': 'ai-content-audit-text-qc/1.0' },
      });
      const raw = stripHtml(response.data || '');
      const maxChars = Math.max(1000, config.textQc.pmgPageMaxChars);
      const text =
        raw.length <= maxChars ? raw : `${raw.slice(0, Math.max(0, maxChars - 20))} ...[truncated]`;

      return { url, text, fetchedAt, ok: true, errorMessage: null };
    } catch (error: any) {
      console.warn(`Text QC PMG page fetch failed for ${url}: ${error.message}`);
      return {
        url,
        text: '',
        fetchedAt,
        ok: false,
        errorMessage: error?.message || 'fetch failed',
      };
    }
  }
}
