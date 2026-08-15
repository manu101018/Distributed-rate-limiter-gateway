-- Sliding window counter: approximates a true sliding log using two fixed
-- windows (previous + current) and weighting the previous window's count
-- by how much of it still overlaps the current sliding window.
--
-- KEYS[1] = current window counter key
-- KEYS[2] = previous window counter key
-- ARGV[1] = window size in seconds
-- ARGV[2] = max requests allowed per window
--
-- Returns: { allowed (1/0), remaining, resetAtEpochSeconds }

local currentKey = KEYS[1]
local prevKey = KEYS[2]
local window = tonumber(ARGV[1])
local maxRequests = tonumber(ARGV[2])

local now = tonumber(redis.call('TIME')[1])
local currentWindowStart = now - (now % window)
local elapsedInCurrent = now - currentWindowStart
local weightPrev = (window - elapsedInCurrent) / window

local prevCount = tonumber(redis.call('GET', prevKey)) or 0
local currentCount = tonumber(redis.call('GET', currentKey)) or 0

local estimatedCount = (prevCount * weightPrev) + currentCount

if estimatedCount >= maxRequests then
  local resetAt = currentWindowStart + window
  return { 0, 0, resetAt }
end

local newCurrent = redis.call('INCR', currentKey)
if newCurrent == 1 then
  -- keep counters around for 2x window so the "previous" lookup always works
  redis.call('EXPIRE', currentKey, window * 2)
end

local remaining = math.floor(maxRequests - estimatedCount - 1)
if remaining < 0 then remaining = 0 end
local resetAt = currentWindowStart + window

return { 1, remaining, resetAt }
