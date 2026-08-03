import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => {
  lua = await createEngine();
  await withFrozenClock(lua, 1700000000000);
});
afterEach(() => lua.global.close());

/**
 * These tests exist because 357 others did not catch the defect they describe.
 *
 * A frozen table works perfectly inside one Lua state and is empty to anything
 * that walks it rather than indexing it. Every test in this project runs inside
 * one state, so every one of them was blind to it.
 *
 * `next` is the tool: it is raw iteration, ignoring `__pairs` and `__index`,
 * which is exactly what a serialiser does.
 */
describe('Frozen tables are raw-empty', () => {
  test('a frozen table has no keys of its own', async () => {
    const r = await lua.doString(`
      local frozen = Nxc.freeze({ ok = true, value = 1 })
      return {
        readable = frozen.ok,
        viaPairs = (function() local n = 0 for _ in pairs(frozen) do n = n + 1 end return n end)(),
        rawKey = next(frozen) ~= nil,
      }
    `);
    // Reads fine, iterates fine with pairs, and is empty to raw iteration. That
    // gap is the whole defect.
    assert.equal(r.readable, true);
    assert.equal(r.viaPairs, 2);
    assert.equal(r.rawKey, false, 'raw iteration sees nothing — a serialiser sends {}');
  });

  test('every Result is frozen, so every Result has this property', async () => {
    const r = await lua.doString(`
      local okResult = Nxc.Result.ok({ a = 1 })
      local errResult = Nxc.Result.err(Nxc.Errors.internal())
      return { okRaw = next(okResult) ~= nil, errRaw = next(errResult) ~= nil }
    `);
    // Which is why an export returning one sends an empty table.
    assert.equal(r.okRaw, false);
    assert.equal(r.errRaw, false);
  });
});

describe('Nxc.plain', () => {
  test('produces a table a serialiser can actually see', async () => {
    const r = await lua.doString(`
      local plain = Nxc.plain(Nxc.Result.ok({ a = 1 }))
      local keys = {}
      for key in next, plain do keys[#keys + 1] = tostring(key) end
      table.sort(keys)
      return { rawKeys = table.concat(keys, ','), ok = plain.ok, a = plain.value.a }
    `);
    assert.equal(r.rawKeys, 'ok,value');
    assert.equal(r.ok, true);
    assert.equal(r.a, 1);
  });

  test('it is deep, because a Result carries nested frozen tables', async () => {
    const r = await lua.doString(`
      local nested = Nxc.Result.ok({ inner = Nxc.freeze({ deep = 'value' }) })
      local plain = Nxc.plain(nested)
      return {
        outerRaw = next(plain) ~= nil,
        innerRaw = next(plain.value.inner) ~= nil,
        deep = plain.value.inner.deep,
      }
    `);
    // A shallow copy would leave the nested one empty, which is the same bug one
    // level down and harder to spot.
    assert.equal(r.outerRaw, true);
    assert.equal(r.innerRaw, true);
    assert.equal(r.deep, 'value');
  });

  test('a structured error survives it intact', async () => {
    const r = await lua.doString(`
      local plain = Nxc.plain(Nxc.Result.err(Nxc.Errors.validationFailed(
        { fields = { { field = 'name', reason = 'is required' } } })))
      return {
        ok = plain.ok,
        code = plain.error.code,
        reason = plain.error.details.fields[1].reason,
        rawVisible = next(plain) ~= nil,
      }
    `);
    // The failure path has to cross a boundary too, and an error that arrives
    // empty is indistinguishable from success that arrives empty.
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_VALIDATION_FAILED');
    assert.equal(r.reason, 'is required');
    assert.equal(r.rawVisible, true);
  });

  test('scalars pass through untouched', async () => {
    const r = await lua.doString(`
      return {
        number = Nxc.plain(42),
        text = Nxc.plain('hello'),
        boolean = Nxc.plain(false),
        nothing = Nxc.plain(nil) == nil,
      }
    `);
    assert.equal(r.number, 42);
    assert.equal(r.text, 'hello');
    assert.equal(r.boolean, false);
    assert.equal(r.nothing, true);
  });

  test('the copy is independent of the original', async () => {
    const r = await lua.doString(`
      local source = { a = 1, nested = { b = 2 } }
      local plain = Nxc.plain(source)
      plain.a = 99
      plain.nested.b = 99
      return { sourceA = source.a, sourceB = source.nested.b }
    `);
    // A copy sharing nested tables would let a consumer mutate a producer's
    // state across what is meant to be a boundary.
    assert.equal(r.sourceA, 1);
    assert.equal(r.sourceB, 2);
  });
});
