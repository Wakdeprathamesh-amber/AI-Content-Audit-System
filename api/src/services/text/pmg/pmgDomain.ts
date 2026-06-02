import { URL } from 'url';
import { config } from '../../../config';

export function pmgAllowedDomains(): string[] {
  return config.textQc.pmgAllowedDomains.map((d) => d.toLowerCase());
}

export function isAllowedPmgUrl(urlString: string, allowedDomains: string[] = pmgAllowedDomains()): boolean {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function dedupeUrls(urls: string[]): string[] {
  return urls
    .map((u) => u.trim())
    .filter((u) => u.startsWith('http://') || u.startsWith('https://'))
    .filter((u, idx, arr) => arr.findIndex((x) => x.toLowerCase() === u.toLowerCase()) === idx);
}
