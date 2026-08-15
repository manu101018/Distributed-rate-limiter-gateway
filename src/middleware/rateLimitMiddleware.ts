import type { Request, Response, NextFunction } from 'express';
import { matchRoute } from '../config/loadConfig';
import type { RateLimiterFactory } from '../algorithms/RateLimiterFactory';
import type { KeyByStrategy } from '../types/limits';
import {
  requestsTotal,
  redisCheckDuration,
  requestDuration,
  inFlightRequests,
} from '../metrics/metrics';
import {
  recordRequest,
  recordRedisCheckMs,
  recordRequestDurationMs,
  type RequestOutcome,
} from '../metrics/snapshot';

function resolveIdentityKey(req: Request, keyBy: KeyByStrategy): string {
  if (keyBy === 'apiKey') {
    const apiKey = req.headers['x-api-key'];
    return apiKey ? `key:${apiKey}` : `ip:${req.ip}`;
  }
  return `ip:${req.ip}`;
}

function elapsedMs(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

let lastFailOpenLogAt = 0;
let failOpenSinceLog = 0;

function logFailOpen(err: unknown): void {
  failOpenSinceLog += 1;
  const now = Date.now();
  if (now - lastFailOpenLogAt < 2000) {
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[rate-limit] Redis unavailable, failing open (${failOpenSinceLog} request(s)): ${message}`
  );
  lastFailOpenLogAt = now;
  failOpenSinceLog = 0;
}

/**
 * Takes a RateLimiterFactory so the middleware never instantiates a
 * concrete algorithm class itself -- it only ever asks the factory for
 * "whatever algorithm this route wants".
 */
export function createRateLimitMiddleware(factory: RateLimiterFactory) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const rule = matchRoute(req.path);

    if (!rule) {
      next();
      return;
    }

    const requestStart = process.hrtime.bigint();
    let outcome: RequestOutcome = 'allowed';
    inFlightRequests.inc();

    res.on('finish', () => {
      inFlightRequests.dec();
      const ms = elapsedMs(requestStart);
      recordRequestDurationMs(ms);
      requestDuration.observe({ route: rule.path, outcome }, ms / 1000);
    });

    const checkStart = process.hrtime.bigint();

    try {
      if (!factory.isRedisReady()) {
        throw new Error('Redis is not ready');
      }

      const limiter = factory.getLimiter(rule.algorithm);
      const identityKey = resolveIdentityKey(req, rule.keyBy);
      const rateLimitKey = `${identityKey}:${rule.path}`;

      const result = await limiter.checkLimit(rateLimitKey, rule);

      const checkMs = elapsedMs(checkStart);
      recordRedisCheckMs(checkMs);
      redisCheckDuration.observe({ algorithm: rule.algorithm }, checkMs / 1000);

      res.set('X-RateLimit-Algorithm', rule.algorithm);
      res.set('X-RateLimit-Remaining', String(result.remaining));
      if (result.resetAt) {
        res.set('X-RateLimit-Reset', String(result.resetAt));
      }

      if (!result.allowed) {
        outcome = 'denied';
        recordRequest('denied');
        requestsTotal.inc({ route: rule.path, algorithm: rule.algorithm, outcome: 'denied' });
        res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
        res.status(429).json({
          error: 'Too Many Requests',
          algorithm: rule.algorithm,
          retryAfterMs: result.retryAfterMs,
        });
        return;
      }

      recordRequest('allowed');
      requestsTotal.inc({ route: rule.path, algorithm: rule.algorithm, outcome: 'allowed' });
      next();
    } catch (err) {
      const checkMs = elapsedMs(checkStart);
      recordRedisCheckMs(checkMs);
      redisCheckDuration.observe({ algorithm: rule.algorithm }, checkMs / 1000);

      // Fail-open: if Redis is down, log it and let the request through
      // rather than taking the whole API down with it. Fail-closed is the
      // stricter alternative -- worth documenting as a deliberate tradeoff.
      outcome = 'fail_open';
      recordRequest('fail_open');
      requestsTotal.inc({ route: rule.path, algorithm: rule.algorithm, outcome: 'fail_open' });
      logFailOpen(err);
      next();
    }
  };
}
