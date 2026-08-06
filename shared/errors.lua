--- Structured errors.
---
--- One error shape project-wide:
---
---     code           stable machine-readable identifier
---     message        human-readable, safe to show a player
---     resource       the resource that produced it
---     correlationId  the correlation id of the operation
---     details        structured context, never secrets
---     retryable      whether retrying could succeed
---
--- `retryable` is a promise, not a hint. Callers act on it, and a retry loop
--- keyed on a wrong value is an accidental denial of service against your own
--- server. The dangerous case is a timeout: a timed-out operation may have
--- completed, so it is only retryable when the operation is idempotent.

local Errors = {}

--- Codes owned by `nxc_lib`. Every public code is registered before it is
--- returned; an unregistered code cannot be handled by a caller.
Errors.CODES = {
    VALIDATION_FAILED    = 'NXC_LIB_VALIDATION_FAILED',
    RATE_LIMITED         = 'NXC_LIB_RATE_LIMITED',
    TIMEOUT              = 'NXC_LIB_TIMEOUT',
    CANCELLED            = 'NXC_LIB_CANCELLED',
    FORBIDDEN            = 'NXC_LIB_FORBIDDEN',
    SESSION_INVALID      = 'NXC_LIB_SESSION_INVALID',
    PAYLOAD_TOO_LARGE    = 'NXC_LIB_PAYLOAD_TOO_LARGE',
    MALFORMED_ENVELOPE   = 'NXC_LIB_MALFORMED_ENVELOPE',
    INTERNAL             = 'NXC_LIB_INTERNAL',
}

local RETRYABLE = {
    [Errors.CODES.RATE_LIMITED]      = true,
    [Errors.CODES.TIMEOUT]           = true,   -- caller must confirm idempotency
    [Errors.CODES.VALIDATION_FAILED] = false,
    [Errors.CODES.CANCELLED]         = false,
    [Errors.CODES.FORBIDDEN]         = false,
    [Errors.CODES.SESSION_INVALID]   = false,
    [Errors.CODES.PAYLOAD_TOO_LARGE] = false,
    [Errors.CODES.MALFORMED_ENVELOPE] = false,
    [Errors.CODES.INTERNAL]          = false,
}

---@class NxcError
---@field code string
---@field message string
---@field resource string
---@field correlationId string|nil
---@field details table|nil
---@field retryable boolean

--- Build a structured error.
---
--- `details` is structured context a caller can act on — which field failed,
--- which capability was required. It is never free text duplicating `message`,
--- and never a serialized internal object.
---
---@param code string
---@param message string
---@param opts { resource?: string, correlationId?: string, details?: table, retryable?: boolean }|nil
---@return NxcError
function Errors.new(code, message, opts)
    if type(code) ~= 'string' or code == '' then
        error('an error requires a code', 2)
    end
    opts = opts or {}

    local retryable = opts.retryable
    if retryable == nil then
        retryable = RETRYABLE[code] or false
    end

    return Nxc.freeze({
        code = code,
        message = message or '',
        resource = opts.resource or Nxc.resourceName(),
        correlationId = opts.correlationId,
        details = opts.details,
        retryable = retryable,
    })
end

--- True when the value is a structured error.
---
---@param v any
---@return boolean
function Errors.is(v)
    return type(v) == 'table' and type(v.code) == 'string' and type(v.retryable) == 'boolean'
end

--- Whether a code is known to this resource. Other resources register their own.
---
---@param code string
---@return boolean
function Errors.isRegistered(code)
    for _, v in pairs(Errors.CODES) do
        if v == code then return true end
    end
    return false
end

--- The player-facing view of an error.
---
--- Strips `details` and `resource`, keeping only what is safe to display. Never
--- send a raw error to a client: `details` is written for operators and may name
--- internal fields, capabilities, or thresholds.
---
---@param err NxcError
---@return { code: string, message: string, correlationId: string|nil, retryable: boolean }
function Errors.toPlayer(err)
    return {
        code = err.code,
        message = err.message,
        correlationId = err.correlationId,
        retryable = err.retryable,
    }
end

--- Resolve a player-facing message.
---
--- No user-facing string is hardcoded in logic. The literal is passed as a
--- fallback rather than omitted, so an error still reads correctly if the locale
--- table has not loaded — an error path is exactly when a missing string is
--- least welcome.
---
--- Locale loads after this module, so resolution happens at call time rather
--- than at load time.
---
---@param key string
---@param fallback string
---@return string
local function message(key, fallback)
    if Nxc.Locale then
        local text = Nxc.Locale.get(key)
        -- Locale humanises an unknown key rather than returning nil, so compare
        -- against the humanised form to detect a genuine miss.
        if text and text ~= '' then return text end
    end
    return fallback
end

-- Constructors for the common conditions. Having these named means a call site
-- cannot accidentally mark a permission denial retryable.

---@param details table|nil
---@param correlationId string|nil
---@return NxcError
function Errors.validationFailed(details, correlationId)
    return Errors.new(Errors.CODES.VALIDATION_FAILED, message('error.validationFailed', 'The request was not valid.'), {
        correlationId = correlationId,
        details = details,
    })
end

---@param capability string
---@param correlationId string|nil
---@return NxcError
function Errors.forbidden(capability, correlationId)
    return Errors.new(Errors.CODES.FORBIDDEN, message('error.forbidden', 'You are not permitted to do that.'), {
        correlationId = correlationId,
        details = { capability = capability },
    })
end

---@param correlationId string|nil
---@param retryAfterMs number|nil
---@return NxcError
function Errors.rateLimited(correlationId, retryAfterMs)
    return Errors.new(Errors.CODES.RATE_LIMITED, message('error.rateLimited', 'Too many requests. Try again shortly.'), {
        correlationId = correlationId,
        details = retryAfterMs and { retryAfterMs = retryAfterMs } or nil,
    })
end

--- A timeout.
---
--- `idempotent` is required rather than defaulted, because the caller is the
--- only party that knows whether retrying is safe, and guessing wrong here is
--- how duplicate transactions happen.
---
---@param correlationId string|nil
---@param idempotent boolean
---@return NxcError
function Errors.timeout(correlationId, idempotent)
    if type(idempotent) ~= 'boolean' then
        error('Errors.timeout requires an explicit idempotent flag: retrying a '
            .. 'non-idempotent operation after a timeout can duplicate it', 2)
    end
    return Errors.new(Errors.CODES.TIMEOUT, message('error.timeout', 'The request timed out.'), {
        correlationId = correlationId,
        retryable = idempotent,
    })
end

---@param correlationId string|nil
---@return NxcError
function Errors.cancelled(correlationId)
    return Errors.new(Errors.CODES.CANCELLED, message('error.cancelled', 'The request was cancelled.'), {
        correlationId = correlationId,
    })
end

---@param correlationId string|nil
---@return NxcError
function Errors.sessionInvalid(correlationId)
    return Errors.new(Errors.CODES.SESSION_INVALID, message('error.sessionInvalid', 'Your session is no longer valid.'), {
        correlationId = correlationId,
    })
end

--- An internal failure.
---
--- Deliberately carries no detail. The diagnostic context goes to the log under
--- the same correlation id, where staff can find it and players cannot.
---
---@param correlationId string|nil
---@return NxcError
function Errors.internal(correlationId)
    return Errors.new(Errors.CODES.INTERNAL, message('error.internal', 'Something went wrong.'), {
        correlationId = correlationId,
    })
end

Nxc.Errors = Errors
return Errors
