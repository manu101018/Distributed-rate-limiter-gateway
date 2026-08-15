#!/usr/bin/env node
/**
 * High-concurrency load test against the gateway.
 *
 * Parallelized across worker_threads so the load generator itself doesn't
 * become the bottleneck: each worker gets its own event loop, its own
 * http.Agent, and a slice of the total request count. The main thread only
 * spawns workers, aggregates their histograms/counts, and prints the
 * combined report -- it never issues requests itself.
 *
 *   npm run loadtest -- 100
 *   npm run loadtest -- 1000000 --port 8080 --workers 4
 *   npm run loadtest -- --steps 100,1000,10000,50000,1000000
 *
 * Unique X-Forwarded-For / x-api-key values spread traffic across identities
 * so Redis actually does a Lua check per request instead of one hot key.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);

const ROUTES = [
  { path: '/api/search', weight: 50 },
  { path: '/api/ping', weight: 30 },
  { path: '/api/orders', weight: 20 },
];

const LATENCY_EDGES_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
const DEFAULT_WORKERS = Math.max(1, Math.min(8, os.cpus().length));

/* ------------------------------------------------------------------ */
/*  Shared helpers (used by both the main thread and worker threads)   */
/* ------------------------------------------------------------------ */

function pickRoute(pathOpt, n) {
  if (pathOpt !== 'mixed') return pathOpt;
  const slot = n % 100;
  let cumulative = 0;
  for (const route of ROUTES) {
    cumulative += route.weight;
    if (slot < cumulative) return route.path;
  }
  return ROUTES[0].path;
}

