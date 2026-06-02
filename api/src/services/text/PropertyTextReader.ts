import { db } from '../../config/database';
import { PropertyDataReaderDB } from '../PropertyDataReaderDB';
import { TextSectionName } from '../../../../shared/types';
import { dedupeUrls } from './pmg/pmgDomain';

export interface PropertyTextBundle {
  propertyId: string;
  propertyName: string;
  sections: Record<TextSectionName, string>;
  /** Canonical PMG URL from inventories.source_link (when on allowed domain). */
  pmgSourceUrl: string | null;
  referenceUrls: string[];
  structuredBaseline: {
    amenities: string[];
    policies: string[];
    faqs: string[];
  };
}

type RawInventoryRow = {
  id: string | number;
  parent_id?: string | number | null;
  name: string | null;
  description: unknown;
  meta: unknown;
  faqs?: unknown;
  offers?: unknown;
  highlights?: unknown;
  features?: unknown;
  message?: unknown;
  message_1?: unknown;
  links?: unknown;
  connect_details?: unknown;
  source_link?: unknown;
  source_details?: unknown;
  location?: unknown;
};

function safeParseJson(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeMaybeString(value: unknown): string {
  if (typeof value === 'string') return compact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function extractDescription(raw: unknown): string {
  const parsed = safeParseJson(raw);
  if (Array.isArray(parsed)) {
    const parts = parsed
      .map((entry) => {
        if (typeof entry === 'string') return compact(entry);
        if (entry && typeof entry === 'object' && 'value' in entry) {
          return normalizeMaybeString((entry as Record<string, unknown>).value);
        }
        return '';
      })
      .filter(Boolean);
    return compact(parts.join(' '));
  }
  return normalizeMaybeString(raw);
}

function extractStringArray(value: unknown): string[] {
  const parsed = safeParseJson(value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          return normalizeMaybeString(item);
        }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return normalizeMaybeString(
            obj.name ??
              obj.title ??
              obj.value ??
              obj.answer ??
              obj.question ??
              obj.description ??
              obj.type
          );
        }
        return '';
      })
      .filter(Boolean);
  }
  const single = normalizeMaybeString(value);
  return single ? [single] : [];
}

function extractFaqPairs(value: unknown): string[] {
  const parsed = safeParseJson(value);
  if (!Array.isArray(parsed)) return extractStringArray(value);
  return parsed
    .map((item) => {
      if (!item || typeof item !== 'object') return normalizeMaybeString(item);
      const obj = item as Record<string, unknown>;
      const q = normalizeMaybeString(obj.question ?? obj.q ?? obj.name);
      const a = normalizeMaybeString(obj.answer ?? obj.a ?? obj.value ?? obj.description);
      if (q && a) return `Q: ${q} A: ${a}`;
      return q || a;
    })
    .filter(Boolean);
}

function extractFeatureNames(value: unknown): string[] {
  const parsed = safeParseJson(value);
  if (!Array.isArray(parsed)) return extractStringArray(value);
  const out: string[] = [];
  parsed.forEach((item) => {
    if (!item || typeof item !== 'object') {
      const plain = normalizeMaybeString(item);
      if (plain) out.push(plain);
      return;
    }
    const obj = item as Record<string, unknown>;
    const name = normalizeMaybeString(obj.name ?? obj.title ?? obj.type);
    if (name) out.push(name);
    const values = safeParseJson(obj.values);
    if (Array.isArray(values)) {
      values.forEach((v) => {
        if (v && typeof v === 'object') {
          const vv = v as Record<string, unknown>;
          const vn = normalizeMaybeString(vv.name ?? vv.title ?? vv.value ?? vv.type);
          if (vn) out.push(vn);
        } else {
          const vn = normalizeMaybeString(v);
          if (vn) out.push(vn);
        }
      });
    }
  });
  return out;
}

function extractPolicyLikeLines(...inputs: unknown[]): string[] {
  const texts = inputs.map((v) => normalizeMaybeString(v)).filter(Boolean).join('\n');
  if (!texts) return [];
  return texts
    .split(/\n|•|-/)
    .map((line) => compact(line))
    .filter((line) => line.length > 8);
}

function extractUrlsFromMeta(meta: unknown): string[] {
  const parsed = safeParseJson(meta);
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const candidates = [
    obj.property_page_url,
    obj.property_url,
    obj.website_url,
    obj.web_url,
    obj.pmg_url,
    obj.url,
  ];
  const nestedWeb = obj.web && typeof obj.web === 'object' ? (obj.web as Record<string, unknown>) : null;
  if (nestedWeb) {
    candidates.push(nestedWeb.url, nestedWeb.property_url, nestedWeb.pmg_url);
  }
  return candidates
    .map((value) => normalizeMaybeString(value))
    .filter((value) => value.startsWith('http://') || value.startsWith('https://'));
}

