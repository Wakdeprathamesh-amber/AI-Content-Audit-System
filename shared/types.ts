// Shared TypeScript types for AI Content Audit System

export interface Property {
  property_id: string;
  property_name: string;
  /** Human-readable location string (locality, secondary, or primary). */
  location: string;
  /** City name from the location JSON (e.g. "Sacramento"). */
  city?: string | null;
  /** Country name from the location JSON (e.g. "United States"). */
  country?: string | null;
  /** Administrative region/state from the location JSON (e.g. "California"). */
  region?: string | null;
  /** Reference URL stored on the inventory row (source_link), if present. */
  source_url?: string | null;
  /** Amber's customer-facing URL, built from canonical_name. */
  amber_url?: string | null;
  /** Slug stored on the inventory row (used to build the Amber URL). */
  canonical_name?: string | null;
  property_type: string;
  /**
   * Lifecycle flag on the inventory row. Content QC only audits properties
   * whose status is `'active'`; the data layer still returns the row truthfully
   * so the ExecutionEngine can surface a clear "not active" error.
   */
  status: 'active' | 'inactive' | 'draft' | 'deleted';
  bedrooms?: number;
  bathrooms?: number;
  square_feet?: number;
  description?: string;
}

/**
 * All upstream signals present on a `inventories.images[]` object. Stored
 * upstream as strings ("true"/"false"); we coerce to booleans on read.
 * These are diagnostic inputs only — the audit re-verifies everything and
 * surfaces upstream values for comparison, never as a shortcut.
 */
export type InventoryLevel = 'property' | 'config';

export interface PropertyImage {
  image_id: string;
  /** Root property inventory id (parent row). */
  property_id: string;
  image_url: string;
  /** inventories.id that owns this image row (property or config). */
  source_inventory_id: string;
  /** property = building/shared media; config = unit-type child inventory. */
  level: InventoryLevel;
  /** Config inventory name when level === 'config'. */
  config_name?: string;
  /** From inventories.images[].type (lowercase_underscore in DB). */
  category?: string;
  uploaded_at?: string;
  is_featured?: boolean;
  upstream_blurred?: boolean | null;
  upstream_watermark_present?: boolean | null;
  upstream_watermark_text?: string | null;
  /** Upstream's opt-out flag. We acknowledge it for the sheet but ignore for analysis. */
  ignore_ai_analysis?: boolean;
}

export interface ImageQualityResult {
  resolution: {
    width: number;
    height: number;
  };
  width: number;
  height: number;
  megapixels: number;
  format?: string | null;          // wire format: 'JPEG' | 'PNG' | 'WEBP' | 'AVIF' | 'GIF' | ...
  file_size_bytes?: number | null; // bytes served by the CDN
  blur: number;
  sharpness: number;
  passed: boolean;
}

export interface WatermarkResult {
  detected: boolean;
  confidence: number;
  text?: string;
  reasoning?: string;
  /**
   * Whether this result came from a best-effort fallback because model analysis
   * failed/unavailable. Useful for surfacing degraded runs to operators.
   */
  degraded?: boolean;
}

export interface CategoryResult {
  primary: string;
  confidence: number;
  alternatives?: string[];
  existing_tag?: string | null;
  is_tag_correct?: boolean | null;
  suggested_correction?: string | null;
  reasoning?: string | null;
  degraded?: boolean;
}

/**
 * Upstream signals carried forward onto the audit result so the sheet can
 * compare what upstream said vs what our audit says — diagnostic only.
 */
export interface UpstreamSignals {
  tag?: string | null;
  blurred?: boolean | null;
  watermarkPresent?: boolean | null;
  watermarkText?: string | null;
  isFeatured?: boolean;
  ignoreAiAnalysis?: boolean;
}

