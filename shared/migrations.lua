--- Migration planning: ordering, checksums, and drift detection.
---
--- **Moved here from nxc_core on 2026-08-03.** Every resource that owns tables
--- needs this, and leaving it in nxc_core meant the second such resource had to
--- either duplicate it or load nxc_core's namespace into its own Lua state and
--- mis-tag every error as coming from nxc_core.
---
--- nxc_core keeps a thin alias so its contract does not break — expand now,
--- contract later, per ADR-0009.
---
--- Migration planning.
---
--- Pure logic: ordering, checksums, and deciding what to apply. Executing the
--- plan needs a database and lives in the server module, so this half stays
--- testable without one.
---
--- Each resource owns its own migrations. A resource never migrates another's
--- tables — that is a boundary violation with permanent consequences, because
--- the other owner's migration history would no longer describe its schema.

local Migrations = {}

local NAME_PATTERN = '^(%d%d%d%d)_([%w_]+)%.sql$'

--- A stable checksum over migration text.
---
--- FNV-1a: not cryptographic, and it does not need to be. It exists to detect a
--- file being edited after it has run, which is an accident rather than an
--- attack. A mismatch means the schema no longer matches its own history.
---
---@param text string
---@return string
function Migrations.checksum(text)
    -- Normalise line endings so a checkout on another platform does not appear
    -- to have edited every migration.
    local normalised = text:gsub('\r\n', '\n')
    local hash = 2166136261
    for i = 1, #normalised do
        hash = hash ~ normalised:byte(i)
        -- FNV prime, applied with explicit masking to stay in 32 bits.
        hash = (hash * 16777619) & 0xFFFFFFFF
    end
    return ('%08x'):format(hash)
end

--- Parse a migration filename.
---
---@param filename string
---@return { sequence: integer, name: string }|nil
function Migrations.parseName(filename)
    local seq, name = filename:match(NAME_PATTERN)
    if not seq then return nil end
    return { sequence = tonumber(seq), name = name }
end

--- Build an ordered, validated migration set.
---
--- Rejects a duplicate sequence number outright. Two migrations claiming the
--- same position would apply in an order that depends on directory listing,
--- which differs between filesystems.
---
---@param files { filename: string, sql: string }[]
---@return NxcResult
function Migrations.plan(files)
    local parsed, seen, problems = {}, {}, {}

    for _, f in ipairs(files) do
        local meta = Migrations.parseName(f.filename)
        if not meta then
            problems[#problems + 1] = {
                field = f.filename,
                reason = 'must be named NNNN_description.sql',
            }
        elseif seen[meta.sequence] then
            problems[#problems + 1] = {
                field = f.filename,
                reason = ('duplicates sequence %04d, already used by %s')
                    :format(meta.sequence, seen[meta.sequence]),
            }
        elseif f.sql == nil or f.sql:match('^%s*$') then
            problems[#problems + 1] = { field = f.filename, reason = 'is empty' }
        else
            seen[meta.sequence] = f.filename
            parsed[#parsed + 1] = {
                filename = f.filename,
                sequence = meta.sequence,
                name = meta.name,
                sql = f.sql,
                checksum = Migrations.checksum(f.sql),
            }
        end
    end

    if #problems > 0 then
        return Nxc.Result.err(Nxc.Errors.validationFailed({ fields = problems }))
    end

    table.sort(parsed, function(a, b) return a.sequence < b.sequence end)
    return Nxc.Result.ok(parsed)
end

--- Decide what to apply, given what has already run.
---
--- A checksum mismatch on an already-applied migration is an ERROR, not a
--- warning: a file that has run was edited, so the live schema no longer matches
--- its recorded history and no later migration can be trusted to apply cleanly.
---
---@param planned table[]
---@param applied { migration: string, checksum: string }[]
---@return NxcResult
function Migrations.pending(planned, applied, owner)
    local byName = {}
    for _, a in ipairs(applied) do byName[a.migration] = a.checksum end

    local pending, drift = {}, {}
    for _, m in ipairs(planned) do
        local recorded = byName[m.filename]
        if recorded == nil then
            pending[#pending + 1] = m
        elseif recorded ~= m.checksum then
            drift[#drift + 1] = {
                field = m.filename,
                reason = ('has been edited since it was applied (recorded %s, now %s)')
                    :format(recorded, m.checksum),
            }
        end
    end

    if #drift > 0 then
        return Nxc.Result.err(Nxc.Errors.new(
            'NXC_CORE_MIGRATION_DRIFT',
            'The database schema does not match its recorded migration history.',
            { resource = owner or 'nxc_lib', details = { fields = drift } }))
    end

    -- An applied migration with no file is not an error: a resource may have been
    -- downgraded, and the schema is ahead rather than inconsistent. Reported so
    -- an operator can see it.
    local unknown = {}
    local plannedNames = {}
    for _, m in ipairs(planned) do plannedNames[m.filename] = true end
    for _, a in ipairs(applied) do
        if not plannedNames[a.migration] then unknown[#unknown + 1] = a.migration end
    end
    table.sort(unknown)

    return Nxc.Result.ok({ pending = pending, appliedAhead = unknown })
end

--- Split a migration file into individual statements.
---
--- oxmysql executes one statement per call, and a migration is a file of them.
--- This is in the shared module rather than beside the database code because it
--- is logic, and logic that decides where a schema change is cut apart is worth
--- testing before it runs against a real database.
---
--- **A statement ends at a semicolon followed by end of line.** A semicolon
--- inside a string literal or a comment would not be followed by one, which is
--- what makes the rule survive contact with real SQL. It is not a parser, and it
--- does not need to be: migrations here are written by us, and
--- MIGRATION_STANDARDS requires one statement per line ending.
---
--- Comment-only fragments are dropped. Sending one to the server is harmless and
--- makes an error message point at a comment, which is a small cruelty.
---
---@param sql string
---@return string[]
function Migrations.statements(sql)
    local out = {}
    for statement in (sql .. '\n'):gmatch('(.-);%s*\n') do
        -- Strip line comments before deciding whether anything remains, so a
        -- block of explanation between two statements is not mistaken for one.
        local bare = statement:gsub('%-%-[^\n]*', '')
        if bare:match('%S') then
            out[#out + 1] = (statement:gsub('^%s+', ''):gsub('%s+$', ''))
        end
    end
    return out
end

Nxc.Migrations = Migrations
return Migrations
