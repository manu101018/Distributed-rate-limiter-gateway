-- KEYS[1] = counter key, e.g. "ratelimit:fixed:{ip}:{route}"
-- ARGV[1] = window size in seconds
-- ARGV[2] = max requests allowed in the window
--
-- Returns: { allowed (1/0), remaining, resetAtEpochSeconds }

local key = KEYS[1]
local window = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])

local current = redis.call('INCR', key)

if current == 1 then
  -- first request in this window: start the expiry clock
  redis.call('EXPIRE', key, window)
end

local ttl = redis.call('TTL', key)
if ttl == -1 then
  -- safety net: key existed without a TTL somehow, fix it
  redis.call('EXPIRE', key, window)
  ttl = window
end

local resetAt = tonumber(redis.call('TIME')[1]) + ttl

if current > maxRequests then
  return { 0, 0, resetAt }
else
  return { 1, maxRequests - current, resetAt }
end
