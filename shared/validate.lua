--- Schema validation.
---
--- Every network-facing payload is validated at the boundary, before any logic
--- runs. Presence, type, range, and shape.
---
--- Validation is **not** authorization. A well-formed request from an actor
--- without the capability is a valid payload and a forbidden action. Both checks
--- are required, in that order.

local Validate = {}

local MAX_DEPTH = 8
local MAX_STRING = 4096
local MAX_TABLE_KEYS = 256

---@class NxcFieldSpec
---@field type string            'string' | 'number' | 'integer' | 'boolean' | 'table' | 'array'
---@field required boolean|nil   defaults to true
---@field min number|nil         numeric minimum, or minimum string length
---@field max number|nil         numeric maximum, or maximum string length
---@field pattern string|nil     Lua pattern a string must match
---@field oneOf table|nil        allowed values
---@field of NxcFieldSpec|nil    element spec for an array
---@field fields table|nil       nested field specs for a table

local function typeOf(v)
    local t = type(v)
    if t == 'number' then
        return (v % 1 == 0) and 'integer' or 'number'
    end
    return t
end

local function checkField(name, value, spec, errs, depth)
    if depth > MAX_DEPTH then
        errs[#errs + 1] = { field = name, reason = 'nested too deeply' }
        return
    end

    local required = spec.required
    if required == nil then required = true end

    if value == nil then
        if required then
            errs[#errs + 1] = { field = name, reason = 'is required' }
        end
        return
    end

    local actual = typeOf(value)

    if spec.type == 'array' then
        if actual ~= 'table' then
            errs[#errs + 1] = { field = name, reason = 'must be an array, got ' .. actual }
            return
        end
        local count = #value
        if spec.min and count < spec.min then
            errs[#errs + 1] = { field = name, reason = ('must have at least %d items'):format(spec.min) }
        end
        if spec.max and count > spec.max then
            errs[#errs + 1] = { field = name, reason = ('must have at most %d items'):format(spec.max) }
        end
        if spec.of then
            for i = 1, count do
                checkField(('%s[%d]'):format(name, i), value[i], spec.of, errs, depth + 1)
            end
        end
        return
    end

    -- 'number' accepts integers; 'integer' does not accept fractions.
    local ok = (actual == spec.type) or (spec.type == 'number' and actual == 'integer')
    if not ok then
        errs[#errs + 1] = { field = name, reason = ('must be a %s, got %s'):format(spec.type, actual) }
        return
    end

    if spec.type == 'string' then
        local len = #value
        if len > MAX_STRING then
            errs[#errs + 1] = { field = name, reason = 'exceeds the maximum string length' }
            return
        end
        if spec.min and len < spec.min then
            errs[#errs + 1] = { field = name, reason = ('must be at least %d characters'):format(spec.min) }
        end
        if spec.max and len > spec.max then
            errs[#errs + 1] = { field = name, reason = ('must be at most %d characters'):format(spec.max) }
        end
        if spec.pattern and not value:match(spec.pattern) then
            errs[#errs + 1] = { field = name, reason = 'is not in the expected format' }
        end
    elseif spec.type == 'number' or spec.type == 'integer' then
        -- NaN fails every comparison, so it must be caught explicitly rather
        -- than being silently accepted by the range checks below.
        if value ~= value then
            errs[#errs + 1] = { field = name, reason = 'must be a real number' }
            return
        end
        if value == math.huge or value == -math.huge then
            errs[#errs + 1] = { field = name, reason = 'must be finite' }
            return
        end
        if spec.min and value < spec.min then
            errs[#errs + 1] = { field = name, reason = ('must be at least %s'):format(spec.min) }
        end
        if spec.max and value > spec.max then
            errs[#errs + 1] = { field = name, reason = ('must be at most %s'):format(spec.max) }
        end
    elseif spec.type == 'table' then
        local keys = 0
        for _ in pairs(value) do keys = keys + 1 end
        if keys > MAX_TABLE_KEYS then
            errs[#errs + 1] = { field = name, reason = 'has too many keys' }
            return
        end
        if spec.fields then
            for key, sub in pairs(spec.fields) do
                checkField(name .. '.' .. key, value[key], sub, errs, depth + 1)
            end
        end
    end

    if spec.oneOf then
        local found = false
        for _, allowed in ipairs(spec.oneOf) do
            if value == allowed then found = true break end
        end
        if not found then
            errs[#errs + 1] = { field = name, reason = 'is not an allowed value' }
        end
    end
end

--- Validate a payload against a schema.
---
--- Returns a Result. On failure the error carries a `fields` list naming which
--- field failed and why — an operator or developer cannot fix an error that does
--- not say what is wrong.
---
--- Unknown keys are rejected. Silently ignoring them lets a caller believe a
--- misspelled field was applied.
---
---@param schema table<string, NxcFieldSpec>
---@param payload any
---@param correlationId string|nil
---@return NxcResult
function Validate.against(schema, payload, correlationId)
    if type(payload) ~= 'table' then
        return Nxc.Result.err(Nxc.Errors.validationFailed(
            { fields = { { field = '(payload)', reason = 'must be a table, got ' .. type(payload) } } },
            correlationId))
    end

    local errs = {}
    for name, spec in pairs(schema) do
        checkField(name, payload[name], spec, errs, 1)
    end

    for key in pairs(payload) do
        if schema[key] == nil then
            errs[#errs + 1] = { field = tostring(key), reason = 'is not a recognised field' }
        end
    end

    if #errs > 0 then
        return Nxc.Result.err(Nxc.Errors.validationFailed({ fields = errs }, correlationId))
    end
    return Nxc.Result.ok(payload)
end

--- Build a reusable validator for a schema.
---
---@param schema table<string, NxcFieldSpec>
---@return fun(payload: any, correlationId: string|nil): NxcResult
function Validate.compile(schema)
    return function(payload, correlationId)
        return Validate.against(schema, payload, correlationId)
    end
end

Nxc.Validate = Validate
return Validate
