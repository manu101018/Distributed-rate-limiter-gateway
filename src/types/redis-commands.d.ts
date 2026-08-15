import 'ioredis';

/**
 * Each algorithm calls redis.defineCommand(...) at construction time to
 * register its Lua script as a first-class Redis command (e.g.
 * redis.tokenBucketCheck(...)). ioredis does this dynamically at runtime,
 * so TypeScript has no way to know these methods exist -- this declaration
 * merge is what makes them type-checked and autocompletable instead of
 * requiring an `as any` cast at every call site.
 */
declare module 'ioredis' {
  interface Redis {
    fixedWindowCheck(
      key: string,
      windowSizeSec: number,
      maxRequests: number
    ): Promise<[number, number, number]>;

    slidingWindowCheck(
      currentKey: string,
      prevKey: string,
      windowSizeSec: number,
      maxRequests: number
    ): Promise<[number, number, number]>;

    tokenBucketCheck(
      key: string,
      capacity: number,
      refillRatePerSec: number,
      nowMs: number,
      requested: number
    ): Promise<[number, number, number]>;
  }
}
