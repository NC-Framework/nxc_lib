/**
 * A test harness that runs TWO Lua states and marshals between them.
 *
 * Every other harness in this project loads one state and calls into it. A FiveM
 * server does not work that way: each resource has its own Lua state, and values
 * crossing between them are copied, not shared. RSK-25 exists because that gap
 * cost a release — `Nxc.freeze` returns `setmetatable({}, { __index = t })`, so a
 * frozen table has no keys of its own, and every export returning a `Result`
 * crossed the boundary as `{}` while 357 tests passed.
 *
 * WHAT THIS DOES AND DOES NOT CLAIM.
 *
 * It does not replicate CitizenFX's marshalling. It models the one property that
 * actually caused the defect and that nothing else in the suite can see:
 *
 *   a value crossing a boundary is copied by RAW traversal, and no metatable,
 *   identity, or function reference survives the crossing.
 *
 * That is why `__rawEncode` below uses `next` rather than `pairs`. Using `pairs`
 * would make a frozen table cross intact and the harness would certify the exact
 * bug it was built to catch.
 *
 * Encoding goes through a Lua source literal rather than the runner's own
 * table conversion, deliberately: whether wasmoon converts with `pairs` or `next`
 * is an implementation detail of the runner, and a harness whose central claim
 * rests on an undocumented detail of its own tooling is not evidence of anything.
 *
 * KNOWN LIMITATION — FUNCTION REFERENCES.
 *
 * This refuses to carry a function, on the grounds that nothing serialises a
 * closure. That is true of a *copy*, and CitizenFX appears to go further: it
 * supports passing a function across a resource boundary as a reference proxy,
 * which is how callback-style exports work elsewhere in the ecosystem.
 *
 * That has NOT been verified on a server, and it is stated here as unverified
 * rather than assumed — assuming how the platform behaves is what produced the
 * defect this harness exists for. The practical consequence is that
 * `nxc_ui:onCallback`, which takes a handler function, cannot be covered here and
 * stays on check-reachability's worklist with this as the reason.
 *
 * Modelling function references would mean building a proxy that calls back into
 * the originating state. Worth doing when a second export needs it; not worth it
 * for one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '..', '..');

/** Folder names differ from resource names where a checkout predates a rename. */
const FOLDER = { nxc_core: 'nexus_core' };

function resourceDir(resource) {
  const named = join(workspace, FOLDER[resource] ?? resource);
  if (!existsSync(named)) throw new Error(`no checkout for resource ${resource}`);
  return named;
}

function expand(entry, root) {
  let base = root;
  let rel = entry;
  const external = entry.match(/^@([\w-]+)\/(.+)$/);
  if (external) {
    base = resourceDir(external[1]);
    rel = external[2];
  }
  return join(base, rel);
}

