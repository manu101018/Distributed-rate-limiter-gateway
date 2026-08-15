import type Redis from 'ioredis';
import { RateLimiterStrategy } from './RateLimiterStrategy';
import { FixedWindowLimiter } from './FixedWindowLimiter';
import { SlidingWindowLimiter } from './SlidingWindowLimiter';
import { TokenBucketLimiter } from './TokenBucketLimiter';
import type { AlgorithmName } from '../types/limits';

type StrategyConstructor = new (redis: Redis) => RateLimiterStrategy;

/**
 * Maps a config-driven algorithm name to a concrete strategy instance.
 * The middleware, proxy, and server only ever depend on RateLimiterStrategy
 * -- adding a new algorithm (e.g. leaky bucket) means writing the class and
 * adding one line to `_registry`, nothing else changes.
 */
export class RateLimiterFactory {
  private readonly redis: Redis;
  private readonly cache = new Map<string, RateLimiterStrategy>();
  private readonly registry: Record<string, StrategyConstructor>;

  constructor(redis: Redis) {
    this.redis = redis;
    this.registry = {
      'fixed-window': FixedWindowLimiter,
      'sliding-window': SlidingWindowLimiter,
      'token-bucket': TokenBucketLimiter,
    };
  }

  /** Register an additional algorithm at runtime (tests, plugins, etc). */
  register(algorithmName: AlgorithmName | string, StrategyClass: StrategyConstructor): void {
    this.registry[algorithmName] = StrategyClass;
  }

  isRedisReady(): boolean {
    return this.redis.status === 'ready';
  }

  /** Instantiate every strategy so Lua scripts are registered before traffic. */
  warmUp(): void {
    for (const algorithmName of Object.keys(this.registry)) {
      this.getLimiter(algorithmName);
    }
  }

  getLimiter(algorithmName: AlgorithmName | string): RateLimiterStrategy {
    const cached = this.cache.get(algorithmName);
    if (cached) {
      return cached;
    }

    const StrategyClass = this.registry[algorithmName];
    if (!StrategyClass) {
      const available = Object.keys(this.registry).join(', ');
      throw new Error(`Unknown rate limit algorithm "${algorithmName}". Available: ${available}`);
    }

    const instance = new StrategyClass(this.redis);
    this.cache.set(algorithmName, instance);
    return instance;
  }
}
