--- RPC and event envelope contracts.
---
--- The RPC layer is an envelope over network events. One request event and one
--- response event per direction carry every call; individual RPCs are `method`
--- values rather than separate network events.
---
--- That shape exists so validation, rate limiting, permission checks,
--- correlation, and audit hooks are implemented once rather than at every call
--- site — the one that gets forgotten is a vulnerability. It also gives
--- `nxc_devtools` a single interception point for tracing.
---
--- This module owns the envelope *shape* and its validation. It does not send
--- anything: transport lives in the resources that use it, because `nxc_lib`
--- must not become a place where cross-resource behaviour hides.

local Envelope = {}

--- Maximum serialized envelope size accepted.
---
--- ADR-0004 records that the practical network-event payload limit was not
--- measured before the decision was accepted, and must be measured during
--- implementation. Until it is, this conservative ceiling bounds the surface:
--- an oversized payload is rejected at the boundary rather than being handed to
--- a transport that may truncate or drop it silently.
Envelope.MAX_BYTES = 32 * 1024

Envelope.KIND = {
    REQUEST  = 'request',
    RESPONSE = 'response',
    CANCEL   = 'cancel',
    EVENT    = 'event',
}

local METHOD_PATTERN = '^[%a][%w_]*:[%a][%w_]*$'
local EVENT_PATTERN = '^[%a][%w_]*:[%a][%w_]*:[%a][%w_]*$'

local requestSchema = {
    kind          = { type = 'string', oneOf = { Envelope.KIND.REQUEST } },
    id            = { type = 'string', min = 1, max = 64 },
    correlationId = { type = 'string', min = 1, max = 64 },
    method        = { type = 'string', min = 3, max = 128, pattern = METHOD_PATTERN },
    payload       = { type = 'table', required = false },
    idempotencyKey = { type = 'string', min = 1, max = 128, required = false },
    deadline      = { type = 'integer', min = 0, required = false },
    contractVersion = { type = 'integer', min = 1, required = false },
}

local responseSchema = {
    kind          = { type = 'string', oneOf = { Envelope.KIND.RESPONSE } },
    id            = { type = 'string', min = 1, max = 64 },
    correlationId = { type = 'string', min = 1, max = 64 },
    ok            = { type = 'boolean' },
    result        = { type = 'table', required = false },
    error         = { type = 'table', required = false },
}

local cancelSchema = {
    kind          = { type = 'string', oneOf = { Envelope.KIND.CANCEL } },
    id            = { type = 'string', min = 1, max = 64 },
    correlationId = { type = 'string', min = 1, max = 64 },
}

--- Build a request envelope.
---
---@param method string   `<resource>:<action>`
---@param payload table|nil
---@param opts { correlationId?: string, idempotencyKey?: string, timeoutMs?: number, contractVersion?: integer }|nil
---@return table
function Envelope.request(method, payload, opts)
    opts = opts or {}
    if type(method) ~= 'string' or not method:match(METHOD_PATTERN) then
        error('an RPC method must be <resource>:<action>, got ' .. tostring(method), 2)
    end

    local correlationId = Nxc.Correlation.coerce(opts.correlationId)
    local env = {
        kind = Envelope.KIND.REQUEST,
        id = Nxc.Correlation.new(),
        correlationId = correlationId,
        method = method,
        payload = payload,
        idempotencyKey = opts.idempotencyKey,
        contractVersion = opts.contractVersion,
    }
    if opts.timeoutMs then
        env.deadline = Nxc.Time.nowMs() + opts.timeoutMs
    end
    return env
end

--- Build a successful response to a request envelope.
---
---@param request table
---@param result table|nil
---@return table
function Envelope.response(request, result)
    return {
        kind = Envelope.KIND.RESPONSE,
        id = request.id,
        correlationId = request.correlationId,
        ok = true,
        result = result,
    }
end

