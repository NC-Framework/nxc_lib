--- Correlation identifiers.
---
--- A correlation id is generated at the start of a logical operation and
--- propagated through every event, RPC, log record, and audit entry it produces
--- — including those produced in other resources.
---
--- Without it, a failed purchase is several unrelated log lines. With it, it is
--- one reconstructible sequence, which is what `nxc_devtools` correlation lookup
--- and every post-incident investigation depend on.

local Correlation = {}

local ALPHABET = '0123456789abcdef'
local PREFIX = 'c-'
local ID_BODY_LENGTH = 16

-- A monotonic counter guarantees uniqueness within a session even if two ids
-- are generated in the same millisecond with the same random state. Randomness
-- alone is not sufficient at high call rates.
local counter = 0

local seeded = false
local function ensureSeeded()
    if seeded then return end
    seeded = true
    -- os.time alone gives every server the same seed on a synchronised restart,
    -- so mix in the address of a fresh table for per-process entropy.
    local addr = tostring({}):match('0x(%x+)') or '0'
    math.randomseed((os.time() % 2147483647) ~ (tonumber(addr, 16) or 0))
end

local function randomHex(n)
    ensureSeeded()
    local out = {}
    for i = 1, n do
        local idx = math.random(1, #ALPHABET)
        out[i] = ALPHABET:sub(idx, idx)
    end
    return table.concat(out)
end

--- Generate a correlation id for a new operation.
---
--- Format: `c-` followed by 16 hexadecimal characters. The last four encode a
--- counter, so two ids generated in the same tick cannot collide.
---
---@return string
function Correlation.new()
    counter = (counter + 1) % 0x10000
    return PREFIX .. randomHex(ID_BODY_LENGTH - 4) .. ('%04x'):format(counter)
end

--- Derive a child id for a sub-operation of an existing one.
---
--- Keeps the parent's body so a search on the parent finds the whole tree, and
--- appends a suffix so the individual step is still distinguishable.
---
---@param parent string
---@param index integer|nil
---@return string
function Correlation.child(parent, index)
    if not Correlation.isValid(parent) then
        error('Correlation.child requires a valid parent id', 2)
    end
    counter = (counter + 1) % 0x10000
    return parent .. '.' .. ('%x'):format(index or counter)
end

--- The root of a possibly-derived id.
---
---@param id string
---@return string
function Correlation.root(id)
    local root = id:match('^([^.]+)')
    return root or id
end

--- Whether a value is a well-formed correlation id.
---
--- Envelopes validate this on receipt: an id arriving from a client is
--- attacker-controlled, and an unvalidated one ends up in log records and audit
--- trails where it can be used to make a search return the wrong operation.
---
---@param id any
---@return boolean
function Correlation.isValid(id)
    if type(id) ~= 'string' then return false end
    if #id > 64 then return false end
    return id:match('^c%-%x' .. ('%x'):rep(ID_BODY_LENGTH - 1) .. '$') ~= nil
        or id:match('^c%-%x+%.[%x%.]+$') ~= nil
end

--- Return the id if valid, otherwise a fresh one.
---
--- Used at trust boundaries: a client-supplied id is accepted for continuity
--- when it is well-formed, and quietly replaced when it is not, so a malformed
--- value never propagates into an audit record.
---
---@param id any
---@return string
function Correlation.coerce(id)
    if Correlation.isValid(id) then return id end
    return Correlation.new()
end

Nxc.Correlation = Correlation
return Correlation
