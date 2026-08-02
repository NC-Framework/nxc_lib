--- Structured logging interface.
---
--- Records are structured, not formatted strings. A log line that has to be
--- parsed with a regular expression is a log line that will be parsed wrong.
---
--- This is an *interface*: the sink is injected. `nxc_lib` does not decide where
--- records go, because that is a deployment concern and because a library that
--- opens a transport is a library that cannot be tested.

local Logger = {}

Logger.LEVELS = { debug = 10, info = 20, warn = 30, error = 40, fatal = 50 }

local currentLevel = Logger.LEVELS.info
local environment = 'development'
local sink = function(record)
    -- Default sink: one structured line per record, which txAdmin and standard
    -- log shipping already capture.
    print(('[%s] %s %s %s'):format(
        record.severity:upper(), record.resource, record.action,
        Nxc.Serialize.approximateSize(record.context) > 2 and '<context>' or ''))
end

--- Replace the sink.
---
--- Constraints on any sink, enforced by convention rather than by code because
--- the sink is supplied from outside: it must never block, must be bounded, and
--- must never carry audit records. Audits are written in the same transaction as
--- the change they record, so their write can fail the operation.
---
---@param fn fun(record: table)
function Logger.setSink(fn)
    if type(fn) ~= 'function' then
        error('Logger.setSink requires a function', 2)
    end
    sink = fn
end

--- Set the minimum severity emitted. `debug` is disabled in production.
---
---@param level string
function Logger.setLevel(level)
    local value = Logger.LEVELS[level]
    if not value then
        error('unknown log level: ' .. tostring(level), 2)
    end
    currentLevel = value
end

---@param name string
function Logger.setEnvironment(name)
    environment = name
end

local function emit(severity, action, context, opts)
    if Logger.LEVELS[severity] < currentLevel then return end
    opts = opts or {}

    local record = {
        timestamp = Nxc.Time.iso8601(),
        environment = environment,
        resource = opts.resource or Nxc.RESOURCE,
        version = opts.version or Nxc.VERSION,
        action = action,
        actorAccount = opts.actorAccount,
        actorCharacter = opts.actorCharacter,
        target = opts.target,
        correlationId = opts.correlationId or (context and context.correlationId),
        idempotencyKey = opts.idempotencyKey,
        result = opts.result,
        duration = opts.duration,
        severity = severity,
        errorCode = opts.errorCode,
        -- Redaction happens here, at the call site, not downstream.
        context = context and Nxc.Serialize.redact(context) or nil,
    }

    local ok, err = pcall(sink, record)
    if not ok then
        -- A failing sink must not take the caller down with it. This is the
        -- opposite of the audit rule: a *log* failure degrades diagnosis, while
        -- an *audit* failure fails the operation.
        print(('[nxc_lib] log sink failed: %s'):format(tostring(err)))
    end
end

---@param action string
---@param context table|nil
---@param opts table|nil
function Logger.debug(action, context, opts) emit('debug', action, context, opts) end
function Logger.info(action, context, opts) emit('info', action, context, opts) end
function Logger.warn(action, context, opts) emit('warn', action, context, opts) end
function Logger.error(action, context, opts) emit('error', action, context, opts) end
function Logger.fatal(action, context, opts) emit('fatal', action, context, opts) end

--- A logger bound to a resource and correlation id.
---
--- Saves every call site repeating them, and makes it harder to forget the
--- correlation id — which is the field that makes a distributed operation
--- reconstructible.
---
---@param opts { resource?: string, version?: string, correlationId?: string }
---@return table
function Logger.forContext(opts)
    local bound = {}
    for _, level in ipairs({ 'debug', 'info', 'warn', 'error', 'fatal' }) do
        bound[level] = function(action, context, extra)
            local merged = {}
            for k, v in pairs(opts) do merged[k] = v end
            if extra then
                for k, v in pairs(extra) do merged[k] = v end
            end
            emit(level, action, context, merged)
        end
    end
    return bound
end

Nxc.Logger = Logger
return Logger
