--- Cancellation.
---
--- A long-running operation must be stoppable, and stopping it must leave no
--- partial state. Cancellation is the caller deciding to stop; a timeout is the
--- caller giving up on an answer. Both must leave the system consistent, and
--- both settle the same token here.

local Cancel = {}

---@class NxcCancelToken
local Token = {}
Token.__index = Token

--- Create a cancellation token.
---
---@param opts { deadlineMs?: number, now?: fun(): number }|nil
---@return NxcCancelToken
function Cancel.token(opts)
    opts = opts or {}
    return setmetatable({
        cancelled = false,
        reason = nil,
        deadlineMs = opts.deadlineMs,
        now = opts.now or function() return Nxc.Time.nowMs() end,
        callbacks = {},
    }, Token)
end

--- Whether the token has been cancelled, or its deadline has passed.
---
--- The deadline is evaluated on read rather than by a timer, so a token is
--- correct without requiring anything to be scheduled — which matters because a
--- resource restart discards timers but not tokens held in a request.
---
---@return boolean
function Token:isCancelled()
    if self.cancelled then return true end
    if self.deadlineMs and self.now() >= self.deadlineMs then
        self:cancel('timeout')
        return true
    end
    return false
end

--- Cancel the token and run its callbacks.
---
--- Idempotent: cancelling twice runs the callbacks once. A cleanup path that
--- runs twice is how a released resource gets released again.
---
---@param reason string|nil
function Token:cancel(reason)
    if self.cancelled then return end
    self.cancelled = true
    self.reason = reason or 'cancelled'

    local callbacks = self.callbacks
    self.callbacks = {}
    for _, fn in ipairs(callbacks) do
        -- A failing cleanup callback must not prevent the others from running.
        local ok, err = pcall(fn, self.reason)
        if not ok and Nxc.Logger then
            Nxc.Logger.warn('cancel.callback.failed', { reason = self.reason, error = tostring(err) })
        end
    end
end

--- Register a cleanup callback.
---
--- If the token is already cancelled the callback runs immediately, so a
--- late registration cannot leak the thing it was meant to release.
---
---@param fn fun(reason: string)
function Token:onCancel(fn)
    if type(fn) ~= 'function' then
        error('onCancel requires a function', 2)
    end
    if self.cancelled then
        fn(self.reason)
        return
    end
    self.callbacks[#self.callbacks + 1] = fn
end

--- A structured error for the token's terminal state, or nil if still live.
---
---@param correlationId string|nil
---@param idempotent boolean|nil  required when the reason is a timeout
---@return NxcError|nil
function Token:toError(correlationId, idempotent)
    if not self:isCancelled() then return nil end
    if self.reason == 'timeout' then
        return Nxc.Errors.timeout(correlationId, idempotent == true)
    end
    return Nxc.Errors.cancelled(correlationId)
end

--- A token cancelled when any of its sources is.
---
---@param tokens NxcCancelToken[]
---@return NxcCancelToken
function Cancel.any(tokens)
    local combined = Cancel.token()
    for _, t in ipairs(tokens) do
        t:onCancel(function(reason) combined:cancel(reason) end)
    end
    return combined
end

Nxc.Cancel = Cancel
return Cancel