export interface ImageAnalysisResult {
  imageId: string;
  imageUrl: string;
  imageHash?: string;  // Perceptual hash for duplicate detection
  sourceInventoryId?: string;
  sourceLevel?: InventoryLevel;
  configName?: string;
  quality?: ImageQualityResult;
  watermark?: WatermarkResult;
  category?: CategoryResult;
  isDuplicate?: boolean;  // Is this a duplicate image?
  duplicateOf?: string;  // ID of the original image
  similarity?: number;  // Similarity percentage (0-100)
  upstream?: UpstreamSignals;
}

export interface AuditIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  description: string;
  recommendation?: string;
  imageId?: string;
}

export interface AuditSummary {
  totalImages: number;
  criticalIssues: number;
  warnings: number;
  passedImages: number;
  mediaAttempted?: number;
  mediaAnalyzed?: number;
  mediaFailed?: number;
  textClaims?: number;
}

export type AuditType = 'media' | 'text' | 'both';

export type TextCheckType =
  | 'extraction'
  | 'fact_check'
  | 'missing_info'
  | 'cross_field_consistency'
  | 'duplicate_property';

export type TextClaimType =
  | 'rent'
  | 'deposit'
  | 'distance'
  | 'room_size'
  | 'offer'
  | 'amenity'
  | 'policy_term'
  | 'cancellation_term'
  | 'house_rule'
  | 'faq'
  | 'other';

export type TextSectionName =
  | 'description'
  | 'faqs'
  | 'house_rules'
  | 'cancellation_policy'
  | 'amenities_blurbs'
  | 'other';

export type TextVerificationStatus =
  | 'verified'
  | 'conflict'
  | 'missing_evidence'
  | 'not_found'
  | 'unknown';

export interface TextClaim {
  claimId: string;
  claimType: TextClaimType;
  claimLabel: string;
  claimValue: string;
  normalizedValue?: string | null;
  unit?: string | null;
  sourceSection: TextSectionName;
  sourceText: string;
}

export interface TextEvidenceSource {
  type: 'pmg_db_url' | 'none';
  url?: string | null;
  snippet?: string | null;
}

export interface TextFactCheckResult {
  claimId: string;
  status: TextVerificationStatus;
  confidence: number;
  evidenceUrl?: string | null;
  evidenceSnippet?: string | null;
  checkedAt: string;
  source: 'pmg' | 'none';
  /** How PMG evidence was obtained for this fact-check run. */
  verificationMode?: 'pmg_db' | 'no_url' | 'fetch_failed';
  evidenceSource?: TextEvidenceSource;
  notes?: string | null;
}

export interface TextMissingInformation {
  section: TextSectionName;
  item: string;
  reason: string;
  severity: 'warning' | 'info';
}

export interface TextExtractionResult {
  claims: TextClaim[];
  missingInformation?: TextMissingInformation[];
  model: string;
  extractedAt: string;
}

export type TextIssueCategory =
  | 'fact_conflict'
  | 'missing_info'
  | 'consistency'
  | 'duplicate_property'
  | 'general'
  // Evidence-free internal-audit findings (no external source required):
  | 'internal_contradiction' // two statements in the listing disagree
  | 'room_type_mismatch' // a room type is described with features inconsistent with that type
  | 'impossible_feature' // a feature claim that is physically/logically impossible as stated
  | 'implausible_value'; // a quantitative claim fails a deterministic plausibility check

export interface TextIssue {
  severity: 'critical' | 'warning' | 'info';
  category: TextIssueCategory;
  description: string;
  recommendation?: string;
  diffType?: 'missing_in_structured' | 'extra_in_structured' | 'new_candidate_term';
  claimId?: string;
  sourceSection?: TextSectionName;
}

export interface TextAuditSummary {
  totalClaims: number;
  verifiedClaims: number;
  conflictingClaims: number;
  missingEvidenceClaims: number;
  missingFields: number;
  score: number;
}

export interface TextAuditResult {
  extraction: TextExtractionResult;
  factChecks: TextFactCheckResult[];
  issues: TextIssue[];
  summary: TextAuditSummary;
}

