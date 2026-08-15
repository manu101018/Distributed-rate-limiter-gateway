# Before reading below, have a look at the Grafana dashboard result for my test result of 1M requests over a contast burst.
<img width="1177" height="713" alt="Screenshot 2026-08-15 at 10 59 54 PM" src="https://github.com/user-attachments/assets/049ad298-1d57-4bef-b27c-8fb514786e5c" />


# Distributed Rate Limiter / API Gateway (TypeScript)

A Node.js + Express + TypeScript API gateway that enforces distributed rate
limits across multiple gateway instances, backed by Redis. Algorithms are
pluggable via a **factory pattern**. Instrumented with Prometheus metrics
and visualized in Grafana.

## Stack


| Concern                  | Tool                                                      |
| ------------------------ | --------------------------------------------------------- |
| Gateway runtime          | Node.js 20 + Express + TypeScript                         |
| Shared rate-limit state  | Redis (ioredis), atomic Lua scripts                       |
| Reverse proxy            | http-proxy-middleware                                     |
| Load balancer            | Nginx                                                     |
| Containerization         | Docker + Docker Compose                                   |
| Metrics                  | prom-client, exposed at `/metrics` and `/stats`           |
| Dashboards               | Grafana (auto-provisioned) + `/dashboard` load-test UI    |
| Metrics storage/scraping | Prometheus                                                |
| Load testing             | `scripts/load-test.mjs` (keep-alive HTTP, worker threads) |


## Project structure

```
src/
  types/
    limits.ts                # RouteRule, LimitsConfig, CheckLimitResult
    redis-commands.d.ts       # typed declaration merge for custom Lua commands
  algorithms/
    RateLimiterStrategy.ts    # abstract interface
    FixedWindowLimiter.ts
    SlidingWindowLimiter.ts
    TokenBucketLimiter.ts
    RateLimiterFactory.ts     # <-- the factory
    scripts/*.lua             # atomic Redis Lua scripts, one per algorithm
  redis/client.ts
  config/loadConfig.ts        # hot-reloading config + longest-prefix route match
  metrics/metrics.ts          # Prometheus counters/histograms (no default Node dump)
  metrics/snapshot.ts         # in-memory totals + percentile buckets for GET /stats
  middleware/rateLimitMiddleware.ts
  proxy/proxy.ts
  server.ts
mock-backend/                 # tiny TS echo server, proxy target
nginx/nginx.conf              # round-robin load balancer for gateways
nginx/backend.conf            # round-robin load balancer for mock backends
prometheus/prometheus.yml     # scrapes each gateway instance's /metrics
grafana/
  provisioning/                # auto-configures the Prometheus datasource + dashboard
  dashboards/rate-limiter-dashboard.json
scripts/load-test.mjs         # keep-alive load test; worker_threads + variable request count
dashboard/index.html          # load-test UI (charts of the last 5 runs)
docker-compose.yml            # 3 gateways + 3 mock backends + Redis + Nginx + Prometheus + Grafana
```

## Why the factory pattern here

`RateLimiterFactory.getLimiter(algorithmName)` maps a config string
(`"token-bucket"`) to a cached instance of the matching strategy class.
Everything downstream — middleware, proxy, server — only ever calls
`limiter.checkLimit(key, rule)` against the shared `RateLimiterStrategy`
abstract class. Adding a new algorithm (e.g. leaky bucket) means: write the
class, add one line to the factory's `registry`. Nothing else changes.

TypeScript adds real value on top of this: `RateLimiterStrategy` is an
actual abstract class enforced at compile time (not just a JS convention),
and `redis-commands.d.ts` type-checks every call to a Lua-backed command —
if you typo an argument or forget one, `tsc` catches it before you ever hit
Redis.

## Running locally (no Docker)

```bash
npm install
cp .env.example .env    # adjust as needed

# terminal 1: Redis
redis-server

# terminal 2: mock backend
cd mock-backend && npm install && npm run dev

# terminal 3: gateway
npm run dev

curl http://localhost:3000/api/search
curl http://localhost:3000/metrics
curl http://localhost:3000/stats
# open http://localhost:3000/dashboard
```

## Running the full stack with Docker Compose

```bash
docker compose up --build
```

This starts:

- `redis` — shared rate-limit state
- `mock-backend-1`, `mock-backend-2`, `mock-backend-3` — proxy targets
- `backend-nginx` — round-robin across the mock backends (`http://localhost:4000`)
- `gateway-1`, `gateway-2`, `gateway-3` — stateless gateway instances
- `nginx` — round-robin load balancer at `http://localhost:8080`
- `prometheus` at `http://localhost:9090` — scrapes each gateway's `/metrics`
- `grafana` at `http://localhost:3001` (login: `admin` / `admin`, or browse
anonymously) — dashboard "Rate Limiter Gateway" is auto-provisioned

```bash
curl http://localhost:8080/api/search
```

## Verifying distributed correctness

```bash
# fixed-window limit on /api is 100/60s -- fire 150 requests at the
# load-balanced endpoint and confirm the AGGREGATE limit holds across
# all 3 gateway instances, not per-instance
for i in $(seq 1 150); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/ping; done | sort | uniq -c
```

Expect roughly 100 `200`s and 50 `429`s, even though requests were spread
across 3 separate processes with no shared memory — only shared Redis state.

## Load testing

Limits are **per identity**, not a global request cap. Current rules
(`config/limits.json`):


