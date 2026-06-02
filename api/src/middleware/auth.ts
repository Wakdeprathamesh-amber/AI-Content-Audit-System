import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * API-key authentication.
 *
 * - When config.apiKey is empty, auth is disabled (local dev only).
 * - Otherwise every request must carry `x-api-key: <key>`.
 *
 * Uses a constant-time comparison to avoid timing oracles.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * True when the request comes from this service's own bundled dashboard, i.e.
 * the browser Origin matches the request host. The dashboard is served by this
 * same process and has no key to send, so it is treated as same-origin and
 * allowed. (CORS — browser-enforced — is the boundary that actually stops other
 * sites; the API key protects non-browser/cross-origin callers.)
 */
function isSameOriginBrowser(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin) return false;
  const host = req.header('x-forwarded-host') ?? req.header('host');
  if (!host) return false;
  return origin === `https://${host}` || origin === `http://${host}`;
}

let warnedNoKey = false;

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.apiKey;

  // No key configured: allow, but warn loudly in production. (We do NOT fail
  // closed: the bundled dashboard has no key-provisioning flow, so failing
  // closed would just brick the UI. Set API_KEY to require a key.)
  if (!expected) {
    if (config.nodeEnv === 'production' && !warnedNoKey) {
      warnedNoKey = true;
      console.warn(
        '[auth] API_KEY is not set — /api/v1 is UNAUTHENTICATED. Set API_KEY (same value on the image module) to require x-api-key for external callers.'
      );
    }
    next();
    return;
  }

  // Key configured. The bundled same-origin dashboard is allowed without a key;
  // every other caller must present a valid x-api-key.
  if (isSameOriginBrowser(req)) {
    next();
    return;
  }

  const provided = req.header('x-api-key') ?? '';
  if (!provided || !constantTimeEqual(provided, expected)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid x-api-key header',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}