function extractUrlsFromGenericField(value: unknown): string[] {
  const asString = normalizeMaybeString(value);
  const candidates = new Set<string>();
  if (asString) {
    const direct = asString.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
    direct.forEach((u) => candidates.add(u));
  }
  const parsed = safeParseJson(value);
  if (parsed && typeof parsed === 'object') {
    const queue: unknown[] = [parsed];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      if (typeof current === 'string') {
        const links = current.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
        links.forEach((u) => candidates.add(u));
      } else if (Array.isArray(current)) {
        current.forEach((item) => queue.push(item));
      } else if (typeof current === 'object') {
        Object.values(current as Record<string, unknown>).forEach((item) => queue.push(item));
      }
    }
  }
  return Array.from(candidates);
}

export class PropertyTextReader {
  constructor(private readonly propertyReader: PropertyDataReaderDB) {}

  async getPropertyTextBundle(propertyId: string): Promise<PropertyTextBundle | null> {
    const rootId = await this.propertyReader.resolveRootPropertyId(propertyId);
    if (!rootId) return null;

    const result = await db.query(
      `
        SELECT id, parent_id, name, description, meta, faqs, offers, highlights, features, message, message_1, links, connect_details, source_link, source_details, location
        FROM inventories
        WHERE id = $1 OR parent_id = $1
        ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, id
      `,
      [rootId]
    );
    if (result.rows.length === 0) return null;

    const rows = result.rows as RawInventoryRow[];
    const row =
      rows.find((r) => r.parent_id == null || String(r.id) === rootId) ??
      rows[0];
    const meta = safeParseJson(row.meta);
    const metaObject = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};

    const description = extractDescription(row.description);
    const faqs = extractFaqPairs(row.faqs ?? metaObject.faqs ?? metaObject.faq ?? metaObject.questions).join('\n');
    const houseRules = [
      ...extractStringArray(metaObject.house_rules ?? metaObject.houseRules ?? metaObject.rules),
      ...extractPolicyLikeLines(row.message, row.message_1),
    ].join('\n');
    const cancellationPolicy = normalizeMaybeString(
      metaObject.cancellation_policy ?? metaObject.cancellationPolicy
    );
    const amenitiesFromMeta = extractStringArray(
      metaObject.amenities_blurbs ?? metaObject.amenitiesBlurbs ?? metaObject.amenities
    );
    const amenitiesFromFeatures = extractFeatureNames(row.features);
    const amenitiesFromHighlights = extractStringArray(row.highlights);
    const amenitiesBlurbs = [...amenitiesFromMeta, ...amenitiesFromFeatures, ...amenitiesFromHighlights].join('\n');
    const other = [
      ...extractStringArray(row.offers),
      ...extractStringArray(row.links),
      ...extractStringArray(row.connect_details),
    ].join('\n');

    const policyFromFaqs = faqs
      .split('\n')
      .filter((line) =>
        /(policy|cancel|cancellation|deposit|guarantor|booking|refund|tenancy|lease|rule)/i.test(line)
      );
    const policyFromMessage = extractPolicyLikeLines(row.message, row.message_1);
    const baselinePolicies = [
      ...extractStringArray(metaObject.house_rules ?? metaObject.houseRules ?? metaObject.rules),
      ...extractStringArray(metaObject.cancellation_policy ?? metaObject.cancellationPolicy),
      ...policyFromFaqs,
      ...policyFromMessage,
    ].filter(Boolean);
    const baselineFaqs = extractFaqPairs(row.faqs ?? metaObject.faqs ?? metaObject.faq ?? metaObject.questions);
    const baselineAmenities = [...amenitiesFromMeta, ...amenitiesFromFeatures, ...amenitiesFromHighlights].filter(
      Boolean
    );

    // `source_link` is canonical in inventories. Resolve from root + config rows
    // because some properties store source URLs on child inventories.
    const sourceLinkUrls = dedupeUrls(
      rows.flatMap((r) => extractUrlsFromGenericField(r.source_link))
    );
    // Do NOT domain-filter source_link: if DB has a valid URL we should use it.
    const pmgSourceUrl = sourceLinkUrls[0] || null;
    const referenceUrls = dedupeUrls([
      ...sourceLinkUrls,
      ...rows.flatMap((r) => extractUrlsFromMeta(r.meta)),
      ...rows.flatMap((r) => extractUrlsFromGenericField(r.links)),
      ...rows.flatMap((r) => extractUrlsFromGenericField(r.connect_details)),
      ...rows.flatMap((r) => extractUrlsFromGenericField(r.source_details)),
      ...rows.flatMap((r) => extractUrlsFromGenericField(r.description)),
    ]);

    return {
      propertyId: String(row.id),
      propertyName: row.name || 'Unnamed Property',
      sections: {
        description,
        faqs,
        house_rules: houseRules,
        cancellation_policy: cancellationPolicy,
        amenities_blurbs: amenitiesBlurbs,
        other,
      },
      pmgSourceUrl,
      referenceUrls,
      structuredBaseline: {
        amenities: baselineAmenities,
        policies: baselinePolicies,
        faqs: baselineFaqs,
      },
    };
  }
}
