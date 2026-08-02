import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('Result', () => {
  test('ok carries a value and reports success', async () => {
    const r = await lua.doString(`
      local r = Nxc.Result.ok(42)
      return { ok = r.ok, value = r.value }
    `);
    assert.equal(r.ok, true);
    assert.equal(r.value, 42);
  });

  test('err carries a structured error', async () => {
    const r = await lua.doString(`
      local r = Nxc.Result.err(Nxc.Errors.internal('c-0000000000000001'))
      return { ok = r.ok, code = r.error.code }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_INTERNAL');
  });

  test('err rejects a bare string, which is how structured errors get bypassed', async () => {
    const threw = await lua.doString(`
      local ok = pcall(function() return Nxc.Result.err('something broke') end)
      return not ok
    `);
    assert.equal(threw, true);
  });

  test('a result is frozen against mutation', async () => {
    const threw = await lua.doString(`
      local r = Nxc.Result.ok(1)
      local ok = pcall(function() r.value = 999 end)
      return not ok
    `);
    assert.equal(threw, true);
  });

  test('map transforms a success and leaves a failure untouched', async () => {
    const r = await lua.doString(`
      local doubled = Nxc.Result.map(Nxc.Result.ok(21), function(v) return v * 2 end)
      local failed = Nxc.Result.map(
        Nxc.Result.err(Nxc.Errors.internal()), function(v) return v * 2 end)
      return { value = doubled.value, failedOk = failed.ok }
    `);
    assert.equal(r.value, 42);
    assert.equal(r.failedOk, false);
  });

  test('andThen short-circuits on the first failure', async () => {
    const r = await lua.doString(`
      local calls = 0
      local out = Nxc.Result.andThen(
        Nxc.Result.err(Nxc.Errors.internal()),
        function(v) calls = calls + 1 return Nxc.Result.ok(v) end)
      return { ok = out.ok, calls = calls }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.calls, 0, 'the callback must not run on a failed result');
  });

  test('andThen rejects a callback that does not return a Result', async () => {
    const threw = await lua.doString(`
      local ok = pcall(function()
        return Nxc.Result.andThen(Nxc.Result.ok(1), function() return 5 end)
      end)
      return not ok
    `);
    assert.equal(threw, true);
  });

  test('unwrapOr returns the default only on failure', async () => {
    const r = await lua.doString(`
      return {
        success = Nxc.Result.unwrapOr(Nxc.Result.ok('kept'), 'default'),
        failure = Nxc.Result.unwrapOr(Nxc.Result.err(Nxc.Errors.internal()), 'default'),
      }
    `);
    assert.equal(r.success, 'kept');
    assert.equal(r.failure, 'default');
  });

  test('all fails on the first failure and reports that error', async () => {
    const r = await lua.doString(`
      local out = Nxc.Result.all({
        Nxc.Result.ok(1),
        Nxc.Result.err(Nxc.Errors.forbidden('a.b.c')),
        Nxc.Result.ok(3),
      })
      return { ok = out.ok, code = out.error.code }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_FORBIDDEN');
  });

  test('all collects values when every result succeeded', async () => {
    const r = await lua.doString(`
      local out = Nxc.Result.all({ Nxc.Result.ok(1), Nxc.Result.ok(2) })
      return { ok = out.ok, first = out.value[1], second = out.value[2] }
    `);
    assert.equal(r.ok, true);
    assert.equal(r.first, 1);
    assert.equal(r.second, 2);
  });
});
