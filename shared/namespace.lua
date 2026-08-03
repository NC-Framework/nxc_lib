--- Nexus Core shared primitives.
---
--- Every module in this resource attaches to the single `Nxc` namespace. The
--- numeric filename prefixes control load order, because `shared_scripts` globs
--- alphabetically and a module may depend on one loaded before it.
---
--- `nxc_lib` owns no gameplay domain. Nothing here reads or writes another
--- resource's state, and no generic database helper lives here — a helper that
--- can write any table is a boundary violation generator.

Nxc = Nxc or {}

--- Resource identity, used by the logger and the health interface so records
--- carry their origin without every call site repeating it.
Nxc.RESOURCE = 'nxc_lib'
--- Read from the manifest so the version is stated ONCE.
---
--- It used to be a literal here as well as in fxmanifest.lua, and they drifted:
--- the manifest said one thing while every log line said another. Two sources of
--- truth for a version is one source of truth and one rumour.
---
--- The fallback is for the test harness, where no natives exist. It is the only
--- place a literal can still be wrong, and there it cannot mislead an operator.
Nxc.VERSION = (type(GetResourceMetadata) == 'function'
    and GetResourceMetadata(GetCurrentResourceName(), 'version', 0))
    or '0.0.0-test'

--- Contract version of the surface other resources consume.
---
--- Every resource loads these modules into its OWN Lua state, so two resources
--- can be running two different copies of nxc_lib at once — whichever was on
--- disk when each was last deployed. Nothing makes them agree.
---
--- v2 (2026-08-03) added Nxc.Persistence and Nxc.Migrations, moved here from
--- nxc_core.
---
--- v3 (2026-08-03) added Nxc.plain, which every resource needs the moment it
--- returns a Result through an export. Additive, and a consumer that needs it
--- must be able to say so.
---
--- Incremented when the shared surface changes incompatibly. A consumer asserts
--- the minimum it needs at startup, so a stale copy fails by name instead of as
--- `attempt to call a nil value` at whatever line first touches a new function.
Nxc.CONTRACT_VERSION = 3

--- Freeze a table against accidental mutation.
---
--- Used for value objects that cross a resource boundary. A caller that mutates
--- a returned error or envelope would corrupt the sender's copy, because Lua
--- passes tables by reference.
---
---@generic T: table
---@param t T
---@return T
--- A plain deep copy, safe to send across a resource boundary.
---
--- **`Nxc.freeze` produces a table that is RAW-EMPTY.** It is
--- `setmetatable({}, { __index = t })`, so its contents are reachable only
--- through the metatable. `pairs` sees them because of `__pairs`; `next` does
--- not, and neither does any serialiser, because they walk the table itself.
---
--- FiveM marshals export arguments and return values, so a frozen table — every
--- `Result` is one — crosses a resource boundary as `{}`. The consumer receives a
--- table with no `ok` field and reports the call as failed while the producer
--- logs success.
---
--- Found exactly that way on a real server: nxc_config logged a registration as
--- accepted in the same tick that nxc_core logged it as refused.
---
--- **Nothing in-process needs this.** It is required only at a boundary, which is
--- also why no test caught it: in one Lua state the metatable works perfectly.
---
---@param value any
---@return any
function Nxc.plain(value)
    if type(value) ~= 'table' then return value end

    local out = {}
    -- `pairs` rather than `next`, deliberately: it is the metatable-aware form,
    -- and reading a frozen table is the entire point.
    for key, item in pairs(value) do
        out[Nxc.plain(key)] = Nxc.plain(item)
    end
    return out
end

function Nxc.freeze(t)
    return setmetatable({}, {
        __index = t,
        __newindex = function()
            error('attempt to modify a frozen table', 2)
        end,
        __pairs = function()
            return next, t, nil
        end,
        __len = function()
            return #t
        end,
        __metatable = false,
    })
end

--- Shallow copy. Present so callers do not hand-roll one and accidentally share
--- nested references they meant to detach.
---
---@param t table
---@return table
function Nxc.shallowCopy(t)
    local out = {}
    for k, v in pairs(t) do
        out[k] = v
    end
    return out
end

return Nxc
