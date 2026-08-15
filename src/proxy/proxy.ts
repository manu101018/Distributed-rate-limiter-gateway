import { createProxyMiddleware, type Options } from 'http-proxy-middleware';
import { getBackendTarget } from '../config/loadConfig';
import type { RequestHandler } from 'express';

export function createBackendProxy(): RequestHandler {
  const options: Options = {
    target: getBackendTarget(),
    changeOrigin: true,
    logLevel: 'warn',
  };

  return createProxyMiddleware(options);
}