function clientIp(id) {
  const a = Math.floor(id / 65536) % 256;
  const b = Math.floor(id / 256) % 256;
  const c = id % 256;
  return `10.${a}.${b}.${c}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

class Histogram {
  constructor(edges) {
    this.edges = edges;
    this.counts = new Array(edges.length).fill(0);
    this.inf = 0;
    this.sum = 0;
    this.n = 0;
    this.min = Infinity;
    this.max = 0;
  }

  observe(ms) {
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

  percentile(p) {
    if (this.n === 0) return 0;
    const target = p * this.n;
    let cumulative = 0;
    let prev = 0;
    for (let i = 0; i < this.edges.length; i++) {
      const count = this.counts[i];
      if (cumulative + count >= target) {
        const fraction = count === 0 ? 0 : (target - cumulative) / count;
        const estimate = prev + fraction * (this.edges[i] - prev);
        return round2(Math.min(this.max, Math.max(this.min, estimate)));
      }
      cumulative += count;
      prev = this.edges[i];
    }
    return round2(this.max);
  }

  snapshot() {
    return {
      avgMs: this.n === 0 ? 0 : round2(this.sum / this.n),
      minMs: this.n === 0 ? 0 : round2(this.min),
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: this.n === 0 ? 0 : round2(this.max),
    };
  }

  /** Plain, structured-clone-safe snapshot for postMessage across threads. */
  toRaw() {
    return {
      edges: this.edges,
      counts: this.counts,
      inf: this.inf,
      sum: this.sum,
      n: this.n,
      min: this.min,
      max: this.max,
    };
  }

  /** Rebuild a Histogram from a raw object (e.g. received via postMessage). */
  static fromRaw(raw) {
    const h = new Histogram(raw.edges);
    h.counts = raw.counts;
    h.inf = raw.inf;
    h.sum = raw.sum;
    h.n = raw.n;
    h.min = raw.min;
    h.max = raw.max;
    return h;
  }

  /** Merge another raw histogram's counts into this one. */
  mergeRaw(raw) {
    for (let i = 0; i < this.counts.length; i++) this.counts[i] += raw.counts[i];
    this.inf += raw.inf;
    this.sum += raw.sum;
    this.n += raw.n;
    this.min = Math.min(this.min, raw.min);
    this.max = Math.max(this.max, raw.max);
  }
}

function requestOnce(agent, host, port, path, headers) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const req = http.request(
      { hostname: host, port, path, method: 'GET', agent, headers },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            ms: Number(process.hrtime.bigint() - start) / 1e6,
            error: false,
          });
        });
      }
    );
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', () => {
      resolve({
        status: 0,
        ms: Number(process.hrtime.bigint() - start) / 1e6,
        error: true,
      });
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Worker-thread body: runs one slice of the total request count      */
/* ------------------------------------------------------------------ */

async function runWorkerSlice() {
  const { host, port, path, concurrency, clients, startIndex, count, workerId } = workerData;

  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });

  const latency = new Histogram(LATENCY_EDGES_MS);
  const statusCounts = new Map();
  let errors = 0;
  let completed = 0;
  let nextOffset = 0;

  let lastReportAt = process.hrtime.bigint();

  async function worker() {
    while (true) {
      const offset = nextOffset++;
      if (offset >= count) return;

      const globalIndex = startIndex + offset;
      const clientId = globalIndex % clients;
      const routePath = pickRoute(path, globalIndex);
      const headers = {
        'X-Forwarded-For': clientIp(clientId),
        'x-api-key': `loadtest-${clientId}`,
        Connection: 'keep-alive',
      };

      const result = await requestOnce(agent, host, port, routePath, headers);
      completed += 1;
      latency.observe(result.ms);
      if (result.error) {
        errors += 1;
      } else {
        statusCounts.set(result.status, (statusCounts.get(result.status) || 0) + 1);
      }

      const now = process.hrtime.bigint();
      if (Number(now - lastReportAt) / 1e9 >= 0.5) {
        parentPort.postMessage({ type: 'progress', workerId, completed });
        lastReportAt = now;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, count));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  agent.destroy();

  const statuses = {};
  for (const [code, c] of statusCounts.entries()) statuses[String(code)] = c;

  parentPort.postMessage({
    type: 'done',
    workerId,
    completed,
    errors,
    statusCounts: statuses,
    histogram: latency.toRaw(),
  });
}

if (!isMainThread) {
  runWorkerSlice().catch((err) => {
    parentPort.postMessage({ type: 'error', message: err.message });
    process.exit(1);
  });
}

/* ------------------------------------------------------------------ */
/*  Main thread: CLI parsing, spawning workers, aggregating results    */
/* ------------------------------------------------------------------ */

function parseCount(value, flag) {
  const n = Number(String(value).replace(/_/g, ''));
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) fail(`invalid ${flag}: ${value}`);
  return n;
}

function parseCountList(value) {
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => parseCount(part, '--steps'));
}

function autoConcurrency(total) {
  if (total <= 100) return Math.min(total, 10);
  if (total <= 1000) return 25;
  if (total <= 10000) return 50;
  if (total <= 50000) return 100;
  if (total <= 200000) return 200;
  return 400;
}

function autoClients(total) {
  // no longer hard-capped at 1000 -- scales with total so identities don't
  // get pinned against their rate limit for the whole run at high volume
  return Math.max(1, Math.min(50000, Math.ceil(total / 50)));
}

function parseArgs(argv) {
  const opts = {
    host: 'localhost',
    port: 3000,
    totals: [],
    concurrency: null,
    clients: null,
    workers: DEFAULT_WORKERS,
    path: 'mixed',
    out: 'load-test-results.json',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (/^\d[\d_]*$/.test(arg)) {
      opts.totals.push(parseCount(arg, 'request count'));
    } else if (arg === '--host' && next) (opts.host = next), i++;
    else if (arg === '--port' && next) (opts.port = parseCount(next, '--port')), i++;
    else if ((arg === '--total' || arg === '-n') && next) {
      opts.totals.push(parseCount(next, '--total'));
      i++;
    } else if ((arg === '--steps' || arg === '--totals') && next) {
      opts.totals.push(...parseCountList(next));
      i++;
    } else if (arg === '--concurrency' && next) (opts.concurrency = parseCount(next, '--concurrency')), i++;
    else if (arg === '--clients' && next) (opts.clients = parseCount(next, '--clients')), i++;
    else if (arg === '--workers' && next) (opts.workers = parseCount(next, '--workers')), i++;
    else if (arg === '--path' && next) (opts.path = next), i++;
    else if (arg === '--out' && next) (opts.out = next), i++;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}\nRun with --help for usage.`);
    }
  }

  if (opts.totals.length === 0) {
    printHelp();
    fail('Pass a request count, e.g. npm run loadtest -- 1000');
  }
  return opts;
}

