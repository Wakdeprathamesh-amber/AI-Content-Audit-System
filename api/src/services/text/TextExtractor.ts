import {
  TextClaim,
  TextClaimType,
  TextExtractionResult,
  TextMissingInformation,
  TextSectionName,
} from '../../../../shared/types';
import { config } from '../../config';
import { PropertyTextBundle } from './PropertyTextReader';
import { runStructuredCompletion } from './OpenAiStructuredClient';

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForPrompt(value: string, maxChars: number): string {
  const normalized = compact(value || '');
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 20))} ...[truncated]`;
}

type RawExtractedClaim = {
  claimType: TextClaimType;
  claimLabel: string;
  claimValue: string;
  normalizedValue: string;
  unit: string | null;
  sourceSection: TextSectionName;
  sourceText: string;
};

type RawMissingInfo = {
  section: TextSectionName;
  item: string;
  reason: string;
  severity: 'warning' | 'info';
};

type RawExtractionPayload = {
  claims: RawExtractedClaim[];
  missingInformation: RawMissingInfo[];
};

const extractionSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claimType: {
            type: 'string',
            enum: [
              'rent',
              'deposit',
              'distance',
              'room_size',
              'offer',
              'amenity',
              'policy_term',
              'cancellation_term',
              'house_rule',
              'faq',
              'other',
            ],
          },
          claimLabel: { type: 'string' },
          claimValue: { type: 'string' },
          normalizedValue: { type: 'string' },
          unit: { type: ['string', 'null'] },
          sourceSection: {
            type: 'string',
            enum: ['description', 'faqs', 'house_rules', 'cancellation_policy', 'amenities_blurbs', 'other'],
          },
          sourceText: { type: 'string' },
        },
        required: [
          'claimType',
          'claimLabel',
          'claimValue',
          'normalizedValue',
          'unit',
          'sourceSection',
          'sourceText',
        ],
      },
    },
    missingInformation: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: {
            type: 'string',
            enum: ['description', 'faqs', 'house_rules', 'cancellation_policy', 'amenities_blurbs', 'other'],
          },
          item: { type: 'string' },
          reason: { type: 'string' },
          severity: { type: 'string', enum: ['warning', 'info'] },
        },
        required: ['section', 'item', 'reason', 'severity'],
      },
    },
  },
  required: ['claims', 'missingInformation'],
};

function normalizeClaimValue(claimValue: string): string {
  return compact(claimValue).toLowerCase();
}

function claimTypeRequiresUnit(claimType: TextClaimType): boolean {
  return claimType === 'rent' || claimType === 'distance' || claimType === 'room_size';
}

function validateExtractionPayload(input: RawExtractionPayload): RawExtractionPayload {
  const claims = Array.isArray(input?.claims) ? input.claims : [];
  const missingInformation = Array.isArray(input?.missingInformation) ? input.missingInformation : [];
  return { claims, missingInformation };
}

export class TextExtractor {
  async extract(bundle: PropertyTextBundle): Promise<TextExtractionResult> {
    const promptSections = {
      description: truncateForPrompt(bundle.sections.description, 4000),
      faqs: truncateForPrompt(bundle.sections.faqs, 3000),
      house_rules: truncateForPrompt(bundle.sections.house_rules, 2000),
      cancellation_policy: truncateForPrompt(bundle.sections.cancellation_policy, 2000),
      amenities_blurbs: truncateForPrompt(bundle.sections.amenities_blurbs, 3000),
      other: truncateForPrompt(bundle.sections.other, 2000),
    };

    const systemPrompt = [
      'You are a strict property-content extraction engine for student accommodation.',
      'Extract important factual claims from the provided property content.',
      'Also detect CRITICAL missing information: concrete, named, or quantifiable facts a prospective student (or an answer engine) needs to evaluate this property, that are demonstrably absent.',
      'Return ONLY JSON according to schema.',
      'Do not invent facts.',
      'For missing information, be specific and quantifiable — never vague. Quality over quantity: only list genuine, high-value gaps and never pad.',
      'Allowed claimType values: rent, deposit, distance, room_size, offer, amenity, policy_term, cancellation_term, house_rule, faq, other.',
    ].join(' ');
    const userPrompt = JSON.stringify(
      {
        task: 'Extract structured property claims and critical missing information.',
        propertyId: bundle.propertyId,
        propertyName: bundle.propertyName,
        content: promptSections,
        guidance: {
          focusAreas: [
            'amenities',
            'faq details',
            'house rules',
            'cancellation terms',
            'offers',
            'location/distance facts',
            'pricing/rent/deposit details',
            'policy statements',
          ],
          // Concrete, named, quantifiable gaps only — these mirror what an
          // answer engine would need to cite/recommend the property.
          acceptableMissingInfoExamples: [
            'No walking distance or minutes to the nearest named university (add exact minutes + route).',
            'No nearest tube/metro/bus/train station named with walk time.',
            'No bill inclusions (electricity, water, heating, contents insurance, Wi-Fi speed in Mbps).',
            'No minimum tenancy length or available contract lengths (e.g. 44-week / 51-week).',
            'No deposit amount, guarantor requirement, or group-booking policy.',
            'No accessibility information (step-free access, accessible rooms, lift availability).',
            'No nearest supermarket named (e.g. Tesco Express) with walk time.',
            'No cycle storage / EV charging / parking availability.',
          ],
          // Never emit these — they are vague and unactionable.
          unacceptableMissingInfoExamples: [
            'Add more about the neighbourhood.',
            'Include more amenities.',
            'Describe the rooms better.',
            'Add more SEO keywords.',
            'Make it more engaging.',
          ],
          maxMissingInformationItems: config.textQc.maxMissingInfo,
        },
      },
      null,
      2
    );

    const raw = await runStructuredCompletion<RawExtractionPayload>({
      model: config.textQc.extractionModel,
      schemaName: 'property_text_extraction',
      schema: extractionSchema,
      systemPrompt,
      userPrompt,
    });

    const validated = validateExtractionPayload(raw);
    const claims: TextClaim[] = (validated.claims || [])
      .map((claim, index) => ({
        claimId: `${bundle.propertyId}-txt-${index + 1}`,
        claimType: claim.claimType,
        claimLabel: compact(claim.claimLabel || claim.claimType),
        claimValue: compact(claim.claimValue),
        normalizedValue: compact(claim.normalizedValue || normalizeClaimValue(claim.claimValue)),
        unit: claim.unit ? compact(claim.unit) : null,
        sourceSection: claim.sourceSection,
        sourceText: compact(claim.sourceText).slice(0, 500),
      }))
      .filter((claim) => claim.claimValue.length > 0)
      .filter((claim) => !claimTypeRequiresUnit(claim.claimType) || Boolean(claim.unit));

    const missingInformation: TextMissingInformation[] = (validated.missingInformation || [])
      .map((item) => ({
        section: item.section,
        item: compact(item.item),
        reason: compact(item.reason),
        severity: item.severity,
      }))
      .filter((item) => item.item.length > 0 && item.reason.length > 0)
      // Precision-first cap — surface only the highest-value gaps.
      .slice(0, Math.max(0, config.textQc.maxMissingInfo));

    claims.forEach((claim, index) => {
      claim.claimId = `${bundle.propertyId}-txt-${index + 1}`;
    });

    return {
      claims,
      missingInformation,
      model: config.textQc.extractionModel,
      extractedAt: new Date().toISOString(),
    };
  }
}
