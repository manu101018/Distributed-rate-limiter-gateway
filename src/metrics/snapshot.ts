/**
 * In-memory running stats used by GET /stats.
 *
 * Percentiles are estimated from fixed histogram buckets so we never store
 * per-request samples — that would OOM at a million requests. The same
 * bucket edges are used by the Prometheus histograms in metrics.ts.
 */

export const REDIS_CHECK_BUCKETS_MS = [0.5, 1, 2, 5, 10, 25, 50, 100];
export const REQUEST_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];

export class RunningHistogram {
  private readonly edges: number[];
  private readonly counts: number[];
  private inf = 0;
  private sum = 0;
  private n = 0;
  private min = Infinity;
  private max = 0;

  constructor(bucketEdgesMs: number[]) {
    this.edges = bucketEdgesMs;
    this.counts = new Array(bucketEdgesMs.length).fill(0);
  }

  observe(ms: number): void {
    this.n += 1;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;

    for (let i = 0; i < this.edges.length; i++) {
      if (ms <= this.edges[i]) {
        this.counts[i] += 1;
        return;
      }
    }
    this.inf += 1;
  }

  percentile(p: number): number {
    if (this.n === 0) return 0;
    const target = p * this.n;
    let cumulative = 0;
    let prev = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const bucketCount = this.counts[i];
      if (cumulative + bucketCount >= target) {
        const fraction = bucketCount === 0 ? 0 : (target - cumulative) / bucketCount;
        const estimate = prev + fraction * (this.edges[i] - prev);
        return round2(Math.min(this.max, Math.max(this.min, estimate)));
      }
      cumulative += bucketCount;
      prev = this.edges[i];
    }
    return round2(this.max);
  }

  snapshot(): LatencySnapshot {
    return {
      count: this.n,
      avgMs: this.n === 0 ? 0 : round2(this.sum / this.n),
      minMs: this.n === 0 ? 0 : round2(this.min),
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.n === 0 ? 0 : round2(this.max),
    };
  }
}

export interface LatencySnapshot {
  count: number;
  avgMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export type RequestOutcome = 'allowed' | 'denied' | 'fail_open';

const startedAt = Date.now();

const requests = {
  allowed: 0,
  denied: 0,
  failOpen: 0,
};

const redisCheck = new RunningHistogram(REDIS_CHECK_BUCKETS_MS);
const requestDuration = new RunningHistogram(REQUEST_BUCKETS_MS);

export function recordRequest(outcome: RequestOutcome): void {
  if (outcome === 'allowed') requests.allowed += 1;
  else if (outcome === 'denied') requests.denied += 1;
  else requests.failOpen += 1;
}

export function recordRedisCheckMs(ms: number): void {
  redisCheck.observe(ms);
}

export function recordRequestDurationMs(ms: number): void {
  requestDuration.observe(ms);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildStats(instanceId: string, eventLoopLagMs: number) {
  const total = requests.allowed + requests.denied + requests.failOpen;
  const mem = process.memoryUsage();
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);

  return {
    instance: instanceId,
    uptimeSeconds: uptimeSec,
    requests: {
      total,
      allowed: requests.allowed,
      denied: requests.denied,
      failOpen: requests.failOpen,
      denyPercent: total === 0 ? 0 : round2((requests.denied / total) * 100),
    },
    latency: {
      redisCheck: redisCheck.snapshot(),
      endToEnd: requestDuration.snapshot(),
    },
    process: {
      rssMb: round1(mem.rss / 1024 / 1024),
      heapUsedMb: round1(mem.heapUsed / 1024 / 1024),
      eventLoopLagMs: round2(eventLoopLagMs),
    },
  };
}