function printHelp() {
  console.log(`Usage:
  npm run loadtest -- <count>
  npm run loadtest -- --steps 100,1000,10000,50000
  node scripts/load-test.mjs <count> [options]

  count / --total / -n   Requests to send (repeatable)
  --steps                Comma-separated counts, run in order
  --host                 Target host (default: localhost)
  --port                 Target port (default: 3000; 8080 for docker-compose nginx)
  --concurrency          Total in-flight requests across all workers (default: scales with count)
  --clients              Distinct simulated identities (default: scales with count)
  --workers              Worker threads generating load in parallel (default: ${DEFAULT_WORKERS}, your CPU count)
  --path                 mixed | /api/search | /api/ping | /api/orders
  --out                  History file (default: load-test-results.json, last 5 runs)

Examples:
  npm run loadtest -- 100
  npm run loadtest -- 1000000 --port 8080 --workers 4
  npm run loadtest -- --steps 100,1000,10000,50000,1000000
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const HISTORY_LIMIT = 5;

function isRunSummary(value) {
  return Boolean(value && typeof value === 'object' && typeof value.total === 'number' && value.latency);
}

export function readHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed?.runs)) return parsed.runs.filter(isRunSummary);
    if (isRunSummary(parsed)) return [parsed];
    return [];
  } catch {
    return [];
  }
}

export function appendRuns(filePath, summaries) {
  const next = [...readHistory(filePath), ...summaries].slice(-HISTORY_LIMIT);
  fs.writeFileSync(filePath, JSON.stringify({ runs: next }, null, 2) + '\n');
  return next;
}

async function fetchStats(opts) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: opts.host, port: opts.port, path: '/stats', timeout: 3000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** Splits `total` into `n` near-equal integer chunks. */
function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  const remainder = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

export async function runLoadTest(opts) {
  const workerCount = Math.max(1, Math.min(opts.workers, opts.total));
  const counts = splitEvenly(opts.total, workerCount);
  const concurrencies = splitEvenly(opts.concurrency, workerCount).map((c) => Math.max(1, c));

  console.log(
    `Load test → http://${opts.host}:${opts.port}  ` +
    `${fmt(opts.total)} requests  concurrency=${opts.concurrency} (${workerCount} workers)  ` +
    `clients=${fmt(opts.clients)}  path=${opts.path}`
  );

  const started = process.hrtime.bigint();
  const progress = new Array(workerCount).fill(0);
  let lastLogAt = started;
  let lastLogTotal = 0;

  function logProgress(force = false) {
    const now = process.hrtime.bigint();
    if (!force && Number(now - lastLogAt) / 1e9 < 1) return;
    const completedTotal = progress.reduce((a, b) => a + b, 0);
    const elapsed = Number(now - started) / 1e9;
    const windowSec = Number(now - lastLogAt) / 1e9;
    const windowRate = windowSec > 0 ? (completedTotal - lastLogTotal) / windowSec : 0;
    const overallRate = elapsed > 0 ? completedTotal / elapsed : 0;
    process.stdout.write(
      `\r[${fmt(completedTotal).padStart(10)} / ${fmt(opts.total)}]  ` +
      `${Math.round(windowRate).toLocaleString('en-US')} req/s instant  ` +
      `${Math.round(overallRate).toLocaleString('en-US')} req/s avg  ` +
      `${elapsed.toFixed(1)}s elapsed  (${workerCount} workers)   `
    );
    lastLogAt = now;
    lastLogTotal = completedTotal;
  }

  let startIndex = 0;
  const results = await Promise.all(
    counts.map((count, workerId) => {
      const data = {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        concurrency: concurrencies[workerId],
        clients: opts.clients,
        startIndex,
        count,
        workerId,
      };
      startIndex += count;

      return new Promise((resolve, reject) => {
        const worker = new Worker(SELF_PATH, { workerData: data });
        let final = null;

        worker.on('message', (msg) => {
          if (msg.type === 'progress') {
            progress[msg.workerId] = msg.completed;
            logProgress();
          } else if (msg.type === 'done') {
            progress[msg.workerId] = msg.completed;
            final = msg;
          } else if (msg.type === 'error') {
            reject(new Error(`worker ${workerId} failed: ${msg.message}`));
          }
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0 && !final) {
            reject(new Error(`worker ${workerId} exited with code ${code}`));
            return;
          }
          resolve(final);
        });
      });
    })
  );

  const elapsedSec = Number(process.hrtime.bigint() - started) / 1e9;
  logProgress(true);
  process.stdout.write('\n');

  // aggregate across all workers
  const latency = new Histogram(LATENCY_EDGES_MS);
  const statusCounts = new Map();
  let errors = 0;
  for (const r of results) {
    latency.mergeRaw(r.histogram);
    errors += r.errors;
    for (const [code, count] of Object.entries(r.statusCounts)) {
      statusCounts.set(Number(code), (statusCounts.get(Number(code)) || 0) + count);
    }
  }

  const statuses = {};
  for (const [code, count] of [...statusCounts.entries()].sort((a, b) => a[0] - b[0])) {
    statuses[String(code)] = count;
  }

  const allowed = statusCounts.get(200) || 0;
  const denied = statusCounts.get(429) || 0;
  const summary = {
    target: `http://${opts.host}:${opts.port}`,
    total: opts.total,
    concurrency: opts.concurrency,
    workers: workerCount,
    clients: opts.clients,
    path: opts.path,
    durationSeconds: round2(elapsedSec),
    throughputRps: round2(opts.total / elapsedSec),
    errors,
    statusCodes: statuses,
    allowed,
    denied,
    denyPercent: round2((denied / opts.total) * 100),
    latency: latency.snapshot(),
    gatewayStats: await fetchStats(opts),
    completedAt: new Date().toISOString(),
  };

  console.log(`
=== Load test complete ===
Requests:     ${fmt(summary.total)}
Workers:      ${summary.workers}
Duration:     ${summary.durationSeconds}s
Throughput:   ${fmt(Math.round(summary.throughputRps))} req/s
HTTP 200:     ${fmt(summary.allowed)}
HTTP 429:     ${fmt(summary.denied)}  (${summary.denyPercent}% denied)
Errors:       ${fmt(summary.errors)}
Other status: ${JSON.stringify(summary.statusCodes)}

Client latency
  avg  ${summary.latency.avgMs} ms
  p50  ${summary.latency.p50Ms} ms
  p95  ${summary.latency.p95Ms} ms
  p99  ${summary.latency.p99Ms} ms
  max  ${summary.latency.maxMs} ms
`);

  if (summary.gatewayStats) {
    console.log('Gateway /stats');
    console.log(JSON.stringify(summary.gatewayStats, null, 2));
    console.log('');
  }

  return summary;
}

