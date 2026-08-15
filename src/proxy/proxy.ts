import http from 'node:http';
import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { getBackendTarget } from '../config/loadConfig';
import type { RequestHandler } from 'express';

// Reused across every proxied request -- this is what makes the gateway
// reuse TCP connections to the backend instead of opening a fresh one per
// request. Without this, http-proxy-middleware falls back to Node's
// non-keep-alive default agent, and under sustained load that exhausts
// ephemeral ports and piles up TIME_WAIT sockets between the gateway and
// the backend -- the exact failure mode that shows up as p99 latency
// pinned at the client's timeout value and a rising error count.
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,       // per-target pool size; raise if the backend can take more
  maxFreeSockets: 64,
});

export function createBackendProxy(): RequestHandler {
  const options: Options = {
    target: getBackendTarget(),
    changeOrigin: true,
    logLevel: 'warn',
    agent: keepAliveAgent,
  };

  return createProxyMiddleware(options);
}