/** Script paths a resource declares, in declared order, for the given blocks. */
function declaredScripts(resource, blocks) {
  const root = resourceDir(resource);
  const manifest = readFileSync(join(root, 'fxmanifest.lua'), 'utf8');
  const out = [];
  for (const block of blocks) {
    const found = manifest.match(new RegExp(`${block}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!found) continue;
    for (const m of found[1].matchAll(/'([^']+)'/g)) out.push(expand(m[1], root));
  }
  return out;
}

/**
 * Encode a value as a Lua source literal, by raw traversal.
 *
 * `next` throughout, never `pairs`. A frozen table therefore encodes as `{}`,
 * which is precisely what a real export does with one — reproducing the defect
 * rather than papering over it.
 *
 * Functions refuse to cross, because they genuinely cannot: nothing serialises a
 * closure. A test that passes one is making an assumption a real server will not
 * honour, and failing loudly here is the point.
 */
const RAW_ENCODE = `
function __rawEncode(value, seen)
    seen = seen or {}
    local kind = type(value)

    if value == nil then return 'nil' end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'number' then
        if value ~= value then error('NaN does not survive a resource boundary', 0) end
        if value == math.huge or value == -math.huge then
            error('infinity does not survive a resource boundary', 0)
        end
        return string.format('%.17g', value)
    end
    if kind == 'string' then return string.format('%q', value) end
    if kind == 'function' then
        error('a function cannot cross a resource boundary — nothing serialises a closure', 0)
    end
    if kind ~= 'table' then
        error('a ' .. kind .. ' cannot cross a resource boundary', 0)
    end

    if seen[value] then
        error('a table containing itself cannot cross a resource boundary', 0)
    end
    seen[value] = true

    local parts = {}
    -- RAW ITERATION. \`next\` ignores __pairs and __index, which is what a
    -- serialiser does and what makes a frozen table arrive empty.
    for key, item in next, value do
        parts[#parts + 1] = '[' .. __rawEncode(key, seen) .. ']='
                         .. __rawEncode(item, seen)
    end

    seen[value] = nil
    return '{' .. table.concat(parts, ',') .. '}'
end
`;

/**
 * Natives a resource's server files reach for at load.
 *
 * Stubbed rather than absent: a missing native is a nil-call error at load, which
 * would say the file is broken when the truth is that the harness is incomplete.
 */
function nativeStubs(resource, opts = {}) {
  const isServer = opts.server !== false;

  /**
   * THE CLIENT RUNTIME IS SMALLER THAN LUA, and the harness must be too.
   *
   * CitizenFX gives the client a reduced standard library: `os` is absent, and
   * shared code calling `os.time` or `os.date` runs perfectly on the server and
   * dies on the client. wasmoon is plain Lua 5.4 and has all of it, so a test
   * runtime MORE capable than the target certifies code the target cannot run.
   *
   * Found in deployment: `/nxcui confirm` crashed reaching for the clock, and
   * the log line reporting the crash crashed in the logger's own timestamp.
   *
   * Removing them here is what makes a client-mode test mean something. If this
   * is ever softened to keep a suite green, the suite stops testing the client.
   */
  const stripServerOnly = isServer ? '' : `
    os = nil
    io = nil
  `;

  return stripServerOnly + `
    __exports = {}
    __events = {}
    __log = {}

    function exports(name, fn) __exports[name] = fn end
    function IsDuplicityVersion() return ${opts.server === false ? 'false' : 'true'} end
    function GetCurrentResourceName() return '${resource}' end
    function GetInvokingResource() return __invokingResource end
    function GetResourceState() return 'started' end
    function GetConvar(_, fallback) return fallback end
    function GetResourceMetadata(_, key)
        if key == 'version' then return '${opts.version ?? '0.0.0-boundary'}' end
        return nil
    end

    function AddEventHandler(name, fn) __events[name] = fn end
    function RegisterNetEvent(name, fn) if fn then __events[name] = fn end end
    function RegisterServerEvent(name, fn) if fn then __events[name] = fn end end
    function RegisterNUICallback() end
    function RegisterKeyMapping() end
    function TriggerEvent() end
    function TriggerClientEvent() end
    function TriggerServerEvent() end
    function CreateThread() end
    function Wait() end
    function SetTimeout() end
    function print() end

    __commands = {}
    function RegisterCommand(name, fn) __commands[name] = fn end

    -- Enough of the server surface that a resource loads. Anything reached at
    -- LOAD time has to exist; anything reached only inside a handler does not,
    -- because no handler runs here.
    function GetPlayerName() return 'boundary' end
    function GetPlayerIdentifiers() return {} end
    function GetNumPlayerIdentifiers() return 0 end
    -- A TICKING timer, not a constant. GetGameTimer stuck at zero makes every
    -- duration zero, which turns a rate limiter into a no-op and a deadline into
    -- one that never arrives — a stub that lies quietly.
    __gameTimerMs = 0
    function GetGameTimer() __gameTimerMs = __gameTimerMs + 16 return __gameTimerMs end
    function GetHashKey() return 0 end
    function PerformHttpRequest() end
    function ExecuteCommand() end
    function CancelEvent() end

    -- NUI natives, recorded rather than discarded: what a client resource sends
    -- to the browser and what focus state it pushed are both assertable.
    __nuiMessages = {}
    __nuiFocus = { hasFocus = false, hasCursor = false }
    function SendNUIMessage(message) __nuiMessages[#__nuiMessages + 1] = message end
    function SetNuiFocus(hasFocus, hasCursor)
        __nuiFocus = { hasFocus = hasFocus, hasCursor = hasCursor }
    end

    Citizen = { CreateThread = CreateThread, Wait = Wait, SetTimeout = SetTimeout }
  `;
}

/**
 * Load one resource into its own Lua state.
 *
 * Shared scripts then server scripts, in the order the manifest declares — the
 * same order the server uses, so a manifest reordered wrongly fails here.
 */
export async function createResourceEngine(resource, opts = {}) {
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  await lua.doString(nativeStubs(resource, opts) + RAW_ENCODE);

  const blocks = opts.blocks ?? ['shared_scripts', 'server_scripts'];
  const files = declaredScripts(resource, blocks).filter(existsSync);

  /**
   * Every file wrapped in a function, and the whole resource loaded as ONE chunk.
   *
   * TWO REASONS, AND THE SECOND IS NOT AN OPTIMISATION.
   *
   * The wrapper reproduces FiveM's file scoping: each file is its own chunk
   * there, so its top-level locals are private and a trailing `return X` ends
   * that file rather than everything after it. Concatenating raw would leak
   * locals between files and let the first `return` terminate the rest.
   *
   * The single chunk is because wasmoon leaks on every `doString` and an engine
   * stops working after roughly sixty. A boundary test builds TWO engines, each
   * loading around thirty files — which lands past the cliff and fails with
   * `memory access out of bounds` in the middle of an unrelated assertion.
   */
  const combined = files
    .map((f) => `;(function()\n${readFileSync(f, 'utf8')}\nend)();`)
    .join('\n');

  try {
    await lua.doString(combined);
  } catch (err) {
    // Which file? The combined chunk's line number names nothing useful, so on
    // failure only, pay the per-file cost to say something true.
    for (const file of files) {
      try {
        await lua.doString(`;(function()\n${readFileSync(file, 'utf8')}\nend)();`);
      } catch (inner) {
        throw new Error(`${resource}: failed loading ${file}: ${inner.message}`);
      }
    }
    throw new Error(`${resource}: failed to load, but each file loads alone: ${err.message}`);
  }

  /**
   * A deterministic clock, so a boundary test is never a timing test.
   *
   * `realClock: true` SKIPS IT, and that option exists because the override was
   * hiding the very thing client mode was built to catch. Stripping `os` proves
   * nothing if the first thing the harness does afterwards is replace every call
   * that would have reached for it — the defect was reintroduced deliberately
   * and fourteen client-mode tests stayed green.
   */
  if (!opts.realClock) {
    await lua.doString(`
      if Nxc and Nxc.Time then
        __testClockMs = ${opts.nowMs ?? 1_700_000_000_000}
        Nxc.Time.setClock(function() return __testClockMs end)
      end
    `);
  }

  return lua;
}

/**
 * Two states, and a way to call an export from one into the other.
 *
 * `provider` is the resource that registers the export; `consumer` is the one
 * that calls it. They are separate engines that share no memory, which is the
 * whole point.
 */
export async function createBoundary({ provider, consumer, ...opts }) {
  const providerLua = await createResourceEngine(provider, opts);
  const consumerLua = await createResourceEngine(consumer, opts);

  /**
   * Call an export across the boundary.
   *
   * Both the arguments and the return value are encoded by raw traversal and
   * rebuilt in the other state, so nothing is shared by reference and no
   * metatable survives — exactly like the real thing.
   */
  async function callExport(name, args = [], { from = consumer } = {}) {
    const encodedArgs = [];
    for (const arg of args) {
      // Arguments are built in the CONSUMER's state, so they are encoded there.
      const literal = await consumerLua.doString(
        `return __rawEncode(${typeof arg === 'string' ? JSON.stringify(arg) : luaLiteral(arg)})`);
      encodedArgs.push(literal);
    }

    const call = `
      __invokingResource = ${JSON.stringify(from)}
      local fn = __exports[${JSON.stringify(name)}]
      if not fn then error('no export named ' .. ${JSON.stringify(name)}, 0) end
      local ok, result = pcall(fn${encodedArgs.length ? ', ' + encodedArgs.join(', ') : ''})
      __invokingResource = nil
      if not ok then error(result, 0) end
      return __rawEncode(result)
    `;
    const returned = await providerLua.doString(call);

    // Rebuilt in the consumer's state, which is where a caller would read it.
    return consumerLua.doString(`return (load('return ' .. ${JSON.stringify(returned)}))()`);
  }

  return {
    provider: providerLua,
    consumer: consumerLua,
    callExport,
    close() {
      providerLua.global.close();
      consumerLua.global.close();
    },
  };
}

/** A JS value as Lua source. Only what a test would plausibly pass. */
function luaLiteral(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `{${value.map(luaLiteral).join(',')}}`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `[${JSON.stringify(k)}]=${luaLiteral(v)}`).join(',')}}`;
  }
  throw new Error(`cannot express ${typeof value} as Lua`);
}

export { luaLiteral };
