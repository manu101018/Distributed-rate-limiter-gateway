import Redis from 'ioredis';

export function createRedisClient(): Redis {
  const host = process.env.REDIS_HOST || '127.0.0.1';
  const client = new Redis({
    host,
    port: Number(process.env.REDIS_PORT) || 6379,
    // macOS resolves "localhost" to ::1 first; Redis is typically on IPv4 only
    family: 4,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    // reject commands unless status === 'ready' — fail-open instead of hanging
    enableOfflineQueue: false,
    retryStrategy(times: number): number {
      return Math.min(times * 200, 2000);
    },
  });

  client.on('error', (err: Error) => {
    console.error('[redis] connection error:', err.message);
  });

  client.on('ready', () => {
    console.log('[redis] ready');
  });

  client.on('close', () => {
    console.warn('[redis] connection closed, retrying');
  });

  return client;
}

export function isRedisReady(client: Redis): boolean {
  return client.status === 'ready';
}

/** Resolves once ioredis can actually run commands, not merely on TCP connect. */
export function waitForRedisReady(client: Redis, timeoutMs = 8000): Promise<void> {
  if (client.status === 'ready') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs}ms (status=${client.status})`));
    }, timeoutMs);

    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };

    client.once('ready', onReady);
  });
}
