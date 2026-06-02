/**
 * Centralised, validated configuration.
 *
 * One place to read process.env. Anything else that reads env directly should
 * be migrated here so the System Rules sheet, the .env.example, and the actual
 * runtime values cannot drift apart.
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Load .env from repo root exactly once. __dirname differs between dev
// (src/config) and the compiled build (dist/api/src/config), so probe the
// known candidate locations and load the first that exists. On Render no .env
// file is present — env vars are injected by the platform — so the final
// fallback is a harmless no-op.
const envCandidates = [
  path.resolve(__dirname, '../../../.env'), // dev: src/config -> repo root
  path.resolve(__dirname, '../../../../../.env'), // build: dist/api/src/config -> repo root
  path.resolve(process.cwd(), '../.env'), // cwd = api/
  path.resolve(process.cwd(), '.env'),
];
const envPath = envCandidates.find((p) => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isNaN(v)) {
    throw new Error(`Invalid number for env ${key}: ${raw}`);
  }
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw.toLowerCase());
}

function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function strOrEmpty(key: string): string {
  return process.env[key] ?? '';
}

function csv(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DEFAULTS = {
  performance: {
    parallelImageBatchSize: 4,
    cacheEnabled: true,
    cacheTtlSeconds: 30 * 24 * 60 * 60,
  },
  thresholds: {
    minResolutionWidth: 800,
    minResolutionHeight: 800,
    recommendedResolutionWidth: 1920,
    recommendedResolutionHeight: 1080,
    blur: 100,
    sharpness: 50,
    duplicateSimilarity: 95,
    categoryConfidence: 70,
    watermarkConfidence: 85,
  },
} as const;

export const config = {
  // Servers
  // Render injects PORT; local/dev can keep using API_PORT.
  apiPort: num('PORT', num('API_PORT', 3000)),
  imageModuleUrl: str('IMAGE_MODULE_URL', 'http://localhost:8000'),

  // Database
  db: {
    host: strOrEmpty('AMBER_DB_HOST'),
    port: num('AMBER_DB_PORT', 5439),
    database: strOrEmpty('AMBER_DB_NAME'),
    user: strOrEmpty('AMBER_DB_USER'),
    password: strOrEmpty('AMBER_DB_PASSWORD'),
    maxConnections: num('DB_MAX_CONNECTIONS', 20),
    idleTimeoutMs: num('DB_IDLE_TIMEOUT', 30000),
    connectionTimeoutMs: num('DB_CONNECTION_TIMEOUT', 10000),
    // Set this to true (or wire a CA bundle) before production.
    sslRejectUnauthorized: bool('DB_SSL_REJECT_UNAUTHORIZED', false),
  },

  // Output
  outputMode: (str('OUTPUT_MODE', 'sheets') as 'database' | 'sheets' | 'both'),
  auditResultsDir: str('AUDIT_RESULTS_DIR', './audit-results'),
  googleSheets: {
    spreadsheetId: strOrEmpty('GOOGLE_SHEETS_SPREADSHEET_ID'),
    credentialsPath: strOrEmpty('GOOGLE_SHEETS_CREDENTIALS_PATH'),
  },

  // Performance
  parallelImageBatchSize: DEFAULTS.performance.parallelImageBatchSize,
  safeModeEnabled: bool('SAFE_MODE_ENABLED', false),
  safeParallelImageBatchSize: num('SAFE_PARALLEL_IMAGE_BATCH_SIZE', 1),
  largePropertyImageCount: num('LARGE_PROPERTY_IMAGE_COUNT', 20),
  largePropertyBatchSize: num('LARGE_PROPERTY_BATCH_SIZE', 2),
  cacheEnabled: DEFAULTS.performance.cacheEnabled,
  cacheTtlSeconds: DEFAULTS.performance.cacheTtlSeconds,
  imageRequestStaggerMs: num('IMAGE_REQUEST_STAGGER_MS', 150),
  imageBatchDelayMs: num('IMAGE_BATCH_DELAY_MS', 700),
  safeImageRequestStaggerMs: num('SAFE_IMAGE_REQUEST_STAGGER_MS', 250),
  safeImageBatchDelayMs: num('SAFE_IMAGE_BATCH_DELAY_MS', 1200),
  executionMode: (str('AUDIT_EXECUTION_MODE', 'sync') as 'sync' | 'queue'),
  imageClient: {
    timeoutMs: num('IMAGE_CLIENT_TIMEOUT_MS', 30000),
    maxRetries: num('IMAGE_CLIENT_MAX_RETRIES', 3),
    baseRetryDelayMs: num('IMAGE_CLIENT_BASE_RETRY_DELAY_MS', 1000),
    maxRetryDelayMs: num('IMAGE_CLIENT_MAX_RETRY_DELAY_MS', 12000),
    jitterMs: num('IMAGE_CLIENT_RETRY_JITTER_MS', 300),
  },

  // Thresholds — single source of truth for code AND docs sheet.
  thresholds: {
    minResolutionWidth: DEFAULTS.thresholds.minResolutionWidth,
    minResolutionHeight: DEFAULTS.thresholds.minResolutionHeight,
    recommendedResolutionWidth: DEFAULTS.thresholds.recommendedResolutionWidth,
    recommendedResolutionHeight: DEFAULTS.thresholds.recommendedResolutionHeight,
    blur: DEFAULTS.thresholds.blur,
    sharpness: DEFAULTS.thresholds.sharpness,
    duplicateSimilarity: DEFAULTS.thresholds.duplicateSimilarity,
    categoryConfidence: DEFAULTS.thresholds.categoryConfidence,
    watermarkConfidence: DEFAULTS.thresholds.watermarkConfidence,
  },

  // Security
  apiKey: strOrEmpty('API_KEY'),
  corsAllowedOrigins: csv('CORS_ALLOWED_ORIGINS', ['http://localhost:3000']),
  rateLimit: {
    windowMs: num('RATE_LIMIT_WINDOW_MS', 60_000),
    max: num('RATE_LIMIT_MAX', 30),
  },

  // Text QC
  textQc: {
    extractionModel: str('TEXT_QC_EXTRACTION_MODEL', 'gpt-4o-mini'),
    factCheckModel: str('TEXT_QC_FACTCHECK_MODEL', 'gpt-4o-mini'),
    // Internal-consistency reasoning benefits from a stronger model; defaults to
    // the extraction model so a single override (or none) keeps everything aligned.
    consistencyModel: str('TEXT_QC_CONSISTENCY_MODEL', str('TEXT_QC_EXTRACTION_MODEL', 'gpt-4o-mini')),
    pmgAllowedDomains: csv('TEXT_QC_PMG_ALLOWED_DOMAINS', ['wearehomesforstudents.com']),
    /** Max plain-text chars from fetched PMG page passed to fact-check LLM. */
    pmgPageMaxChars: num('TEXT_QC_PMG_PAGE_MAX_CHARS', 12_000),
    pmgFetchTimeoutMs: num('TEXT_QC_PMG_FETCH_TIMEOUT_MS', 15_000),
    factCheckTimeoutMs: num('TEXT_QC_FACTCHECK_TIMEOUT_MS', 8000),
    factCheckClaimBatchSize: num('TEXT_QC_FACTCHECK_CLAIM_BATCH_SIZE', 12),
    factCheckBatchDelayMs: num('TEXT_QC_FACTCHECK_BATCH_DELAY_MS', 400),
    openAiMinIntervalMs: num('TEXT_QC_OPENAI_MIN_INTERVAL_MS', 300),
    verificationConfidence: {
      verified: num('TEXT_QC_CONF_VERIFIED', 0.85),
      likely: num('TEXT_QC_CONF_LIKELY', 0.7),
      conflict: num('TEXT_QC_CONF_CONFLICT', 0.8),
      unknown: num('TEXT_QC_CONF_UNKNOWN', 0.4),
    },
    // Precision-first output caps (quality over quantity — never pad findings).
    maxMissingInfo: num('TEXT_QC_MAX_MISSING_INFO', 8),
    maxConsistencyFindings: num('TEXT_QC_MAX_CONSISTENCY_FINDINGS', 10),
    // Deterministic plausibility thresholds (no LLM).
    plausibility: {
      // Above this implied speed, a "walk" claim is physically impossible.
      walkSpeedMaxKmh: num('TEXT_QC_WALK_SPEED_MAX_KMH', 7),
      // "nearby/walkable" language attached to a distance beyond this is implausible.
      nearbyMaxKm: num('TEXT_QC_NEARBY_MAX_KM', 2.0),
    },
  },

  // Misc
  nodeEnv: str('NODE_ENV', 'development'),
  logLevel: str('LOG_LEVEL', 'info'),
} as const;

export type AppConfig = typeof config;
