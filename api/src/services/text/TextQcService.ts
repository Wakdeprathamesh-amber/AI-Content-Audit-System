import {
  TextAuditResult,
  TextCheckType,
  TextFactCheckResult,
  TextIssue,
} from '../../../../shared/types';
import { PropertyDataReaderDB } from '../PropertyDataReaderDB';
import { isExternallyVerifiable } from './claimPolicy';
import { ListingConsistencyChecker } from './ListingConsistencyChecker';
import { PlausibilityValidator } from './PlausibilityValidator';
import { PmgFactChecker } from './PmgFactChecker';
import { PmgPageFetcher } from './pmg/PmgPageFetcher';
import { PmgSourceResolver } from './pmg/PmgSourceResolver';
import { PropertyTextReader } from './PropertyTextReader';
import { TextDiffEngine } from './TextDiffEngine';
import { TextExtractor } from './TextExtractor';
import { TextQcScorer } from './TextQcScorer';

const EXTRACTION_DEPENDENT_CHECKS: TextCheckType[] = [
  'extraction',
  'fact_check',
  'missing_info',
  'cross_field_consistency',
  'duplicate_property',
];

/**
 * Text QC pipeline:
 *  1. Load Amber listing text from DB (PropertyTextReader)
 *  2. Extract claims + gaps (TextExtractor / OpenAI structured)
 *  3. Fact-check: resolve PMG URL from DB → fetch PMG page → compare (PmgFactChecker)
 *  4. Score issues and optional internal consistency / structured diff
 */
export class TextQcService {
  private readonly textReader: PropertyTextReader;
  private readonly extractor: TextExtractor;
  private readonly pmgSourceResolver: PmgSourceResolver;
  private readonly pmgPageFetcher: PmgPageFetcher;
  private readonly factChecker: PmgFactChecker;
  private readonly scorer: TextQcScorer;
  private readonly diffEngine: TextDiffEngine;
  private readonly plausibilityValidator: PlausibilityValidator;
  private readonly consistencyChecker: ListingConsistencyChecker;

  constructor(propertyReader: PropertyDataReaderDB) {
    this.textReader = new PropertyTextReader(propertyReader);
    this.extractor = new TextExtractor();
    this.pmgSourceResolver = new PmgSourceResolver();
    this.pmgPageFetcher = new PmgPageFetcher();
    this.factChecker = new PmgFactChecker();
    this.scorer = new TextQcScorer();
    this.diffEngine = new TextDiffEngine();
    this.plausibilityValidator = new PlausibilityValidator();
    this.consistencyChecker = new ListingConsistencyChecker();
  }

  async run(propertyId: string, checks: TextCheckType[]): Promise<TextAuditResult | null> {
    if (!checks || checks.length === 0) {
      return null;
    }
    const bundle = await this.textReader.getPropertyTextBundle(propertyId);
    if (!bundle) return null;

    const requiresExtraction = checks.some((check) => EXTRACTION_DEPENDENT_CHECKS.includes(check));
    if (!requiresExtraction) {
      return null;
    }

    const extraction = await this.extractor.extract(bundle);
    let factChecks: TextFactCheckResult[] = [];

    if (checks.includes('fact_check')) {
      const verifiableClaims = extraction.claims.filter((claim) => isExternallyVerifiable(claim.claimType));
      if (verifiableClaims.length > 0) {
        const resolution = this.pmgSourceResolver.resolve(bundle);
        const page = resolution.pmgUrl ? await this.pmgPageFetcher.fetch(resolution.pmgUrl) : null;
        factChecks = await this.factChecker.checkClaims(verifiableClaims, { resolution, page });
      }
    }

    const issues: TextIssue[] = this.scorer.buildIssues(
      extraction,
      factChecks,
      checks,
      bundle.structuredBaseline
    );

    if (checks.includes('missing_info')) {
      issues.push(...this.diffEngine.buildDiffIssues(extraction.claims, bundle.structuredBaseline));
    }

    if (checks.includes('cross_field_consistency')) {
      issues.push(...this.plausibilityValidator.validate(extraction.claims));
      issues.push(...(await this.consistencyChecker.check(bundle)));
    }

    const summary = this.scorer.buildSummary(extraction.claims, factChecks, issues);

    return {
      extraction,
      factChecks,
      issues,
      summary,
    };
  }
}
