import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import { createRedisClient, waitForRedisReady } from './redis/client';
import { RateLimiterFactory } from './algorithms/RateLimiterFactory';
import { createRateLimitMiddleware } from './middleware/rateLimitMiddleware';
import { createBackendProxy } from './proxy/proxy';
import { registry, currentEventLoopLagMs } from './metrics/metrics';
import { buildStats } from './metrics/snapshot';
import { registerDashboard } from './dashboard/loadTestApi';

const PORT = Number(process.env.PORT) || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || `gateway-${PORT}`;

const app = express();

// trust the load balancer's X-Forwarded-For so req.ip reflects the real client
app.set('trust proxy', true);

const redisClient = createRedisClient();
const rateLimiterFactory = new RateLimiterFactory(redisClient);

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', instance: INSTANCE_ID });
});

// Human-readable snapshot of the same counters Prometheus scrapes.
// Prometheus scrapes /metrics instead; this is for curl and load-test summaries.
app.get('/stats', (_req: Request, res: Response) => {
  res.json(buildStats(INSTANCE_ID, currentEventLoopLagMs()));
});

// Prometheus scrapes this endpoint on every gateway instance directly
// (see prometheus/prometheus.yml) -- bypasses the rate limiter itself.
app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

registerDashboard(app, __dirname);

app.use(createRateLimitMiddleware(rateLimiterFactory));
app.use(createBackendProxy());

async function start(): Promise<void> {
  try {
    await waitForRedisReady(redisClient);
    rateLimiterFactory.warmUp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[gateway] ${message}; rate limits will fail open until Redis reconnects`);
  }

  app.listen(PORT, () => {
    console.log(`[gateway] ${INSTANCE_ID} listening on port ${PORT}`);
    console.log(`[gateway] dashboard: http://localhost:${PORT}/dashboard`);
  });
}

void start();

async function shutdown(): Promise<void> {
  redisClient.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
