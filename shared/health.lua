--- Resource health interface.
---
--- Each resource reports whether it has started, registered its configuration,
--- satisfied its dependencies, and reached a serviceable state. These are
--- distinct: a resource that started but never registered its configuration is
--- running on defaults, which is a different problem from one that failed to
--- start.

local Health = {}

Health.STATE = {
    STARTING = 'starting',
    DEGRADED = 'degraded',
    SERVICEABLE = 'serviceable',
    FAILED = 'failed',
}

local state = {
    resource = nil,
    version = nil,
    value = Health.STATE.STARTING,
    startedAt = nil,
    dependencies = {},
    configurationRegistered = false,
    detail = nil,
}

--- Initialise health tracking for this resource.
---
---@param opts { resource?: string, version?: string, dependencies?: string[] }|nil
function Health.init(opts)
    opts = opts or {}
    state.resource = opts.resource or Nxc.resourceName()
    state.version = opts.version or Nxc.VERSION
    state.value = Health.STATE.STARTING
    state.startedAt = Nxc.Time.nowMs()
    state.dependencies = {}
    state.configurationRegistered = false
    state.detail = nil

    for _, name in ipairs(opts.dependencies or {}) do
        state.dependencies[name] = { name = name, satisfied = false, optional = false }
    end
end

--- Declare a dependency.
---
--- An optional dependency that is absent produces `degraded`, not `failed`.
--- Degraded is normal, not an alarm: a resource reporting degraded because a
--- later-phase dependency does not exist yet is behaving correctly.
---
---@param name string
---@param optional boolean|nil
function Health.dependency(name, optional)
    state.dependencies[name] = {
        name = name,
        satisfied = false,
        optional = optional == true,
    }
end

---@param name string
---@param satisfied boolean
function Health.setDependency(name, satisfied)
    local dep = state.dependencies[name]
    if not dep then
        error('unknown dependency: ' .. tostring(name), 2)
    end
    dep.satisfied = satisfied == true
end

---@param registered boolean
function Health.setConfigurationRegistered(registered)
    state.configurationRegistered = registered == true
end

--- Mark the resource as failed, with a reason.
---
---@param detail string
function Health.fail(detail)
    state.value = Health.STATE.FAILED
    state.detail = detail
end

--- Recompute and return the current state.
---
---@return string
function Health.evaluate()
    if state.value == Health.STATE.FAILED then
        return state.value
    end

    local missingRequired, missingOptional = {}, {}
    for _, dep in pairs(state.dependencies) do
        if not dep.satisfied then
            if dep.optional then
                missingOptional[#missingOptional + 1] = dep.name
            else
                missingRequired[#missingRequired + 1] = dep.name
            end
        end
    end

    if #missingRequired > 0 then
        table.sort(missingRequired)
        state.value = Health.STATE.STARTING
        state.detail = 'waiting for ' .. table.concat(missingRequired, ', ')
    elseif #missingOptional > 0 then
        table.sort(missingOptional)
        state.value = Health.STATE.DEGRADED
        state.detail = 'optional dependency absent: ' .. table.concat(missingOptional, ', ')
    elseif not state.configurationRegistered then
        state.value = Health.STATE.DEGRADED
        state.detail = 'running on declared defaults; configuration not yet registered'
    else
        state.value = Health.STATE.SERVICEABLE
        state.detail = nil
    end

    return state.value
end

--- The full health report.
---
---@return table
function Health.report()
    local value = Health.evaluate()
    local deps = {}
    for _, dep in pairs(state.dependencies) do
        deps[#deps + 1] = { name = dep.name, satisfied = dep.satisfied, optional = dep.optional }
    end
    table.sort(deps, function(a, b) return a.name < b.name end)

    return {
        resource = state.resource,
        version = state.version,
        state = value,
        detail = state.detail,
        uptimeMs = state.startedAt and (Nxc.Time.nowMs() - state.startedAt) or 0,
        configurationRegistered = state.configurationRegistered,
        dependencies = deps,
    }
end

Nxc.Health = Health
return Health
