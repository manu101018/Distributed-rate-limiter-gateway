import client from 'prom-client';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { REDIS_CHECK_BUCKETS_MS, REQUEST_BUCKETS_MS } from './snapshot';

/**
 * Dedicated registry (rather than the global default) so this module is
 * self-contained. Default Node.js collectors are intentionally omitted —
 * heap-space / GC / handle dumps are noise on /metrics. We expose only
 * the numbers that describe the rate limiter under load.
 */
export const registry = new client.Registry();

export const requestsTotal = new client.Counter({
  name: 'gateway_requests_total',
  help: 'Requests seen by the rate limiter, labeled by outcome (allowed|denied|fail_open)',
  labelNames: ['route', 'algorithm', 'outcome'] as const,
  registers: [registry],
});

export const redisCheckDuration = new client.Histogram({
  name: 'gateway_redis_check_seconds',
  help: 'Time spent in the Redis Lua rate-limit check',
  labelNames: ['algorithm'] as const,
  buckets: REDIS_CHECK_BUCKETS_MS.map((ms) => ms / 1000),
  registers: [registry],
});

export const requestDuration = new client.Histogram({
  name: 'gateway_request_duration_seconds',
  help: 'End-to-end request duration including rate-limit check and (if allowed) the backend proxy',
  labelNames: ['route', 'outcome'] as const,
  buckets: REQUEST_BUCKETS_MS.map((ms) => ms / 1000),
  registers: [registry],
});

export const inFlightRequests = new client.Gauge({
  name: 'gateway_in_flight_requests',
  help: 'Requests currently being processed by this instance',
  registers: [registry],
});

export const memoryRssBytes = new client.Gauge({
  name: 'gateway_memory_rss_bytes',
  help: 'Resident set size of this gateway process',
  registers: [registry],
});

export const eventLoopLagSeconds = new client.Gauge({
  name: 'gateway_event_loop_lag_seconds',
  help: 'Mean event-loop lag over the last scrape interval',
  registers: [registry],
});

const elu = monitorEventLoopDelay({ resolution: 1 });
elu.enable();
memoryRssBytes.set(process.memoryUsage().rss);

export function currentEventLoopLagMs(): number {
  return elu.mean / 1e6;
}

setInterval(() => {
  memoryRssBytes.set(process.memoryUsage().rss);
  eventLoopLagSeconds.set(elu.mean / 1e9);
  elu.reset();
}, 2000).unref();