--- Build a failure response to a request envelope.
---
---@param request table
---@param err NxcError
---@return table
function Envelope.failure(request, err)
    if not Nxc.Errors.is(err) then
        error('Envelope.failure requires a structured error', 2)
    end
    return {
        kind = Envelope.KIND.RESPONSE,
        id = request.id,
        correlationId = request.correlationId,
        ok = false,
        -- The player-facing view: `details` is written for operators and may
        -- name internal fields, capabilities, or thresholds.
        error = Nxc.Errors.toPlayer(err),
    }
end

--- Build a cancellation for an in-flight request.
---
---@param request table
---@return table
function Envelope.cancel(request)
    return {
        kind = Envelope.KIND.CANCEL,
        id = request.id,
        correlationId = request.correlationId,
    }
end

--- Build an event envelope.
---
--- Events announce a state change that has already completed. Past tense, one
--- way, no answer expected.
---
---@param name string   `<resource>:<side>:<action>`
---@param payload table|nil
---@param correlationId string|nil
---@return table
function Envelope.event(name, payload, correlationId)
    if type(name) ~= 'string' or not name:match(EVENT_PATTERN) then
        error('an event name must be <resource>:<side>:<action>, got ' .. tostring(name), 2)
    end
    return {
        kind = Envelope.KIND.EVENT,
        name = name,
        correlationId = Nxc.Correlation.coerce(correlationId),
        payload = payload,
    }
end

local function checkSize(env, correlationId)
    local size = Nxc.Serialize.approximateSize(env)
    if size > Envelope.MAX_BYTES then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.PAYLOAD_TOO_LARGE,
            'The request was too large.',
            { correlationId = correlationId, details = { bytes = size, limit = Envelope.MAX_BYTES } }))
    end
    return nil
end

--- Validate a received envelope.
---
--- **Every envelope arriving over the network is attacker-controlled**, whatever
--- its `kind` claims. This is the single point where that assumption is enforced,
--- which is the whole reason for a shared envelope.
---
---@param env any
---@param expectedKind string|nil
---@return NxcResult
function Envelope.validate(env, expectedKind)
    if type(env) ~= 'table' then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.MALFORMED_ENVELOPE,
            'The message was not understood.',
            { details = { reason = 'not a table' } }))
    end

    local schema
    if env.kind == Envelope.KIND.REQUEST then
        schema = requestSchema
    elseif env.kind == Envelope.KIND.RESPONSE then
        schema = responseSchema
    elseif env.kind == Envelope.KIND.CANCEL then
        schema = cancelSchema
    else
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.MALFORMED_ENVELOPE,
            'The message was not understood.',
            { details = { reason = 'unknown kind' } }))
    end

    if expectedKind and env.kind ~= expectedKind then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.MALFORMED_ENVELOPE,
            'The message was not understood.',
            { details = { reason = 'unexpected kind', expected = expectedKind } }))
    end

    local sizeErr = checkSize(env, env.correlationId)
    if sizeErr then return sizeErr end

    local result = Nxc.Validate.against(schema, env, env.correlationId)
    if not result.ok then return result end

    -- A correlation id arriving from a client is attacker-controlled. An
    -- unvalidated one ends up in log records and audit trails, where it can make
    -- a later search return the wrong operation.
    if not Nxc.Correlation.isValid(env.correlationId) then
        return Nxc.Result.err(Nxc.Errors.new(
            Nxc.Errors.CODES.MALFORMED_ENVELOPE,
            'The message was not understood.',
            { details = { reason = 'malformed correlation id' } }))
    end

    return Nxc.Result.ok(env)
end

--- Whether a request envelope's deadline has passed.
---
---@param env table
---@param nowMs number|nil
---@return boolean
function Envelope.isExpired(env, nowMs)
    if not env.deadline then return false end
    return (nowMs or Nxc.Time.nowMs()) >= env.deadline
end

Nxc.Envelope = Envelope
return Envelope
