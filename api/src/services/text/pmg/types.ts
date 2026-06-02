import { PmgPageContent } from './PmgPageFetcher';
import { PmgSourceResolution } from './PmgSourceResolver';

/** Inputs for comparing Amber listing claims against fetched PMG page text. */
export interface PmgFactCheckContext {
  resolution: PmgSourceResolution;
  page: PmgPageContent | null;
}
