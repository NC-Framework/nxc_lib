--- Safe serialization helpers.
---
--- Two jobs: bound the size of anything crossing a boundary, and redact values
--- that must never be written to a log or sent to a client.
---
--- Redaction happens here, at the call site, rather than at a downstream sink. A
--- value that reaches the log pipeline has already left the process, and a
--- downstream filter is one misconfiguration away from failing.

local Serialize = {}

--- Keys whose values are replaced wherever they appear, at any depth.
---
--- Matched case-insensitively against the key name. Deliberately broad: a false
--- positive costs a redacted debug field, a false negative costs a rotation.
Serialize.REDACT_KEYS = {
    'password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'accesskey',
    'access_key', 'authorization', 'auth', 'credential', 'connectionstring',
    'connection_string', 'webhook', 'webhookurl', 'privatekey', 'private_key',
    'sessiontoken', 'session_token', 'signingkey', 'signing_key',
}

Serialize.REDACTED = '[redacted]'

local MAX_DEPTH = 8

local redactSet = {}
for _, k in ipairs(Serialize.REDACT_KEYS) do
    redactSet[k] = true
end

local function shouldRedact(key)
    if type(key) ~= 'string' then return false end
    return redactSet[key:lower()] == true
end

--- Deep copy with sensitive values replaced.
---
--- Also truncates over-long strings, so a log record cannot be inflated by an
--- attacker-supplied field.
---
---@param value any
---@param maxStringLength integer|nil
---@return any
function Serialize.redact(value, maxStringLength)
    maxStringLength = maxStringLength or 512

    local function walk(v, depth)
        if depth > MAX_DEPTH then return '[truncated: too deep]' end
        local t = type(v)
        if t == 'string' then
            if #v > maxStringLength then
                return v:sub(1, maxStringLength) .. ('... [%d more]'):format(#v - maxStringLength)
            end
            return v
        elseif t == 'table' then
            local out = {}
            for k, sub in pairs(v) do
                if shouldRedact(k) then
                    out[k] = Serialize.REDACTED
                else
                    out[k] = walk(sub, depth + 1)
                end
            end
            return out
        elseif t == 'number' or t == 'boolean' or t == 'nil' then
            return v
        else
            -- Functions, userdata, and threads have no meaningful serialization
            -- and may close over anything. Never emit them.
            return '[' .. t .. ']'
        end
    end

    return walk(value, 1)
end

--- Approximate serialized size in bytes.
---
--- Used to bound envelopes before they reach a transport. It is an estimate, not
--- an exact encoding length: exactness is not needed to enforce a ceiling, and
--- computing it would mean serializing twice.
---
---@param value any
---@return integer
function Serialize.approximateSize(value)
    local total = 0

    local function walk(v, depth)
        if depth > MAX_DEPTH then
            total = total + 16
            return
        end
        local t = type(v)
        if t == 'string' then
            total = total + #v + 2
        elseif t == 'number' then
            total = total + 8
        elseif t == 'boolean' then
            total = total + 4
        elseif t == 'nil' then
            total = total + 4
        elseif t == 'table' then
            total = total + 2
            for k, sub in pairs(v) do
                if type(k) == 'string' then
                    total = total + #k + 3
                else
                    total = total + 8
                end
                walk(sub, depth + 1)
            end
        else
            total = total + 8
        end
    end

    walk(value, 1)
    return total
end

--- Whether a value contains only types that survive a network boundary.
---
--- Functions, userdata, threads, and cycles do not. Catching them here produces
--- a clear failure instead of a transport-level one that names no field.
---
---@param value any
---@return boolean, string|nil
function Serialize.isTransportable(value)
    local seen = {}

    local function walk(v, depth, path)
        if depth > MAX_DEPTH then
            return false, path .. ' is nested too deeply'
        end
        local t = type(v)
        if t == 'function' or t == 'userdata' or t == 'thread' then
            return false, path .. ' is a ' .. t
        end
        if t == 'table' then
            if seen[v] then
                return false, path .. ' contains a cycle'
            end
            seen[v] = true
            for k, sub in pairs(v) do
                local kt = type(k)
                if kt ~= 'string' and kt ~= 'number' then
                    return false, path .. ' has a ' .. kt .. ' key'
                end
                local ok, reason = walk(sub, depth + 1, path .. '.' .. tostring(k))
                if not ok then return false, reason end
            end
            seen[v] = nil
        end
        return true, nil
    end

    return walk(value, 1, '(root)')
end

Nxc.Serialize = Serialize
return Serialize
