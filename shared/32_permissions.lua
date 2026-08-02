--- Capability-based permission interface.
---
--- Gameplay logic never compares rank name strings. Authorization is always a
--- capability check, because the alternative scatters the rule across every
--- place that compares a grade and breaks the moment a department renames one.
---
--- This is an *interface*. `nexus_core` owns capability grants and resolution;
--- `nxc_lib` provides the shape and the check helper so every resource asks the
--- same way.

local Permissions = {}

local CAPABILITY_PATTERN = '^[%l][%l%d]*%.[%l][%l%d_]*%.[%l][%l%d_]*$'

Permissions.RISK = {
    LOW = 'low', MEDIUM = 'medium', HIGH = 'high', CRITICAL = 'critical',
}

local registry = {}

-- Resolver supplied by nexus_core. Until one is installed, every check denies:
-- a permission system that fails open is worse than one that is absent.
local resolver = nil

--- Install the capability resolver. Called by `nexus_core`.
---
---@param fn fun(actor: any, capability: string): boolean
function Permissions.setResolver(fn)
    if type(fn) ~= 'function' then
        error('Permissions.setResolver requires a function', 2)
    end
    resolver = fn
end

--- Register a capability.
---
---@param spec { name: string, description: string, resource: string, risk: string, defaultGrants?: string[], audited?: boolean }
function Permissions.register(spec)
    if type(spec) ~= 'table' then
        error('Permissions.register requires a spec', 2)
    end
    if type(spec.name) ~= 'string' or not spec.name:match(CAPABILITY_PATTERN) then
        error('a capability must be <domain>.<object>.<action> in lowercase, got '
            .. tostring(spec.name), 2)
    end
    if type(spec.description) ~= 'string' or spec.description == '' then
        error('a capability requires a description: it is what an operator reads '
            .. 'when deciding whether to grant it', 2)
    end
    if not Permissions.RISK[(spec.risk or ''):upper()] then
        error('a capability requires a risk classification', 2)
    end
    if registry[spec.name] then
        error('capability already registered: ' .. spec.name, 2)
    end

    -- A critical capability is always audited; letting a caller opt out would
    -- make the classification meaningless.
    local audited = spec.audited
    if spec.risk == Permissions.RISK.CRITICAL then audited = true end

    registry[spec.name] = Nxc.freeze({
        name = spec.name,
        description = spec.description,
        resource = spec.resource or Nxc.RESOURCE,
        risk = spec.risk,
        defaultGrants = spec.defaultGrants or {},
        audited = audited == true,
    })
end

---@param name string
---@return table|nil
function Permissions.get(name)
    return registry[name]
end

---@return table[]
function Permissions.all()
    local out = {}
    for _, spec in pairs(registry) do out[#out + 1] = spec end
    table.sort(out, function(a, b) return a.name < b.name end)
    return out
end

--- Whether an actor holds a capability.
---
--- Denies when no resolver is installed, and denies for an unregistered
--- capability — a typo in a capability name must not become an open door.
---
---@param actor any
---@param capability string
---@return boolean
function Permissions.has(actor, capability)
    if not resolver then return false end
    if not registry[capability] then return false end
    local ok, allowed = pcall(resolver, actor, capability)
    if not ok then return false end
    return allowed == true
end

--- Check a capability, returning a Result.
---
--- The shape most call sites want: a denial is already a structured error with
--- the capability recorded in `details`.
---
---@param actor any
---@param capability string
---@param correlationId string|nil
---@return NxcResult
function Permissions.require(actor, capability, correlationId)
    if Permissions.has(actor, capability) then
        return Nxc.Result.ok(true)
    end
    return Nxc.Result.err(Nxc.Errors.forbidden(capability, correlationId))
end

--- Test helper: clear the registry and resolver.
function Permissions.reset()
    registry = {}
    resolver = nil
end

Nxc.Permissions = Permissions
return Permissions
