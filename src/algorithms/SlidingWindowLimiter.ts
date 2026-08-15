import fs from 'fs';
import path from 'path';
import type Redis from 'ioredis';
import { RateLimiterStrategy } from './RateLimiterStrategy';
import type { RouteRule, CheckLimitResult } from '../types/limits';

const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'slidingWindow.lua'), 'utf8');

/**
 * Smooths out the fixed-window boundary-burst problem by weighting the
 * previous window's count by how much it still overlaps the current
 * sliding window.
 */
export class SlidingWindowLimiter extends RateLimiterStrategy {
  constructor(redis: Redis) {
    super(redis);
    this.redis.defineCommand('slidingWindowCheck', {
      numberOfKeys: 2,
      lua: SCRIPT,
    });
  }

  async checkLimit(key: string, rule: RouteRule): Promise<CheckLimitResult> {
    const windowSizeSec = rule.windowSizeSec!;
    const maxRequests = rule.maxRequests!;

    const nowSec = Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(nowSec / windowSizeSec);
    const prevBucket = currentBucket - 1;

    const currentKey = `ratelimit:sliding:${key}:${currentBucket}`;
    const prevKey = `ratelimit:sliding:${key}:${prevBucket}`;

    const [allowed, remaining, resetAt] = await this.redis.slidingWindowCheck(
      currentKey,
      prevKey,
      windowSizeSec,
      maxRequests
    );

    return {
      allowed: allowed === 1,
      remaining,
      resetAt,
      retryAfterMs: allowed === 1 ? 0 : (resetAt - nowSec) * 1000,
    };
  }
}
