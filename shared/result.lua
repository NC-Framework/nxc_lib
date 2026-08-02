--- Structured result type.
---
--- Every function that can fail returns a Result rather than `nil` plus a bare
--- string. The caller must look at `ok` before reading `value`, which makes the
--- failure path impossible to miss by accident.
---
--- A Result is frozen: a caller cannot mutate one and hand the corrupted copy
--- back to the producer.

local Result = {}

---@class NxcResult
---@field ok boolean
---@field value any        Present when ok is true
---@field error NxcError   Present when ok is false

--- A successful result carrying a value.
---
---@param value any
---@return NxcResult
function Result.ok(value)
    return Nxc.freeze({ ok = true, value = value })
end

--- A failed result carrying a structured error.
---
--- The error must be a table with a `code`. Passing a bare string here is the
--- most common way structured errors get bypassed, so it is rejected loudly
--- rather than silently wrapped.
---
---@param err NxcError
---@return NxcResult
function Result.err(err)
    if type(err) ~= 'table' or type(err.code) ~= 'string' then
        error('Result.err requires a structured error with a code, got ' .. type(err), 2)
    end
    return Nxc.freeze({ ok = false, error = err })
end

--- True when the value is a Result.
---
---@param v any
---@return boolean
function Result.is(v)
    return type(v) == 'table' and type(v.ok) == 'boolean'
end

--- Transform a success value, leaving a failure untouched.
---
---@param result NxcResult
---@param fn fun(value: any): any
---@return NxcResult
function Result.map(result, fn)
    if not result.ok then return result end
    return Result.ok(fn(result.value))
end

--- Chain an operation that itself returns a Result.
---
--- This is what lets a sequence of fallible steps read top to bottom without a
--- pyramid of `if not result.ok then return result end`.
---
---@param result NxcResult
---@param fn fun(value: any): NxcResult
---@return NxcResult
function Result.andThen(result, fn)
    if not result.ok then return result end
    local next_ = fn(result.value)
    if not Result.is(next_) then
        error('Result.andThen callback must return a Result', 2)
    end
    return next_
end

--- The success value, or a default when the result failed.
---
---@param result NxcResult
---@param default any
---@return any
function Result.unwrapOr(result, default)
    if result.ok then return result.value end
    return default
end

--- The success value, or raise. Use only where a failure is a programming
--- error rather than an expected condition — never on a network boundary.
---
---@param result NxcResult
---@return any
function Result.expect(result)
    if result.ok then return result.value end
    error(('expected a successful result, got %s: %s')
        :format(result.error.code, result.error.message or ''), 2)
end

--- Collect a list of Results into a Result holding a list.
---
--- Fails on the first failure, returning that error. Useful for validating a
--- batch where any single failure should abort the whole operation.
---
---@param results NxcResult[]
---@return NxcResult
function Result.all(results)
    local values = {}
    for i = 1, #results do
        local r = results[i]
        if not r.ok then return r end
        values[i] = r.value
    end
    return Result.ok(values)
end

Nxc.Result = Result
return Result
