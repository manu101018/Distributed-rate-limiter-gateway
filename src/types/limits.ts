export type AlgorithmName = 'fixed-window' | 'sliding-window' | 'token-bucket';

export type KeyByStrategy = 'ip' | 'apiKey';

/**
 * A single route's rate-limit rule, as defined in config/limits.json.
 * Not every field applies to every algorithm -- windowSizeSec/maxRequests
 * are used by fixed-window and sliding-window, bucketCapacity/refillRatePerSec
 * by token-bucket. The factory + strategy classes only read the fields
 * relevant to their own algorithm.
 */
export interface RouteRule {
  path: string;
  algorithm: AlgorithmName;
  keyBy: KeyByStrategy;
  windowSizeSec?: number;
  maxRequests?: number;
  bucketCapacity?: number;
  refillRatePerSec?: number;
}

export interface LimitsConfig {
  backendTarget: string;
  defaultAlgorithm: AlgorithmName;
  routes: RouteRule[];
}

/**
 * Uniform result shape every algorithm returns, regardless of how it
 * internally computes it. This is what lets the middleware treat every
 * strategy identically.
 */
export interface CheckLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch seconds
  retryAfterMs: number;
}
