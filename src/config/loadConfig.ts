import fs from 'fs';
import path from 'path';
import type { LimitsConfig, RouteRule } from '../types/limits';

let cachedConfig: LimitsConfig | null = null;
let lastLoadedAt = 0;

const CONFIG_PATH =
  process.env.LIMITS_CONFIG_PATH || path.join(__dirname, '..', '..', 'config', 'limits.json');
const RELOAD_INTERVAL_MS = 5000;

export function loadConfig(): LimitsConfig {
  const now = Date.now();
  if (cachedConfig && now - lastLoadedAt < RELOAD_INTERVAL_MS) {
    return cachedConfig;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  cachedConfig = JSON.parse(raw) as LimitsConfig;
  lastLoadedAt = now;
  return cachedConfig;
}

/**
 * Longest-prefix match: /api/orders/123 matches the more specific
 * /api/orders rule over the generic /api rule.
 */
export function matchRoute(requestPath: string): RouteRule | null {
  const config = loadConfig();
  const matches = config.routes.filter((route) => requestPath.startsWith(route.path));

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0];
}

export function getBackendTarget(): string {
  // env var wins so the same config/limits.json works both for local dev
  // (localhost:4000) and Docker Compose (http://mock-backend:4000) without
  // editing the file per environment.
  return process.env.BACKEND_TARGET || loadConfig().backendTarget;
}
