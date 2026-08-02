--- Configuration schema for `nxc_lib`.
---
--- Every Nexus Core resource registers its operational configuration through
--- `nxc_config` and exposes a permission-controlled in-game management surface.
--- That is a condition of acceptance, not a quality goal.
---
--- `nxc_lib` has a small surface: it owns no gameplay domain, so its
--- configuration covers only its own behaviour — log level, default timeouts,
--- default rate limits, and the envelope size ceiling.
---
--- The schema is **pure data** and the registration function takes an injected
--- registrar, so both are testable without the FiveM runtime and without
--- `nxc_config` existing.

local ConfigSchema = {}

--- Every field declares all fourteen required properties.
---
--- `reloadBehavior` is the one most easily got wrong. The two restart values are
--- exceptions and each carries a technical reason; "it would be complicated to
--- apply live" is not one.
ConfigSchema.FIELDS = {
    {
        key = 'nxc_lib.logging.level',
        type = 'string',
        description = 'Minimum severity written to the log. Debug is disabled in production.',
        default = 'info',
        validation = { oneOf = { 'debug', 'info', 'warn', 'error', 'fatal' } },
        scope = { 'global', 'environment', 'resource' },
        clientVisible = false,
        editCapability = 'config.resource.edit',
        auditClassification = 'operational',
        sensitive = false,
        reloadBehavior = 'Immediate',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:logLevelChanged',
    },
    {
        key = 'nxc_lib.rpc.defaultTimeoutMs',
        type = 'integer',
        description = 'How long an RPC waits for a response before it times out, in milliseconds.',
        default = 10000,
        validation = { min = 1000, max = 60000 },
        scope = { 'global', 'environment', 'resource' },
        clientVisible = true,
        editCapability = 'config.resource.edit',
        auditClassification = 'operational',
        sensitive = false,
        reloadBehavior = 'Next Interaction',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:rpcDefaultsChanged',
    },
    {
        key = 'nxc_lib.rpc.maxEnvelopeBytes',
        type = 'integer',
        description =
            'Largest accepted RPC envelope, in bytes. An oversized payload is rejected at the '
            .. 'boundary rather than handed to a transport that may truncate it silently.',
        default = 32768,
        validation = { min = 4096, max = 131072 },
        scope = { 'global', 'environment' },
        clientVisible = true,
        editCapability = 'config.resource.publish',
        auditClassification = 'security',
        sensitive = false,
        -- The ceiling is read when validating each envelope, so a change applies
        -- to the next request without any reload.
        reloadBehavior = 'Immediate',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:rpcDefaultsChanged',
    },
    {
        key = 'nxc_lib.rateLimit.defaultCapacity',
        type = 'integer',
        description =
            'Default token bucket size for a rate-limited operation. A caller may burst up to this '
            .. 'many requests before settling to the refill rate.',
        default = 10,
        validation = { min = 1, max = 1000 },
        scope = { 'global', 'environment', 'resource' },
        clientVisible = false,
        editCapability = 'config.resource.edit',
        auditClassification = 'security',
        sensitive = false,
        reloadBehavior = 'Next Session',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:rateLimitDefaultsChanged',
    },
    {
        key = 'nxc_lib.rateLimit.defaultRefillPerSecond',
        type = 'number',
        description = 'Default token refill rate per second for a rate-limited operation.',
        default = 2,
        validation = { min = 0.1, max = 100 },
        scope = { 'global', 'environment', 'resource' },
        clientVisible = false,
        editCapability = 'config.resource.edit',
        auditClassification = 'security',
        sensitive = false,
        reloadBehavior = 'Next Session',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:rateLimitDefaultsChanged',
    },
    {
        key = 'nxc_lib.rateLimit.pruneIdleMs',
        type = 'integer',
        description =
            'How long an idle rate-limit bucket is kept before pruning. Without pruning, a '
            .. 'long-running server accumulates one bucket per actor that has ever called the '
            .. 'operation.',
        default = 300000,
        validation = { min = 30000, max = 3600000 },
        scope = { 'global', 'environment' },
        clientVisible = false,
        editCapability = 'config.resource.edit',
        auditClassification = 'operational',
        sensitive = false,
        reloadBehavior = 'Next Session',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:rateLimitDefaultsChanged',
    },
    {
        key = 'nxc_lib.locale.default',
        type = 'string',
        description = 'Locale used when a player has expressed no preference.',
        default = 'en',
        validation = { pattern = '^%a%a$' },
        scope = { 'global', 'environment', 'player' },
        clientVisible = true,
        editCapability = 'config.resource.edit',
        auditClassification = 'operational',
        sensitive = false,
        reloadBehavior = 'Next Session',
        migrationBehavior = 'retain',
        rollbackBehavior = 'restore',
        changeEvent = 'nxc_lib:server:localeChanged',
    },
}

