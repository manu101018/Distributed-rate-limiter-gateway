import type Redis from 'ioredis';
import type { RouteRule, CheckLimitResult } from '../types/limits';

/**
 * The "Product" interface in the factory pattern. RateLimiterFactory builds
 * instances of this type; the middleware only ever depends on this
 * interface, never on a concrete algorithm class.
 */
export abstract class RateLimiterStrategy {
  protected readonly redis: Redis;

  protected constructor(redis: Redis) {
    this.redis = redis;
  }

  abstract checkLimit(key: string, rule: RouteRule): Promise<CheckLimitResult>;

  get name(): string {
    return this.constructor.name;
  }
}