function pad(value, width) {
  return String(value).padStart(width);
}

function printComparison(runs) {
  console.log('=== Scale comparison ===');
  console.log(
    pad('requests', 12) +
    pad('seconds', 10) +
    pad('req/s', 10) +
    pad('200', 10) +
    pad('429', 10) +
    pad('deny%', 9) +
    pad('p50ms', 9) +
    pad('p99ms', 9) +
    pad('errors', 9)
  );
  for (const run of runs) {
    console.log(
      pad(fmt(run.total), 12) +
      pad(run.durationSeconds.toFixed(2), 10) +
      pad(fmt(Math.round(run.throughputRps)), 10) +
      pad(fmt(run.allowed), 10) +
      pad(fmt(run.denied), 10) +
      pad(run.denyPercent.toFixed(1), 9) +
      pad(run.latency.p50Ms.toFixed(1), 9) +
      pad(run.latency.p99Ms.toFixed(1), 9) +
      pad(fmt(run.errors), 9)
    );
  }
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runs = [];

  for (let i = 0; i < opts.totals.length; i++) {
    const total = opts.totals[i];
    if (opts.totals.length > 1) {
      console.log(`\n--------  ${fmt(total)} requests (${i + 1}/${opts.totals.length})  --------\n`);
    }
    const summary = await runLoadTest({
      host: opts.host,
      port: opts.port,
      total,
      concurrency: Math.min(opts.concurrency ?? autoConcurrency(total), total),
      clients: opts.clients ?? autoClients(total),
      workers: opts.workers,
      path: opts.path,
    });
    runs.push(summary);
  }

  if (runs.length > 1) printComparison(runs);

  const history = appendRuns(opts.out, runs);
  console.log(`Wrote ${opts.out} (${history.length} run(s) kept, last ${HISTORY_LIMIT})`);
}

if (isMainThread) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}