local REQUIRED_PROPERTIES = {
    'key', 'type', 'description', 'default', 'validation', 'scope', 'clientVisible',
    'editCapability', 'auditClassification', 'sensitive', 'reloadBehavior',
    'migrationBehavior', 'rollbackBehavior', 'changeEvent',
}

local RELOAD_BEHAVIORS = {
    ['Immediate'] = true,
    ['Next Interaction'] = true,
    ['Next Session'] = true,
    ['Resource Restart Required'] = true,
    ['Server Restart Required'] = true,
}

--- Validate the schema itself.
---
--- Run before registration. A field missing a property is not registered, and
--- catching that here produces a clear failure rather than a partial
--- registration discovered later.
---
---@return NxcResult
function ConfigSchema.validate()
    local problems = {}

    for _, field in ipairs(ConfigSchema.FIELDS) do
        local key = field.key or '(no key)'

        for _, prop in ipairs(REQUIRED_PROPERTIES) do
            if field[prop] == nil then
                problems[#problems + 1] = { field = key, reason = 'missing property: ' .. prop }
            end
        end

        if field.key and not field.key:match('^nxc_lib%.[%a][%w]*%.[%a][%w]*$') then
            problems[#problems + 1] =
                { field = key, reason = 'key must be <resource>.<group>.<key>' }
        end

        if field.reloadBehavior and not RELOAD_BEHAVIORS[field.reloadBehavior] then
            problems[#problems + 1] =
                { field = key, reason = 'unknown reload behavior: ' .. tostring(field.reloadBehavior) }
        end

        -- A sensitive value must never be client-visible, whatever its scope
        -- resolution would otherwise permit.
        if field.sensitive == true and field.clientVisible == true then
            problems[#problems + 1] =
                { field = key, reason = 'a sensitive field cannot be client-visible' }
        end
    end

    if #problems > 0 then
        return Nxc.Result.err(Nxc.Errors.validationFailed({ fields = problems }))
    end
    return Nxc.Result.ok(ConfigSchema.FIELDS)
end

--- Declared defaults, used before registration completes.
---
--- `nxc_lib` loads before `nxc_config`, so between startup and the registration
--- handshake it runs on these. They are part of the schema, which makes this
--- defined behaviour rather than a fallback.
---
---@return table<string, any>
function ConfigSchema.defaults()
    local out = {}
    for _, field in ipairs(ConfigSchema.FIELDS) do
        out[field.key] = field.default
    end
    return out
end

--- Register the schema with a configuration service.
---
--- The registrar is injected rather than looked up, so this is testable without
--- `nxc_config` existing and without the FiveM runtime. Registration is an
--- event-driven handshake, not a startup dependency: `nxc_config` announces
--- readiness and each resource registers then.
---
---@param registrar fun(resource: string, fields: table): boolean
---@return NxcResult
function ConfigSchema.register(registrar)
    if type(registrar) ~= 'function' then
        error('ConfigSchema.register requires a registrar function', 2)
    end

    local valid = ConfigSchema.validate()
    if not valid.ok then return valid end

    local ok, accepted = pcall(registrar, Nxc.RESOURCE, ConfigSchema.FIELDS)
    if not ok then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.INTERNAL,
            'Configuration registration failed.',
            { details = { reason = tostring(accepted) } }))
    end
    if accepted ~= true then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.INTERNAL,
            'Configuration registration was refused.',
            { details = { resource = Nxc.RESOURCE } }))
    end

    return Nxc.Result.ok(true)
end

Nxc.ConfigSchema = ConfigSchema
return ConfigSchema
