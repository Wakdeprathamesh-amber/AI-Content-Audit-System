import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Tiny per-IP fixed-window rate limiter.
 *
 * Avoids a runtime dependency by using a Map. Fine for a single-process Node
 * service; if we ever scale horizontally, swap for Redis (e.g. rate-limiter-flexible).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function keyOf(req: Request): string {
  // x-forwarded-for first (load balancer), then socket
  const fwd = req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const k = keyOf(req);
  const bucket = buckets.get(k);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(k, { count: 1, resetAt: now + config.rateLimit.windowMs });
    next();
    return;
  }

  bucket.count += 1;
  if (bucket.count > config.rateLimit.max) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${retryAfterSec}s.`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  next();
}

/**
 * Internal helper for tests. Resets all buckets.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
