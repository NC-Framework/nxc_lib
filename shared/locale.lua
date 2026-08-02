--- Localization interface.
---
--- No user-facing string is hardcoded in logic. Retrofitting localization means
--- touching every file again; the cost of doing it from the start is a function
--- call.
---
--- Values are interpolated, never concatenated, because word order differs
--- between languages.

local Locale = {}

local strings = {}
local current = 'en'
local fallback = 'en'
local missing = {}

--- Load a table of strings for a locale.
---
---@param code string
---@param table_ table<string, string>
function Locale.load(code, table_)
    if type(code) ~= 'string' or type(table_) ~= 'table' then
        error('Locale.load requires a locale code and a table', 2)
    end
    strings[code] = strings[code] or {}
    for k, v in pairs(table_) do
        strings[code][k] = v
    end
end

---@param code string
function Locale.set(code)
    current = code
end

---@return string
function Locale.current()
    return current
end

--- Resolve a key, interpolating `{name}` placeholders.
---
--- A missing key falls back to the default locale and is recorded. It never
--- renders a raw key to a player and never renders an empty string — both look
--- like a bug to the player and hide one from the developer.
---
---@param key string
---@param values table<string, any>|nil
---@return string
function Locale.get(key, values)
    local text = (strings[current] and strings[current][key])
        or (strings[fallback] and strings[fallback][key])

    if not text then
        if not missing[key] then
            missing[key] = true
            if Nxc.Logger then
                Nxc.Logger.warn('locale.key.missing', { key = key, locale = current })
            end
        end
        -- Humanise the last segment rather than showing a dotted key.
        local leaf = key:match('([^.]+)$') or key
        text = (leaf:gsub('([a-z])([A-Z])', '%1 %2'):gsub('^%l', string.upper))
    end

    if values then
        text = text:gsub('{(%w+)}', function(name)
            local v = values[name]
            if v == nil then return '{' .. name .. '}' end
            return tostring(v)
        end)
    end

    return text
end

--- Keys requested but not found. Diagnostic, for finding gaps before players do.
---
---@return string[]
function Locale.missingKeys()
    local out = {}
    for k in pairs(missing) do out[#out + 1] = k end
    table.sort(out)
    return out
end

--- Test helper: forget all loaded strings and recorded misses.
function Locale.reset()
    strings = {}
    missing = {}
    current = 'en'
end

Nxc.Locale = Locale
return Locale