| Route                       | Algorithm      | Keyed by    | Limit                |
| --------------------------- | -------------- | ----------- | -------------------- |
| `/api/search`               | token bucket   | IP          | burst 10, then 2/sec |
| `/api/orders`               | sliding window | `x-api-key` | 30 / 60s             |
| `/api/ping` (prefix `/api`) | fixed window   | IP          | 100 / 60s            |


`scripts/load-test.mjs` sends keep-alive HTTP requests from **worker
threads** so the generator itself is not the bottleneck. The main thread
only spawns workers, merges their histograms, and prints the combined
report. Each worker has its own event loop and `http.Agent`.

Unless you pass `--clients`, `--concurrency`, or `--workers`, those
scale automatically:

- **workers** = CPU count, clamped to 1–8 (`--workers` overrides).
- **clients** = `ceil(count / 50)`, capped at 50,000. Each client gets
its own `X-Forwarded-For` IP and `x-api-key`. The cap used to be 1,000,
which pinned high-volume runs against per-identity limits.
- **concurrency** = total in-flight requests **across all workers**,
then split evenly:
  - 10 (≤100 requests)
  - 25 (≤1k)
  - 50 (≤10k)
  - 100 (≤50k)
  - 200 (≤200k)
  - 400 otherwise

So `npm run loadtest -- 100` uses **2 clients** and concurrency **10**.
Traffic is mixed across the three routes (~50% search, ~30% ping, ~20%
orders). `npm run loadtest -- 1000000` uses **20,000 clients** and
concurrency **400**.

There is no fixed duration: workers fire the next request as soon as one
completes. Wall-clock time and req/s are measured at the end.

Gateway must already be running (`npm run dev`, or `docker compose up`
and pass `--port 8080`).

```bash
# scale up; clients, concurrency, and workers auto-scale
npm run loadtest -- 100
npm run loadtest -- 1000
npm run loadtest -- 10000
npm run loadtest -- 50000
npm run loadtest -- 1000000

# docker-compose cluster (Nginx); extra workers for a 1M run
npm run loadtest -- 1000000 --port 8080 --workers 4

# force 429s: one identity, one route (token-bucket burst of 10)
npm run loadtest -- 100 --clients 1 --path /api/search

# override defaults
npm run loadtest -- 1000 --clients 50 --concurrency 25 --workers 2

# Full command
npm run loadtest -- 50000 --port 8080 --workers 4 --concurrency 150 --clients 2000

# ladder in one shot (prints a comparison table)
npm run loadtest -- --steps 100,1000,10000,50000,1000000
```

Each run prints worker count, throughput, HTTP 200 vs 429, and
p50/p95/p99 latency, curls `GET /stats`, and **appends** the summary to
`load-test-results.json` (keeps the last 5 runs: `{ "runs": [ ... ] }`).
Older file shapes (a single run object) are migrated on the next write.

## Dashboard

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
while the gateway is running. The page can start a load test (spawns
`scripts/load-test.mjs` as a child process) and charts the last 5 runs
(throughput, deny %, p50/p99). CLI runs write the same file, so they
show up on the dashboard too.

Only one test can run at a time; a second start returns HTTP 409.

## Metrics

`GET /metrics` is Prometheus text (scraped by Prometheus, graphed in
Grafana). It is intentionally small — no Node heap-space / GC dump.

`GET /stats` is the same data as JSON:

```bash
curl -s http://localhost:3000/stats | jq
```


| Metric                                              | Meaning                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `gateway_requests_total{route, algorithm, outcome}` | Volume + allow / deny / fail-open split         |
| `gateway_redis_check_seconds{algorithm}`            | Time spent in the Redis Lua rate-limit check    |
| `gateway_request_duration_seconds{route, outcome}`  | End-to-end latency, including 429s              |
| `gateway_in_flight_requests`                        | Requests currently in progress on this instance |
| `gateway_memory_rss_bytes`                          | Resident set size                               |
| `gateway_event_loop_lag_seconds`                    | Event-loop lag                                  |


`outcome` is `allowed`, `denied`, or `fail_open`.

Grafana (auto-provisioned) shows totals, deny %, Redis p99, RSS, RPS by
outcome, and latency percentiles.

## Config-driven routing

Edit `config/limits.json` to add routes or change algorithms/limits — the
gateway hot-reloads it every 5 seconds (see `loadConfig.ts`), no restart
needed.

## Design decisions

- **Fail-open on Redis errors**: if Redis is unreachable, requests are
allowed through rather than taking down the whole API. Fail-closed is the
stricter alternative.
- **Why Lua scripts, not multi-step Node logic**: atomicity across
concurrent gateway instances. See the comment block in `tokenBucket.lua`.
- **Why a factory specifically, not a switch statement**: the mapping from
config string to algorithm class needed to live in exactly one place, be
type-checked, and be extensible without touching the middleware.
- **BACKEND_TARGET env override**: same `limits.json` works unmodified in
local dev (`localhost:4000`) and Docker Compose
(`http://backend-nginx:80`, which round-robins three mock backends).

## Verified

- `npm run typecheck` passes with `strict: true`
- `npm run build` produces a clean `dist/`, Lua scripts copied alongside
- Smoke-tested end to end: token bucket on `/api/search` (capacity 10)
correctly allowed exactly 10 requests then returned `429` for the next
requests, confirmed via HTTP status codes, `GET /stats`, and `GET /metrics`

## Next steps / stretch goals

- Add a fourth algorithm (leaky bucket) to prove the factory extends cleanly
- Add Grafana alerting rules on block rate or p99 latency
- Add per-user limiting via JWT claims instead of a raw API key header
- Add a Prometheus alertmanager config for on-call style alerting