/**
 * Hero-image audit. Current hero is what the property is showing on the
 * search page TODAY (sourced from inventories.images[].featured, with a
 * positional fallback to images[0]). Recommended is what we think it should
 * be based on the in-audit technical scores.
 */
export interface HeroAudit {
  currentHeroImageId: string | null;
  currentHeroUrl: string | null;
  /**
   * How the current hero was identified:
   * - featured_flag: featured=true in the audited scope
   * - config_featured_fallback: property scope had no featured, so used a config featured image
   * - position_0_fallback: no featured signal found, used first image
   */
  currentHeroSource: 'featured_flag' | 'config_featured_fallback' | 'position_0_fallback' | 'none';
  /** Upstream images[].type on the current hero (if any). */
  currentHeroCategory?: string | null;
  recommendedHeroImageId: string | null;
  recommendedHeroUrl: string | null;
  /** Technical hero-score we gave the recommendation (0–100). */
  recommendedHeroScore: number | null;
  /** What QA should do — 'ok' when current == recommended. */
  action: 'ok' | 'swap' | 'no_bedroom' | 'no_images' | 'featured_not_bedroom';
  reason: string;
}

/** Per unit-type (config inventory) featured / hero — same rules as property hero. */
export interface ConfigHeroAudit {
  sourceInventoryId: string;
  configName: string;
  currentHeroImageId: string | null;
  currentHeroUrl: string | null;
  currentHeroSource: 'featured_flag' | 'config_featured_fallback' | 'position_0_fallback' | 'none';
  currentHeroCategory?: string | null;
  recommendedHeroImageId: string | null;
  recommendedHeroUrl: string | null;
  recommendedHeroScore: number | null;
  action: 'ok' | 'swap' | 'no_bedroom' | 'no_images' | 'featured_not_bedroom';
  reason: string;
}

/**
 * Geographic + reference-URL context for the audited property — surfaced into
 * the AuditResult so downstream consumers (Sheets, JSON dumps) can navigate
 * back to the source listing without re-querying the DB.
 */
export interface PropertyMeta {
  /** Reference URL stored on the inventory row (source_link). */
  url: string | null;
  /** Amber's customer-facing URL, deterministically built from canonical_name. */
  amberUrl: string | null;
  city: string | null;
  country: string | null;
  region: string | null;
}

export interface AuditResult {
  auditId: string;
  timestamp: string;
  propertyId: string;
  propertyName: string;
  propertyMeta?: PropertyMeta;
  auditType?: AuditType;
  qualityScore: number;
  imageResults: ImageAnalysisResult[];
  issues: AuditIssue[];
  summary: AuditSummary;
  scoreBreakdown?: {
    mediaScore: number | null;
    textScore: number | null;
    combinedScore: number;
    mediaWeight: number;
    textWeight: number;
  };
  hero?: HeroAudit;
  configHeroes?: ConfigHeroAudit[];
  textResults?: TextAuditResult;
}

export interface AuditOptions {
  auditType?: AuditType;
  checks?: ('quality' | 'watermark' | 'category')[];
  textChecks?: TextCheckType[];
  includeImages?: boolean;
}

export interface BulkAuditJob {
  jobId: string;
  totalProperties: number;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

export interface BulkAuditStatus {
  jobId: string;
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  estimatedTimeRemaining?: number;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
}

export interface BulkAuditSummary {
  jobId: string;
  totalProperties: number;
  averageQualityScore: number;
  totalIssues: number;
  issueBreakdown: {
    critical: number;
    warning: number;
    info: number;
  };
  results: Array<{
    propertyId: string;
    propertyName: string;
    qualityScore: number;
    criticalIssues: number;
    warnings: number;
  }>;
}

export interface PropertyFilters {
  location?: string;
  property_type?: string;
  status?: string;
}
