import { TextClaim, TextFactCheckResult } from '../../../../shared/types';
import { config } from '../../config';
import { runStructuredCompletion } from './OpenAiStructuredClient';
import { PmgFactCheckContext } from './pmg/types';

type RawFactCheckItem = {
  claimId: string;
  status: TextFactCheckResult['status'];
  confidence: number;
  evidenceUrl: string | null;
  evidenceSnippet: string | null;
  notes: string | null;
};

type RawFactCheckPayload = {
  checks: RawFactCheckItem[];
};

const factCheckSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claimId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['verified', 'conflict', 'missing_evidence', 'not_found', 'unknown'],
          },
          confidence: { type: 'number' },
          evidenceUrl: { type: ['string', 'null'] },
          evidenceSnippet: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
        },
        required: ['claimId', 'status', 'confidence', 'evidenceUrl', 'evidenceSnippet', 'notes'],
      },
    },
  },
  required: ['checks'],
};

function validateFactCheckPayload(input: RawFactCheckPayload): RawFactCheckPayload {
  if (!input || !Array.isArray(input.checks)) {
    return { checks: [] };
  }
  return { checks: input.checks };
}

function chunkClaims(claims: TextClaim[], size: number): TextClaim[][] {
  const chunkSize = Math.max(1, size);
  const chunks: TextClaim[][] = [];
  for (let i = 0; i < claims.length; i += chunkSize) {
    chunks.push(claims.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verificationModeFromContext(context: PmgFactCheckContext): TextFactCheckResult['verificationMode'] {
  if (!context.resolution.pmgUrl) return 'no_url';
  if (!context.page?.ok) return 'fetch_failed';
  return 'pmg_db';
}

/**
 * Compares extracted Amber listing claims against text fetched from the DB PMG URL.
 */
export class PmgFactChecker {
  async checkClaims(claims: TextClaim[], context: PmgFactCheckContext): Promise<TextFactCheckResult[]> {
    const checkedAt = new Date().toISOString();
    const verificationMode = verificationModeFromContext(context);

    if (!context.resolution.pmgUrl) {
      return claims.map((claim) => this.noEvidenceResult(claim, checkedAt, verificationMode, 'No PMG URL in DB (source_link or reference URLs).'));
    }

    if (!context.page?.ok || !context.page.text) {
      return claims.map((claim) =>
        this.noEvidenceResult(
          claim,
          checkedAt,
          verificationMode,
          context.page?.errorMessage || 'Failed to download PMG property page.'
        )
      );
    }

    const pmgEvidence = {
      url: context.page.url,
      text: context.page.text,
      fetchedAt: context.page.fetchedAt,
    };

    const claimBatches = chunkClaims(claims, config.textQc.factCheckClaimBatchSize);
    const allChecks: RawFactCheckItem[] = [];
    console.log(
      `Text fact-check: ${claims.length} claims, PMG page ${context.page.url} (${pmgEvidence.text.length} chars), ${claimBatches.length} batch(es).`
    );

    const systemPrompt = [
      'You verify student accommodation listing claims using ONLY the provided PMG property page text.',
      'The listing claims come from our website (Amber); the PMG page is the operator source of truth.',
      'Mark verified only when the PMG page clearly supports the same fact (same place, distance, policy, etc.).',
      'Mark conflict when the PMG page clearly contradicts the claim.',
      'Mark missing_evidence when the PMG text does not mention or cannot support the claim.',
      'Be conservative on distances and prices that may change.',
      'Return strict JSON only.',
    ].join(' ');

    for (let index = 0; index < claimBatches.length; index += 1) {
      const claimBatch = claimBatches[index];
      const userPrompt = JSON.stringify(
        {
          task: 'Compare Amber listing claims against the fetched PMG property page.',
          pmgEvidence,
          claims: claimBatch,
        },
        null,
        2
      );

      const raw = await runStructuredCompletion<RawFactCheckPayload>({
        model: config.textQc.factCheckModel,
        schemaName: 'property_claim_factcheck',
        schema: factCheckSchema,
        systemPrompt,
        userPrompt,
      });
      allChecks.push(...validateFactCheckPayload(raw).checks);

      if (index < claimBatches.length - 1 && config.textQc.factCheckBatchDelayMs > 0) {
        await sleep(config.textQc.factCheckBatchDelayMs);
      }
    }

    const byId = new Map(allChecks.map((item) => [item.claimId, item]));
    return claims.map((claim) => {
      const llm = byId.get(claim.claimId);
      if (!llm) {
        return this.noEvidenceResult(claim, checkedAt, verificationMode, 'LLM did not return an item for this claim.');
      }

      const evidenceUrl = llm.evidenceUrl || context.page?.url || null;
      return {
        claimId: claim.claimId,
        status: llm.status,
        confidence: Math.max(0, Math.min(1, llm.confidence)),
        evidenceUrl,
        evidenceSnippet: llm.evidenceSnippet,
        checkedAt,
        source: llm.status === 'missing_evidence' || llm.status === 'not_found' ? 'none' : 'pmg',
        verificationMode,
        evidenceSource: {
          type: verificationMode === 'pmg_db' ? 'pmg_db_url' : 'none',
          url: evidenceUrl,
          snippet: llm.evidenceSnippet,
        },
        notes: llm.notes || null,
      };
    });
  }

  private noEvidenceResult(
    claim: TextClaim,
    checkedAt: string,
    verificationMode: TextFactCheckResult['verificationMode'],
    notes: string
  ): TextFactCheckResult {
    return {
      claimId: claim.claimId,
      status: 'missing_evidence',
      confidence: 0,
      evidenceUrl: null,
      evidenceSnippet: null,
      checkedAt,
      source: 'none',
      verificationMode,
      evidenceSource: { type: 'none', url: null, snippet: null },
      notes,
    };
  }
}
