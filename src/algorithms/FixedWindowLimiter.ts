import fs from 'fs';
import path from 'path';
import type Redis from 'ioredis';
import { RateLimiterStrategy } from './RateLimiterStrategy';
import type { RouteRule, CheckLimitResult } from '../types/limits';

const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'fixedWindow.lua'), 'utf8');

/**
 * Simple, cheap, and slightly bursty at window boundaries. Good default for
 * coarse, low-stakes limits.
 */
export class FixedWindowLimiter extends RateLimiterStrategy {
  constructor(redis: Redis) {
    super(redis);
    this.redis.defineCommand('fixedWindowCheck', {
      numberOfKeys: 1,
      lua: SCRIPT,
    });
  }

  async checkLimit(key: string, rule: RouteRule): Promise<CheckLimitResult> {
    const windowSizeSec = rule.windowSizeSec!;
    const maxRequests = rule.maxRequests!;
    const redisKey = `ratelimit:fixed:${key}`;

    const [allowed, remaining, resetAt] = await this.redis.fixedWindowCheck(
      redisKey,
      windowSizeSec,
      maxRequests
    );

    const nowSec = Math.floor(Date.now() / 1000);

    return {
      allowed: allowed === 1,
      remaining,
      resetAt,
      retryAfterMs: allowed === 1 ? 0 : (resetAt - nowSec) * 1000,
    };
  }
}
