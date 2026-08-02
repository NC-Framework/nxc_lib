import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('Time', () => {
  test('the clock is injectable so tests are deterministic', async () => {
    const clock = await withFrozenClock(lua, 1000);
    let now = await lua.doString(`return Nxc.Time.nowMs()`);
    assert.equal(now, 1000);
    await clock.advance(500);
    now = await lua.doString(`return Nxc.Time.nowMs()`);
    assert.equal(now, 1500);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('iso8601 formats with millisecond precision', async () => {
    await withFrozenClock(lua, 1700000000123);
    const s = await lua.doString(`return Nxc.Time.iso8601()`);
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(s.endsWith('.123Z'));
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('remaining never goes negative', async () => {
    const clock = await withFrozenClock(lua, 1000);
    let left = await lua.doString(`return Nxc.Time.remaining(2000)`);
    assert.equal(left, 1000);
    await clock.advance(5000);
    left = await lua.doString(`return Nxc.Time.remaining(2000)`);
    assert.equal(left, 0);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('durations format readably', async () => {
    const r = await lua.doString(`
      return {
        millis = Nxc.Time.formatDuration(250),
        seconds = Nxc.Time.formatDuration(45000),
        mixed = Nxc.Time.formatDuration(2 * 3600000 + 15 * 60000),
        negative = Nxc.Time.formatDuration(-5),
      }
    `);
    assert.equal(r.millis, '250ms');
    assert.equal(r.seconds, '45s');
    assert.equal(r.mixed, '2h 15m');
    assert.equal(r.negative, '0ms');
  });

  test('money formats from integer minor units', async () => {
    const r = await lua.doString(`
      return {
        simple = Nxc.Time.formatMoney(1234),
        grouped = Nxc.Time.formatMoney(123456789),
        negative = Nxc.Time.formatMoney(-500),
        zero = Nxc.Time.formatMoney(0),
      }
    `);
    assert.equal(r.simple, '$12.34');
    assert.equal(r.grouped, '$1,234,567.89');
    assert.equal(r.negative, '-$5.00');
    assert.equal(r.zero, '$0.00');
  });

  test('money rejects a fractional minor unit', async () => {
    const threw = await lua.doString(`
      return not pcall(function() return Nxc.Time.formatMoney(10.5) end)
    `);
    assert.equal(threw, true, 'a fractional minor unit means an arithmetic bug upstream');
  });
});
