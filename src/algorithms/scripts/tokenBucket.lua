-- Token bucket: refills continuously at refillRatePerSec, allows bursts up
-- to bucketCapacity. State is stored as a hash: { tokens, lastRefillTimeMs }.
--
-- KEYS[1] = bucket key, e.g. "ratelimit:token:{ip}:{route}"
-- ARGV[1] = bucket capacity (max tokens / max burst size)
-- ARGV[2] = refill rate in tokens per second
-- ARGV[3] = current time in milliseconds (passed in, not read from server,
--           so behavior is deterministic and testable)
-- ARGV[4] = tokens requested for this call (usually 1)
--
-- Returns: { allowed (1/0), remainingTokens, retryAfterMs }
--
-- This whole check-refill-consume sequence MUST be atomic. If we did this as
-- separate GET / compute / SET calls from Node, two gateway instances could
-- both read "5 tokens left", both decide to allow, and both decrement --
-- letting through double the intended rate. Running it as one Lua script
-- means Redis executes it as a single atomic step server-side.

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(bucket[1])
local lastRefillMs = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  lastRefillMs = now
end

-- refill based on elapsed time since last check
local elapsedSec = math.max(0, (now - lastRefillMs) / 1000)
local refilled = math.min(capacity, tokens + (elapsedSec * refillRate))

local allowed = 0
local retryAfterMs = 0

if refilled >= requested then
  refilled = refilled - requested
  allowed = 1
else
  local deficit = requested - refilled
  retryAfterMs = math.ceil((deficit / refillRate) * 1000)
end

redis.call('HMSET', key, 'tokens', refilled, 'lastRefillMs', now)
-- expire the key if idle long enough to fully refill anyway (keeps Redis clean)
local ttlSec = math.ceil(capacity / refillRate) + 60
redis.call('EXPIRE', key, ttlSec)

return { allowed, math.floor(refilled), retryAfterMs }
