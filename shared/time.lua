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

--- Injectable clock. Tests substitute a deterministic source; a test that
--- depends on wall-clock time is a test that fails intermittently and then gets
--- ignored.
local clock = function()
    return math.floor(os.time() * 1000)
end

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
    clock = function() return math.floor(os.time() * 1000) end
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

--- ISO 8601 timestamp in UTC, millisecond precision.
---
---@param ms number|nil
---@return string
function Time.iso8601(ms)
    ms = ms or clock()
    local seconds = math.floor(ms / 1000)
    local millis = math.floor(ms % 1000)
    return os.date('!%Y-%m-%dT%H:%M:%S', seconds) .. ('.%03dZ'):format(millis)
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
