--- Announcing this resource to nxc_core, and answering when asked about it.
---
--- **WHY THIS IS IN nxc_lib RATHER THAN IN EACH RESOURCE.** Every framework
--- resource has to initialise health tracking, decide when it is ready, and wait
--- for nxc_core before registering itself. Written six times that is six copies
--- of a retry loop to keep in step, and the copy that drifts is the one nobody
--- reads until a resource is missing from the health report.
---
--- **IT DOES NOT MAKE nxc_lib DEPEND ON nxc_core.** The reference is a resource
--- name and a `GetResourceState` call. nxc_lib loads, and every function here
--- works, on a server where nxc_core is absent — announcing simply reports that
--- there was nobody to announce to. A hard dependency would invert the layering;
--- a soft one is a client for a service that may not be there, which is what this
--- is.
---
--- Server-side. Service registration is server state, and a client asking which
--- services exist would be asking a question it cannot act on.

if not IsDuplicityVersion() then return end

local Service = {}

local CORE = 'nxc_core'

--- How long to wait for nxc_core before giving up, in milliseconds.
---
--- Startup order puts nxc_core second, so in an ordinary boot this waits one
--- tick. The budget is for the disordered cases: a resource restarted by hand
--- before the framework is up, or nxc_core still applying migrations.
local DEADLINE_MS = 30000

local announced = false

---@return boolean
function Service.isAnnounced() return announced end

--- Tell nxc_core this resource exists, once it can be told.
---
--- **NON-BLOCKING.** Returns immediately and does the waiting in its own thread,
--- because a resource that blocks its startup on another resource turns a slow
--- neighbour into a broken one.
---
--- The name is not passed. nxc_core attributes it from `GetInvokingResource()`,
--- so a resource cannot register under another's name — the same rule as zones,
--- target options, and configuration fields.
---
---@param spec { version?: string, contractVersion?: integer, capabilities?: string[] }|nil
function Service.announce(spec)
    spec = spec or {}

    CreateThread(function()
        local deadline = GetGameTimer() + DEADLINE_MS
        while GetResourceState(CORE) ~= 'started' and GetGameTimer() < deadline do
            Wait(250)
        end

        if GetResourceState(CORE) ~= 'started' then
            -- Said out loud. A resource missing from the health report because it
            -- never managed to announce looks identical to one that was never
            -- written, and the difference matters to whoever is debugging.
            Nxc.Logger.warn('service.announce_failed', {
                detail = ('%s did not start within %dms; this resource will not appear in the '
                    .. 'health report'):format(CORE, DEADLINE_MS),
            })
            return
        end

        local ok, result = pcall(function()
            return exports[CORE]:registerService({
                version = spec.version or Nxc.VERSION,
                contractVersion = spec.contractVersion,
                capabilities = spec.capabilities,
            })
        end)

        if not ok or type(result) ~= 'table' or result.ok ~= true then
            Nxc.Logger.warn('service.announce_refused', {
                detail = ok and (type(result) == 'table' and result.error and result.error.code
                    or 'registerService returned nothing usable')
                    or 'registerService raised an error',
            })
            return
        end

        announced = true

        -- Registration and readiness are separate states, and a resource with no
        -- asynchronous startup reaches the second the moment it reaches the
        -- first. Set here rather than by the caller because the caller has no way
        -- to know when this thread finished.
        if spec.ready then
            exports[CORE]:setServiceState('ready')
        end
    end)
end

--- Move this resource's service state.
---
--- Separate from `announce` because they happen at different times: a resource
--- registers when it loads and becomes ready when its own startup finishes, and
--- collapsing the two would mean every resource is ready the instant it exists.
---
---@param state string  'registered' | 'ready' | 'degraded' | 'failed'
---@return boolean
function Service.setState(state)
    if GetResourceState(CORE) ~= 'started' then return false end
    local ok, result = pcall(function() return exports[CORE]:setServiceState(state) end)
    return ok and type(result) == 'table' and result.ok == true
end

--- Health tracking and the announcement, in one call.
---
--- **IT DOES NOT REGISTER THE `health` EXPORT.** It could — a shared file calling
--- `exports()` registers it in whichever resource loaded the file — and that
--- would put a resource's public contract in another repository, where nobody
--- reading nxc_zones would find it. Each resource declares its own, one line,
--- next to its others.
---
---@param spec { dependencies?: string[], optionalDependencies?: string[],
---              contractVersion?: integer, capabilities?: string[], ready?: boolean }|nil
function Service.start(spec)
    spec = spec or {}

    Nxc.Health.init({ dependencies = spec.dependencies })
    for _, name in ipairs(spec.optionalDependencies or {}) do
        Nxc.Health.dependency(name, true)
    end

    -- A dependency is satisfied when the resource it names has started. Declared
    -- dependencies are already started by the time this runs — FiveM orders them
    -- — so this is normally a formality, and is not skipped for that reason: a
    -- resource stopped by hand afterwards is exactly the case worth catching.
    for _, name in ipairs(spec.dependencies or {}) do
        Nxc.Health.setDependency(name, GetResourceState(name) == 'started')
    end
    for _, name in ipairs(spec.optionalDependencies or {}) do
        Nxc.Health.setDependency(name, GetResourceState(name) == 'started')
    end

    Service.announce({
        contractVersion = spec.contractVersion,
        capabilities = spec.capabilities,
        ready = spec.ready,
    })
end

Nxc.Service = Service
return Service
