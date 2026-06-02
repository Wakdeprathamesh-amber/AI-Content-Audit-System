import { Router, Request, Response } from 'express';
import { PropertyDataReaderDB } from '../services/PropertyDataReaderDB';
import { ImageAuditClient } from '../services/ImageAuditClient';
import { AuditResultWriter } from '../services/AuditResultWriter';
import { GoogleSheetsWriter } from '../services/GoogleSheetsWriter';
import { AuditJobQueue } from '../services/AuditJobQueue';
import { ExecutionEngine } from '../services/ExecutionEngine';
import { AuditOptions, AuditType, TextCheckType } from '../../../shared/types';
import { config } from '../config';

const router = Router();

const propertyReader = new PropertyDataReaderDB();
const imageAuditClient = new ImageAuditClient();
const resultWriter = new AuditResultWriter(config.auditResultsDir);

let sheetsWriter: GoogleSheetsWriter | undefined;
if (config.outputMode === 'sheets' || config.outputMode === 'both') {
  if (config.googleSheets.spreadsheetId) {
    try {
      sheetsWriter = new GoogleSheetsWriter(config.googleSheets.spreadsheetId);
      console.log('✅ Google Sheets writer initialized');
      void sheetsWriter
        .initializeSheets()
        .then(() => console.log('✅ Google Sheets tabs verified'))
        .catch((error: any) => console.error('⚠️  Failed to initialize Google Sheets tabs:', error.message));
    } catch (error: any) {
      console.error('⚠️  Failed to initialize Google Sheets writer:', error.message);
    }
  } else {
    console.warn(
      '⚠️  Google Sheets output enabled but GOOGLE_SHEETS_SPREADSHEET_ID not configured'
    );
  }
}

// Use updated execution engine with parallel processing
const executionEngine = new ExecutionEngine(
  propertyReader,
  imageAuditClient,
  resultWriter,
  sheetsWriter
);
const auditQueue = new AuditJobQueue((propertyId, options) =>
  executionEngine.executeSingleAudit(propertyId, options)
);

const DEFAULT_MEDIA_CHECKS: Array<'quality' | 'watermark' | 'category'> = [
  'quality',
  'watermark',
  'category',
];
const VALID_MEDIA_CHECKS = new Set(DEFAULT_MEDIA_CHECKS);
const DEFAULT_TEXT_CHECKS: TextCheckType[] = ['extraction', 'fact_check'];
const VALID_TEXT_CHECKS = new Set<TextCheckType>([
  'extraction',
  'fact_check',
  'missing_info',
  'cross_field_consistency',
  'duplicate_property',
]);

function errorMessageForClient(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Internal server error';
  return config.nodeEnv === 'production' ? 'Internal server error' : message;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /not found/i.test(error.message);
}

/** Distinct from "not found" — the row exists but isn't eligible for audit. */
function isNotActiveError(error: unknown): error is Error & { code: string; propertyStatus?: string } {
  return (
    error instanceof Error &&
    typeof (error as any).code === 'string' &&
    (error as any).code === 'PROPERTY_NOT_ACTIVE'
  );
}

/**
 * POST /api/v1/audits/single
 * Run audit on a single property
 */
