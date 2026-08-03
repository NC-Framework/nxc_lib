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
Nxc.VERSION = '0.1.0'

--- Contract version of the surface other resources consume.
---
--- Every resource loads these modules into its OWN Lua state, so two resources
--- can be running two different copies of nxc_lib at once — whichever was on
--- disk when each was last deployed. Nothing makes them agree.
---
--- v2 (2026-08-03) added Nxc.Persistence and Nxc.Migrations, moved here from
--- nxc_core. Additive, so nothing breaks — but a consumer needing them must
--- require v2, and the version is how it says so.
---
--- Incremented when the shared surface changes incompatibly. A consumer asserts
--- the minimum it needs at startup, so a stale copy fails by name instead of as
--- `attempt to call a nil value` at whatever line first touches a new function.
Nxc.CONTRACT_VERSION = 2

--- Freeze a table against accidental mutation.
---
--- Used for value objects that cross a resource boundary. A caller that mutates
--- a returned error or envelope would corrupt the sender's copy, because Lua
--- passes tables by reference.
---
---@generic T: table
---@param t T
---@return T
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
