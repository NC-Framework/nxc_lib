--- Rate limiting.
---
--- Anything a client can call, a client can call in a loop. Every
--- client-callable RPC and event has a limit, stated in its contract entry
--- rather than left implicit.
---
--- A token bucket, so a caller may burst up to the bucket size and then settles
--- to the refill rate. A fixed window would let a caller send a full window's
--- worth at the end of one window and again at the start of the next.

local RateLimit = {}

---@class NxcRateLimiter
local Limiter = {}
Limiter.__index = Limiter

--- Create a limiter.
---
---@param opts { capacity: integer, refillPerSecond: number, now?: fun(): number }
---@return NxcRateLimiter
function RateLimit.new(opts)
    if type(opts) ~= 'table' then
        error('RateLimit.new requires options', 2)
    end
    if type(opts.capacity) ~= 'number' or opts.capacity < 1 then
        error('capacity must be at least 1', 2)
    end
    if type(opts.refillPerSecond) ~= 'number' or opts.refillPerSecond <= 0 then
        error('refillPerSecond must be greater than zero', 2)
    end

    return setmetatable({
        capacity = opts.capacity,
        refillPerSecond = opts.refillPerSecond,
        now = opts.now or function() return Nxc.Time.nowMs() end,
        buckets = {},
    }, Limiter)
end

local function bucketFor(self, key, nowMs)
    local b = self.buckets[key]
    if not b then
        b = { tokens = self.capacity, updated = nowMs }
        self.buckets[key] = b
        return b
    end

    local elapsed = nowMs - b.updated
    if elapsed > 0 then
        local refill = (elapsed / 1000) * self.refillPerSecond
        b.tokens = math.min(self.capacity, b.tokens + refill)
        b.updated = nowMs
    end
    return b
end

--- Consume a token for a key.
---
--- The key is the actor, not the operation — limits are per actor per operation,
--- and one limiter instance serves one operation.
---
---@param key string
---@return boolean allowed, number retryAfterMs
function Limiter:allow(key)
    local nowMs = self.now()
    local b = bucketFor(self, key, nowMs)

    if b.tokens >= 1 then
        b.tokens = b.tokens - 1
        return true, 0
    end

    local needed = 1 - b.tokens
    local waitMs = math.ceil((needed / self.refillPerSecond) * 1000)
    return false, waitMs
end

--- Tokens currently available for a key. Diagnostic; does not consume.
---
---@param key string
---@return number
function Limiter:available(key)
    return bucketFor(self, key, self.now()).tokens
end

--- Forget a key. Called when an actor disconnects, so the table does not grow
--- without bound over a long uptime.
---
---@param key string
function Limiter:forget(key)
    self.buckets[key] = nil
end

--- Drop buckets untouched for longer than `idleMs` and already full.
---
--- Without this, a long-running server accumulates one bucket per actor that has
--- ever called the operation. An unbounded structure in a hot path is a slow
--- leak rather than an obvious failure.
---
---@param idleMs number
---@return integer removed
function Limiter:prune(idleMs)
    local nowMs = self.now()
    local removed = 0
    for key, b in pairs(self.buckets) do
        if (nowMs - b.updated) > idleMs then
            local elapsed = nowMs - b.updated
            local tokens = math.min(self.capacity, b.tokens + (elapsed / 1000) * self.refillPerSecond)
            if tokens >= self.capacity then
                self.buckets[key] = nil
                removed = removed + 1
            end
        end
    end
    return removed
end

--- Number of tracked keys. Diagnostic.
---
---@return integer
function Limiter:size()
    local n = 0
    for _ in pairs(self.buckets) do n = n + 1 end
    return n
end

Nxc.RateLimit = RateLimit
return RateLimit
