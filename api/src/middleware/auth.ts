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

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.apiKey;

  // Disabled in local dev when no key is set.
  if (!expected) {
    if (config.nodeEnv === 'production') {
      // Fail closed in production rather than silently allowing all traffic.
      res.status(503).json({
        error: 'Service Unavailable',
        message: 'API_KEY must be configured in production',
        timestamp: new Date().toISOString(),
      });
      return;
    }
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
