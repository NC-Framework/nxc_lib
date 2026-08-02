/**
 * Test harness: loads the shared Lua modules into a Lua 5.4 engine running under
 * WebAssembly, so pure-logic modules are testable without the FiveM runtime.
 *
 * This is why modules must call no natives. wasmoon provides Lua, not FiveM —
 * there is no GetPlayerPed and no TriggerClientEvent. Any logic entangled with a
 * native is untestable here and belongs in a separate module.
 *
 * Files load in filename order, which is the same order `shared_scripts` globs
 * them in the manifest. A module that depends on one loaded later would fail
 * here for the same reason it would fail on a server.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaFactory } from 'wasmoon';

const here = dirname(fileURLToPath(import.meta.url));
const sharedDir = resolve(here, '..', 'shared');

/**
 * Create an engine with every shared module loaded.
 *
 * A fresh engine per test file keeps state isolated: a test that depends on
 * another test having run is a test that fails when run alone.
 */
export async function createEngine() {
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  const files = readdirSync(sharedDir)
    .filter((f) => f.endsWith('.lua'))
    .sort();

  for (const file of files) {
    const source = readFileSync(join(sharedDir, file), 'utf8');
    try {
      await lua.doString(source);
    } catch (err) {
      throw new Error(`failed loading shared/${file}: ${err.message}`);
    }
  }

  return lua;
}

/**
 * Run a Lua snippet and return its value.
 *
 * The snippet body is wrapped so `return` works directly.
 */
export async function evalLua(lua, source) {
  return lua.doString(source);
}

/**
 * Load the engine, run a snippet, close the engine.
 *
 * Closing matters: each engine holds a WASM instance, and a suite that leaks
 * them exhausts memory long before it finishes.
 */
export async function withLua(fn) {
  const lua = await createEngine();
  try {
    return await fn(lua);
  } finally {
    lua.global.close();
  }
}

/**
 * Install a deterministic clock.
 *
 * Returns a controller so a test can advance time explicitly. A test that waits
 * for real time is slow; one that depends on real time is flaky.
 */
export async function withFrozenClock(lua, startMs = 1_700_000_000_000) {
  await lua.doString(`
    __testClockMs = ${startMs}
    Nxc.Time.setClock(function() return __testClockMs end)
  `);
  return {
    async advance(ms) {
      await lua.doString(`__testClockMs = __testClockMs + ${ms}`);
    },
    async set(ms) {
      await lua.doString(`__testClockMs = ${ms}`);
    },
  };
}
