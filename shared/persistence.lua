--- Persistence provider interface and table-ownership guard.
---
--- **Moved here from nxc_core on 2026-08-03**, for the same reason as the
--- migration planner: every resource with tables needs it, and it was already
--- parameterised by owner, so nothing about it was ever specific to nxc_core.
---
--- Error tagging now names the OWNER that was passed in rather than a hardcoded
--- resource, which is more accurate than what it replaced: a cross-domain query
--- refused for nxc_config used to report itself as an nxc_core error.
---
--- Persistence provider interface.
---
--- Persistence is MariaDB through oxmysql. This module defines the INTERFACE
--- and ships an in-memory double for tests; the MariaDB adapter needs oxmysql
--- and belongs in a server-side module.
---
--- Two rules this interface exists to enforce:
---
---   1. **Every table belongs to exactly one resource domain.** A provider is
---      obtained scoped to a resource, and a query naming another resource's
---      table prefix is refused. MariaDB cannot enforce that, so it is enforced
---      here where it is at least visible.
---
---   2. **Transactions do not span resources.** A transaction covers one
---      domain's tables. A store purchase is a money leg and an item leg, each
---      atomic in isolation.

local Persistence = {}

local provider = nil

--- Install the provider. Called by the server-side bootstrap once the database
--- is reachable.
---
---@param impl { query: function, execute: function, transaction: function }
function Persistence.setProvider(impl)
    if type(impl) ~= 'table' then
        error('Persistence.setProvider requires a provider', 2)
    end
    for _, fn in ipairs({ 'query', 'execute', 'transaction' }) do
        if type(impl[fn]) ~= 'function' then
            error('a persistence provider must implement ' .. fn, 2)
        end
    end
    provider = impl
end

---@return boolean
function Persistence.isReady()
    return provider ~= nil
end

local function tablesIn(sql)
    local found = {}
    for name in sql:gmatch('[Ff][Rr][Oo][Mm]%s+`?([%w_]+)`?') do found[#found + 1] = name end
    for name in sql:gmatch('[Jj][Oo][Ii][Nn]%s+`?([%w_]+)`?') do found[#found + 1] = name end
    for name in sql:gmatch('[Ii][Nn][Tt][Oo]%s+`?([%w_]+)`?') do found[#found + 1] = name end
    for name in sql:gmatch('[Uu][Pp][Dd][Aa][Tt][Ee]%s+`?([%w_]+)`?') do found[#found + 1] = name end
    return found
end

--- Whether a statement touches only tables owned by a resource.
---
--- The table prefix is the boundary marker, which is what makes a violation
--- visible on sight in review and detectable here.
---
---@param sql string
---@param owner string
---@return boolean, string|nil
function Persistence.ownsTables(sql, owner)
    for _, name in ipairs(tablesIn(sql)) do
        if not name:match('^' .. owner .. '_') then
            return false, name
        end
    end
    return true, nil
end

--- Obtain a provider scoped to a resource.
---
--- Every call checks table ownership before reaching the provider, so a
--- cross-domain query fails loudly rather than silently succeeding.
---
---@param owner string
---@return table
function Persistence.scoped(owner)
    if type(owner) ~= 'string' or owner == '' then
        error('Persistence.scoped requires an owning resource name', 2)
    end

    local function guard(sql)
        if not provider then
            return Nxc.Result.err(Nxc.Errors.new(
                'NXC_CORE_PERSISTENCE_UNAVAILABLE',
                'The database is not available.',
                { resource = owner, retryable = true }))
        end
        local ok, offending = Persistence.ownsTables(sql, owner)
        if not ok then
            return Nxc.Result.err(Nxc.Errors.new(
                'NXC_CORE_CROSS_DOMAIN_QUERY',
                'That query crosses a domain boundary.',
                {
                    resource = NxcCore.RESOURCE,
                    details = { owner = owner, table_ = offending },
                }))
        end
        return nil
    end

    return {
        ---@param sql string
        ---@param params table|nil
        ---@return NxcResult
        query = function(sql, params)
            local blocked = guard(sql)
            if blocked then return blocked end
            local ok, rows = pcall(provider.query, sql, params)
            if not ok then
                return Nxc.Result.err(Nxc.Errors.new(
                    'NXC_CORE_QUERY_FAILED', 'The request could not be completed.',
                    { resource = owner, retryable = true,
                      details = { reason = tostring(rows) } }))
            end
            return Nxc.Result.ok(rows)
        end,

        ---@param sql string
        ---@param params table|nil
        ---@return NxcResult
        execute = function(sql, params)
            local blocked = guard(sql)
            if blocked then return blocked end
            local ok, affected = pcall(provider.execute, sql, params)
            if not ok then
                return Nxc.Result.err(Nxc.Errors.new(
                    'NXC_CORE_QUERY_FAILED', 'The request could not be completed.',
                    { resource = owner, retryable = true,
                      details = { reason = tostring(affected) } }))
            end
            return Nxc.Result.ok(affected)
        end,

        --- Run statements atomically.
        ---
        --- Every statement is checked, so a transaction cannot smuggle a
        --- cross-domain write past the guard.
        ---
        ---@param statements { query: string, values?: table }[]
        ---@return NxcResult
        transaction = function(statements)
            if type(statements) ~= 'table' or #statements == 0 then
                return Nxc.Result.err(Nxc.Errors.validationFailed(
                    { fields = { { field = 'statements', reason = 'must be a non-empty list' } } }))
            end
            for _, st in ipairs(statements) do
                local blocked = guard(st.query or '')
                if blocked then return blocked end
            end
            local ok, result = pcall(provider.transaction, statements)
            if not ok then
                return Nxc.Result.err(Nxc.Errors.new(
                    'NXC_CORE_TRANSACTION_FAILED', 'The request could not be completed.',
                    { resource = owner, retryable = true,
                      details = { reason = tostring(result) } }))
            end
            return Nxc.Result.ok(result)
        end,
    }
end

--- An in-memory provider for tests.
---
--- **Not production persistence.** It records calls so a test can assert on
--- them; it executes no SQL.
---
---@return table
function Persistence.inMemoryDouble(opts)
    opts = opts or {}
    local calls = { query = {}, execute = {}, transaction = {} }

    -- `onQuery` and `onTransaction` let a test answer, not merely record.
    --
    -- The recording-only version could prove which statements were sent and
    -- nothing about what happens when rows come back — so account resolution,
    -- which is entirely about reacting to rows, had no test worth the name and
    -- shipped broken.
    return {
        calls = calls,
        query = function(sql, params)
            calls.query[#calls.query + 1] = { sql = sql, params = params }
            if opts.onQuery then return opts.onQuery(sql, params) or {} end
            return {}
        end,
        execute = function(sql, params)
            calls.execute[#calls.execute + 1] = { sql = sql, params = params }
            if opts.onExecute then return opts.onExecute(sql, params) end
            return 1
        end,
        transaction = function(statements)
            calls.transaction[#calls.transaction + 1] = statements
            if opts.onTransaction then return opts.onTransaction(statements) end
            return true
        end,
    }
end

--- Test helper.
function Persistence.reset()
    provider = nil
end

Nxc.Persistence = Persistence
return Persistence
