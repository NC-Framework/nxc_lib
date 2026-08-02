import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('RateLimit', () => {
  // Named keys rather than a Lua sequence: wasmoon converts a sequence to a
  // 0-indexed JS array, so index-based assertions read off by one.
  test('allows up to capacity then denies', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      local l = Nxc.RateLimit.new({ capacity = 3, refillPerSecond = 1 })
      return {
        first = l:allow('actor-1'),
        second = l:allow('actor-1'),
        third = l:allow('actor-1'),
        fourth = l:allow('actor-1'),
      }
    `);
    assert.equal(r.first, true);
    assert.equal(r.second, true);
    assert.equal(r.third, true, 'capacity is three, so the third call is still allowed');
    assert.equal(r.fourth, false);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('refills over time', async () => {
    const clock = await withFrozenClock(lua);
    await lua.doString(`
      __l = Nxc.RateLimit.new({ capacity = 2, refillPerSecond = 1 })
      __l:allow('a'); __l:allow('a')
    `);
    let allowed = await lua.doString(`return __l:allow('a')`);
    assert.equal(allowed, false, 'bucket is empty');

    await clock.advance(1000);
    allowed = await lua.doString(`return __l:allow('a')`);
    assert.equal(allowed, true, 'one second refills one token');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('limits are per key, so one actor cannot starve another', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      local l = Nxc.RateLimit.new({ capacity = 1, refillPerSecond = 1 })
      l:allow('actor-a')
      return { a = l:allow('actor-a'), b = l:allow('actor-b') }
    `);
    assert.equal(r.a, false);
    assert.equal(r.b, true);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('a denial reports how long to wait', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      local l = Nxc.RateLimit.new({ capacity = 1, refillPerSecond = 2 })
      l:allow('a')
      local allowed, waitMs = l:allow('a')
      return { allowed = allowed, waitMs = waitMs }
    `);
    assert.equal(r.allowed, false);
    assert.ok(r.waitMs > 0 && r.waitMs <= 500, `expected a sub-second wait, got ${r.waitMs}`);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('invalid configuration is rejected', async () => {
    const r = await lua.doString(`
      return {
        zeroCapacity = not pcall(function()
          return Nxc.RateLimit.new({ capacity = 0, refillPerSecond = 1 }) end),
        zeroRefill = not pcall(function()
          return Nxc.RateLimit.new({ capacity = 1, refillPerSecond = 0 }) end),
      }
    `);
    assert.equal(r.zeroCapacity, true);
    assert.equal(r.zeroRefill, true);
  });

  test('prune drops idle full buckets so the table does not grow without bound', async () => {
    const clock = await withFrozenClock(lua);
    await lua.doString(`
      __l = Nxc.RateLimit.new({ capacity = 2, refillPerSecond = 10 })
      __l:allow('a'); __l:allow('b'); __l:allow('c')
    `);
    let size = await lua.doString(`return __l:size()`);
    assert.equal(size, 3);

    await clock.advance(60000);
    const removed = await lua.doString(`return __l:prune(30000)`);
    assert.equal(removed, 3);
    size = await lua.doString(`return __l:size()`);
    assert.equal(size, 0);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('forget removes a key on disconnect', async () => {
    await withFrozenClock(lua);
    const size = await lua.doString(`
      local l = Nxc.RateLimit.new({ capacity = 1, refillPerSecond = 1 })
      l:allow('a')
      l:forget('a')
      return l:size()
    `);
    assert.equal(size, 0);
    await lua.doString(`Nxc.Time.resetClock()`);
  });
});
