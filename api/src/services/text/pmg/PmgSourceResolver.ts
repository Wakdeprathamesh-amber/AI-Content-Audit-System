import { PropertyTextBundle } from '../PropertyTextReader';
import { dedupeUrls, isAllowedPmgUrl, pmgAllowedDomains } from './pmgDomain';

export type PmgUrlSource = 'source_link' | 'reference_url' | 'none';

export interface PmgSourceResolution {
  /** Canonical PMG / operator property page URL from inventories. */
  pmgUrl: string | null;
  urlSource: PmgUrlSource;
}

/**
 * Resolves the single PMG page URL used for fact-checking.
 * Always prefers `source_link` (inventories), then other allowed-domain reference URLs.
 * Does not perform web search — URL must exist in DB/listing metadata.
 */
export class PmgSourceResolver {
  resolve(bundle: PropertyTextBundle): PmgSourceResolution {
    const allowed = pmgAllowedDomains();

    // source_link comes from inventories and is our canonical property source.
    // Accept any syntactically valid http(s) URL here; allowlist still applies
    // for fallback reference URLs scraped from other fields.
    if (bundle.pmgSourceUrl) {
      const url = bundle.pmgSourceUrl.trim();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        return { pmgUrl: url, urlSource: 'source_link' };
      }
    }

    const fromReferences = dedupeUrls(bundle.referenceUrls).find((url) => isAllowedPmgUrl(url, allowed));
    if (fromReferences) {
      return { pmgUrl: fromReferences, urlSource: 'reference_url' };
    }

    return { pmgUrl: null, urlSource: 'none' };
  }
}