router.post('/single', async (req: Request, res: Response) => {
  try {
    const { propertyId: rawPropertyId, checks, textChecks, auditType: rawAuditType, runAsync } = req.body ?? {};

    // Validate propertyId: must be a non-empty string, reasonable length, safe chars.
    if (typeof rawPropertyId !== 'string') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'propertyId is required and must be a string',
        timestamp: new Date().toISOString(),
      });
    }
    const propertyId = rawPropertyId.trim();
    if (propertyId.length === 0 || propertyId.length > 64) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'propertyId must be 1–64 characters',
        timestamp: new Date().toISOString(),
      });
    }
    // Allow alphanumeric, dash, underscore. Anything else is suspicious.
    if (!/^[A-Za-z0-9_-]+$/.test(propertyId)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'propertyId contains invalid characters',
        timestamp: new Date().toISOString(),
      });
    }

    if (checks !== undefined && !Array.isArray(checks)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'checks must be an array',
        timestamp: new Date().toISOString(),
      });
    }

    if (textChecks !== undefined && !Array.isArray(textChecks)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'textChecks must be an array',
        timestamp: new Date().toISOString(),
      });
    }

    const validAuditTypes: AuditType[] = ['media', 'text', 'both'];
    const auditType: AuditType =
      typeof rawAuditType === 'string' ? (rawAuditType.trim().toLowerCase() as AuditType) : 'media';

    if (!validAuditTypes.includes(auditType)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `Invalid auditType: ${rawAuditType}. Valid values are: ${validAuditTypes.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
    }

    if (checks !== undefined && checks.some((c: unknown) => typeof c !== 'string')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'checks must contain only strings',
        timestamp: new Date().toISOString(),
      });
    }

    if (textChecks !== undefined && textChecks.some((c: unknown) => typeof c !== 'string')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'textChecks must contain only strings',
        timestamp: new Date().toISOString(),
      });
    }

    const normalizedChecks = Array.isArray(checks)
      ? checks.map((c) => String(c).trim().toLowerCase() as 'quality' | 'watermark' | 'category')
      : undefined;
    const normalizedTextChecks = Array.isArray(textChecks)
      ? textChecks.map((c) => String(c).trim().toLowerCase() as TextCheckType)
      : undefined;

    if ((auditType === 'media' || auditType === 'both') && normalizedChecks && normalizedChecks.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'checks must include at least one media check for this auditType',
        timestamp: new Date().toISOString(),
      });
    }

    if ((auditType === 'text' || auditType === 'both') && normalizedTextChecks && normalizedTextChecks.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'textChecks must include at least one text check for this auditType',
        timestamp: new Date().toISOString(),
      });
    }

    if (normalizedChecks) {
      const invalidChecks = normalizedChecks.filter((c) => !VALID_MEDIA_CHECKS.has(c as any));
      if (invalidChecks.length > 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Invalid checks: ${invalidChecks.join(', ')}. Valid checks are: ${DEFAULT_MEDIA_CHECKS.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (normalizedTextChecks) {
      const invalidTextChecks = normalizedTextChecks.filter((c) => !VALID_TEXT_CHECKS.has(c));
      if (invalidTextChecks.length > 0) {
        return res.status(400).json({
          error: 'Bad Request',
          message: `Invalid textChecks: ${invalidTextChecks.join(', ')}. Valid text checks are: ${Array.from(VALID_TEXT_CHECKS).join(', ')}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    console.log(`Received ${auditType} audit request for property: ${propertyId}`);

    const options: AuditOptions = {
      auditType,
      checks: normalizedChecks || DEFAULT_MEDIA_CHECKS,
      textChecks: normalizedTextChecks || DEFAULT_TEXT_CHECKS,
    };

    const shouldQueue = config.executionMode === 'queue' || runAsync === true;
    if (shouldQueue) {
      const job = auditQueue.enqueue(propertyId, options);
      return res.status(202).json({
        jobId: job.jobId,
        status: job.status,
        propertyId: job.propertyId,
        createdAt: job.createdAt,
        pollUrl: `/api/v1/audits/jobs/${job.jobId}`,
      });
    }

    const result = await executionEngine.executeSingleAudit(propertyId, options);

    // Return result directly (not wrapped)
    res.status(200).json(result);
  } catch (error: any) {
    console.error('Error in single property audit:', error);

    if (isNotFoundError(error)) {
      return res.status(404).json({
        error: 'Not Found',
        message: error instanceof Error ? error.message : 'Resource not found',
        timestamp: new Date().toISOString(),
      });
    }

    if (isNotActiveError(error)) {
      return res.status(422).json({
        error: 'Unprocessable Entity',
        code: 'PROPERTY_NOT_ACTIVE',
        propertyStatus: error.propertyStatus,
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: errorMessageForClient(error),
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/v1/audits/jobs/:jobId
 * Get status of an async queued single-property audit
 */
router.get('/jobs/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  if (!jobId || !/^[A-Za-z0-9-]{8,100}$/.test(jobId)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'jobId contains invalid characters',
      timestamp: new Date().toISOString(),
    });
  }
  const job = auditQueue.getJob(jobId);
  if (!job) {
    return res.status(404).json({
      error: 'Not Found',
      message: `Job not found: ${jobId}`,
      timestamp: new Date().toISOString(),
    });
  }
  return res.status(200).json(job);
});

/**
 * GET /api/v1/audits/:auditId
 * Get audit result by ID from filesystem results
 */
router.get('/:auditId', async (req: Request, res: Response) => {
  try {
    const { auditId } = req.params;
    if (!auditId || !/^[A-Za-z0-9-]{8,100}$/.test(auditId)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'auditId contains invalid characters',
        timestamp: new Date().toISOString(),
      });
    }
    const result = await resultWriter.getAuditById(auditId);
    if (!result) {
      return res.status(404).json({
        error: 'Not Found',
        message: `Audit not found: ${auditId}`,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching audit by ID:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: errorMessageForClient(error),
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
