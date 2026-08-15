import fs from 'fs';
import path from 'path';
import type Redis from 'ioredis';
import { RateLimiterStrategy } from './RateLimiterStrategy';
import type { RouteRule, CheckLimitResult } from '../types/limits';

const SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'tokenBucket.lua'), 'utf8');

/**
 * Allows controlled bursts up to bucketCapacity while enforcing an average
 * rate of refillRatePerSec. The check-refill-consume sequence runs as one
 * atomic Lua script server-side -- see tokenBucket.lua for why that matters
 * under concurrent gateway instances.
 */
export class TokenBucketLimiter extends RateLimiterStrategy {
  constructor(redis: Redis) {
    super(redis);
    this.redis.defineCommand('tokenBucketCheck', {
      numberOfKeys: 1,
      lua: SCRIPT,
    });
  }

  async checkLimit(key: string, rule: RouteRule): Promise<CheckLimitResult> {
    const bucketCapacity = rule.bucketCapacity!;
    const refillRatePerSec = rule.refillRatePerSec!;
    const redisKey = `ratelimit:token:${key}`;
    const nowMs = Date.now();

    const [allowed, remaining, retryAfterMs] = await this.redis.tokenBucketCheck(
      redisKey,
      bucketCapacity,
      refillRatePerSec,
      nowMs,
      1
    );

    return {
      allowed: allowed === 1,
      remaining,
      resetAt: Math.floor((nowMs + retryAfterMs) / 1000),
      retryAfterMs,
    };
  }
}
