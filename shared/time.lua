--- Time and formatting utilities.
---
--- Centralised so that duration arithmetic, timestamp formatting, and money
--- rendering are done one way everywhere. Money in particular: it is stored as
--- integer minor units and must never be reconstructed with floating point.

local Time = {}

Time.SECOND = 1000
Time.MINUTE = 60 * Time.SECOND
Time.HOUR = 60 * Time.MINUTE
Time.DAY = 24 * Time.HOUR

--- **`os` DOES NOT EXIST ON THE FIVEM CLIENT.**
---
--- CitizenFX gives the client runtime a reduced standard library and `os` is not
--- in it. Shared code calling `os.time` or `os.date` works perfectly on the
--- server and dies on the client with `attempt to index a nil value (global
--- 'os')`.
---
--- Found in deployment, and it failed twice over: `/nxcui confirm` crashed in
--- `Focus.acquire` reaching for the clock, and the log line reporting THAT crash
--- crashed as well, in the logger's own timestamp. A diagnostic that cannot
--- report its own failure is worse than none.
---
--- Every test missed it because wasmoon is plain Lua 5.4, where `os` is present.
--- The test runtime was more capable than the target runtime, which is the one
--- direction a harness must never be trusted in.

---@return number|nil  Unix milliseconds, or nil where the runtime has no wall clock
local function wallNowMs()
    if type(os) == 'table' and type(os.time) == 'function' then
        return math.floor(os.time() * 1000)
    end
    -- Guarded rather than assumed. Assuming a native exists is how this file
    -- came to be written twice.
    if type(GetCloudTimeAsInt) == 'function' then
        local seconds = GetCloudTimeAsInt()
        if type(seconds) == 'number' and seconds > 0 then return seconds * 1000 end
    end
    return nil
end

---@return number|nil  Monotonic milliseconds since the runtime started
local function monoNowMs()
    if type(GetGameTimer) == 'function' then return GetGameTimer() end
    return nil
end

--- Anchored once, so wall-clock time gains millisecond resolution.
---
--- `os.time` and `GetCloudTimeAsInt` are both whole seconds. A clock that jumps
--- once a second and is flat in between makes every duration measured against it
--- wrong by up to a second — which for a rate limiter or a focus timestamp is
--- the difference between a bound and a suggestion.
local anchorWallMs = wallNowMs()
local anchorMonoMs = monoNowMs()

local function defaultClock()
    if anchorWallMs and anchorMonoMs then
        return anchorWallMs + (monoNowMs() - anchorMonoMs)
    end
    -- No anchor pair: use whichever single source exists. A monotonic-only
    -- runtime yields time since start rather than time since 1970, which is
    -- correct for durations and visibly wrong as a date — better than a
    -- plausible fabrication.
    return wallNowMs() or monoNowMs() or 0
end

--- Whether this runtime can tell the actual time.
---
--- Exposed so a caller that genuinely needs a date can ask, rather than
--- discovering from a timestamp in 1970.
Time.HAS_WALL_CLOCK = anchorWallMs ~= nil

--- Injectable clock. Tests substitute a deterministic source; a test that
--- depends on wall-clock time is a test that fails intermittently and then gets
--- ignored.
local clock = defaultClock

--- Replace the clock. Test-only.
---
---@param fn fun(): number
function Time.setClock(fn)
    if type(fn) ~= 'function' then
        error('Time.setClock requires a function', 2)
    end
    clock = fn
end

--- Restore the real clock.
function Time.resetClock()
    clock = defaultClock
end

--- Current time in milliseconds.
---
---@return number
function Time.nowMs()
    return clock()
end

--- Current time in seconds.
---
---@return number
function Time.nowSeconds()
    return math.floor(clock() / 1000)
end

--- Civil date from a day count since 1970-01-01.
---
--- Hinnant's algorithm, valid across the whole proleptic Gregorian calendar.
---
--- Written out rather than delegated to `os.date`, which does not exist on the
--- client. One implementation that runs everywhere beats a branch that is only
--- ever exercised on one side — the untaken branch is where this defect lived.
---
---@param days number
---@return number, number, number
local function civilFromDays(days)
    local z = days + 719468
    local era = math.floor(z / 146097)
    local doe = z - era * 146097
    local yoe = math.floor(
        (doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
    local year = yoe + era * 400
    local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
    local mp = math.floor((5 * doy + 2) / 153)
    local day = doy - math.floor((153 * mp + 2) / 5) + 1
    local month = mp < 10 and mp + 3 or mp - 9
    if month <= 2 then year = year + 1 end
    return year, month, day
end

--- ISO 8601 timestamp in UTC, millisecond precision.
---
---@param ms number|nil
---@return string
function Time.iso8601(ms)
    ms = ms or clock()

    local totalSeconds = math.floor(ms / 1000)
    local millis = math.floor(ms % 1000)
    local days = math.floor(totalSeconds / 86400)
    local secondsOfDay = totalSeconds - days * 86400

    local year, month, day = civilFromDays(days)
    return ('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ'):format(
        year, month, day,
        math.floor(secondsOfDay / 3600),
        math.floor(secondsOfDay % 3600 / 60),
        math.floor(secondsOfDay % 60),
        millis)
end

--- Whether a deadline has passed.
---
---@param deadlineMs number
---@param nowMs number|nil
---@return boolean
function Time.hasElapsed(deadlineMs, nowMs)
    return (nowMs or clock()) >= deadlineMs
end

--- Milliseconds remaining until a deadline, never negative.
---
---@param deadlineMs number
---@param nowMs number|nil
---@return number
function Time.remaining(deadlineMs, nowMs)
    local left = deadlineMs - (nowMs or clock())
    return left > 0 and left or 0
end

--- Human-readable duration: "2h 15m", "45s".
---
---@param ms number
---@return string
function Time.formatDuration(ms)
    if ms < 0 then ms = 0 end
    if ms < Time.SECOND then
        return ('%dms'):format(math.floor(ms))
    end
    local parts = {}
    local remaining = math.floor(ms)
    local units = {
        { Time.DAY, 'd' }, { Time.HOUR, 'h' }, { Time.MINUTE, 'm' }, { Time.SECOND, 's' },
    }
    for _, unit in ipairs(units) do
        local size, suffix = unit[1], unit[2]
        if remaining >= size then
            local count = math.floor(remaining / size)
            remaining = remaining - (count * size)
            parts[#parts + 1] = ('%d%s'):format(count, suffix)
        end
        if #parts == 2 then break end
    end
    return table.concat(parts, ' ')
end

--- Format integer minor units as currency.
---
--- Money is stored as integer minor units precisely so it never becomes a float.
--- This function does the division for display only, and rejects a fractional
--- input rather than rounding it, because a fractional minor unit means an
--- arithmetic bug upstream.
---
---@param cents integer
---@param symbol string|nil
---@return string
function Time.formatMoney(cents, symbol)
    if type(cents) ~= 'number' or cents % 1 ~= 0 then
        error('money must be an integer number of minor units, got ' .. tostring(cents), 2)
    end
    symbol = symbol or '$'
    local negative = cents < 0
    local abs = math.abs(cents)
    local whole = math.floor(abs / 100)
    local frac = abs % 100

    -- Thousands separators, applied to the string so no float is involved.
    local s = tostring(whole)
    local grouped = s:reverse():gsub('(%d%d%d)', '%1,'):reverse():gsub('^,', '')

    return ('%s%s%s.%02d'):format(negative and '-' or '', symbol, grouped, frac)
end

Nxc.Time = Time
return Time
