/**
 * Listing consistency checker — evidence-free internal audit (LLM-based).
 *
 * Finds problems that need NO external source, only the listing's own text:
 *   - internal_contradiction: two statements disagree (e.g. "all rooms en-suite"
 *     vs "shared bathrooms on each floor").
 *   - room_type_mismatch: a room type described with inconsistent features
 *     (e.g. a "Studio" with a "shared kitchen down the hall").
 *   - impossible_feature: physically/logically impossible as stated
 *     (e.g. "private garden on the 14th floor").
 *
 * Design choices that keep this safe even on a small model:
 *   - The prompt forbids outside knowledge and forbids flagging merely-unverified
 *     claims (precision-first — quality over quantity, empty list is valid).
 *   - Every finding must quote the exact offending text; we then DROP any finding
 *     whose quote is not actually present in the source (anti-hallucination guard).
 *   - Output is capped (config.textQc.maxConsistencyFindings).
 */
import { TextIssue, TextIssueCategory } from '../../../../shared/types';
import { config } from '../../config';
import { runStructuredCompletion } from './OpenAiStructuredClient';
import { PropertyTextBundle } from './PropertyTextReader';

type RawFindingType = 'internal_contradiction' | 'room_type_mismatch' | 'impossible_feature';

interface RawFinding {
  type: RawFindingType;
  severity: 'critical' | 'warning';
  quote: string;
  conflictingQuote: string | null;
  explanation: string;
  suggestedFix: string;
}

interface RawConsistencyPayload {
  findings: RawFinding[];
}

const consistencySchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: {
            type: 'string',
            enum: ['internal_contradiction', 'room_type_mismatch', 'impossible_feature'],
          },
          severity: { type: 'string', enum: ['critical', 'warning'] },
          quote: { type: 'string' },
          conflictingQuote: { type: ['string', 'null'] },
          explanation: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['type', 'severity', 'quote', 'conflictingQuote', 'explanation', 'suggestedFix'],
      },
    },
  },
  required: ['findings'],
};

const SECTION_ORDER: Array<keyof PropertyTextBundle['sections']> = [
  'description',
  'amenities_blurbs',
  'faqs',
  'house_rules',
  'cancellation_policy',
  'other',
];

/** Lowercase + collapse whitespace + drop surrounding quote marks, for substring matching. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ListingConsistencyChecker {
  async check(bundle: PropertyTextBundle): Promise<TextIssue[]> {
    const combinedText = SECTION_ORDER.map((section) => {
      const value = bundle.sections[section];
      return value ? `## ${section}\n${value}` : '';
    })
      .filter(Boolean)
      .join('\n\n');

    if (normalizeForMatch(combinedText).length < 40) {
      // Not enough text to reason about — avoid spurious findings.
      return [];
    }

    const systemPrompt = [
      'You are a precise listing-consistency auditor for a student-accommodation marketplace.',
      'Find ONLY problems internal to the provided text: contradictions between two statements, room-type descriptions inconsistent with the named room type, and physically or logically impossible feature claims.',
      'Use ONLY the provided text. Do NOT use outside knowledge and do NOT verify facts against the world.',
      'Do NOT flag claims that are merely unverified, vague, or marketing language.',
      'Quote the exact offending text verbatim. For a contradiction, quote BOTH conflicting statements.',
      'Quality over quantity: if nothing clearly qualifies, return an empty findings array. Never pad.',
    ].join(' ');

    const userPrompt = JSON.stringify(
      {
        task: 'Audit this listing for internal contradictions, room-type mismatches, and impossible features.',
        propertyId: bundle.propertyId,
        propertyName: bundle.propertyName,
        content: combinedText.slice(0, 12000),
        instructions: {
          internal_contradiction:
            'Two statements that cannot both be true (e.g. "all rooms are en-suite" vs "shared bathrooms on each floor").',
          room_type_mismatch:
            'A room type named but described with features inconsistent with that type (e.g. a "Studio" with a shared kitchen, an "En-suite" sharing a bathroom).',
          impossible_feature:
            'A feature that is physically or logically impossible as stated (e.g. "private garden on the 14th floor", "on-site parking" in a building described as car-free).',
          suggestedFix: 'Give a concrete edit: "change X to Y" or "remove Z because ...". Never "verify and update".',
        },
      },
      null,
      2
    );

    let raw: RawConsistencyPayload;
    try {
      raw = await runStructuredCompletion<RawConsistencyPayload>({
        model: config.textQc.consistencyModel,
        schemaName: 'listing_consistency_audit',
        schema: consistencySchema,
        systemPrompt,
        userPrompt,
      });
    } catch (error: any) {
      console.warn(`Listing consistency check failed: ${error.message}`);
      return [];
    }

    const findings = Array.isArray(raw?.findings) ? raw.findings : [];
    const normalizedSource = normalizeForMatch(combinedText);

    return findings
      .filter((finding) => this.isGrounded(finding, normalizedSource))
      .slice(0, Math.max(0, config.textQc.maxConsistencyFindings))
      .map((finding) => this.toIssue(finding));
  }

  /**
   * Anti-hallucination guard: the primary quote (and, for a contradiction, the
   * conflicting quote) must actually appear in the source text.
   */
  private isGrounded(finding: RawFinding, normalizedSource: string): boolean {
    const quote = normalizeForMatch(finding.quote || '');
    if (quote.length < 4 || !normalizedSource.includes(quote)) return false;

    if (finding.type === 'internal_contradiction') {
      const conflicting = normalizeForMatch(finding.conflictingQuote || '');
      if (conflicting.length < 4 || !normalizedSource.includes(conflicting)) return false;
    }
    return true;
  }

  private toIssue(finding: RawFinding): TextIssue {
    const category: TextIssueCategory = finding.type;
    const severity = finding.severity === 'critical' ? 'critical' : 'warning';
    const quotes =
      finding.type === 'internal_contradiction' && finding.conflictingQuote
        ? `"${finding.quote}" vs "${finding.conflictingQuote}"`
        : `"${finding.quote}"`;

    return {
      severity,
      category,
      description: `${finding.explanation} (${quotes})`,
      recommendation: finding.suggestedFix,
    };
  }
}
