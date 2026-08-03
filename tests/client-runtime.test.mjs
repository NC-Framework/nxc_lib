import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceEngine } from './boundary.mjs';

/**
 * The client runtime is SMALLER than Lua, and these tests hold shared code to it.
 *
 * CitizenFX gives the FiveM client a reduced standard library: `os` is absent.
 * Shared code calling `os.time` or `os.date` runs perfectly on the server and
 * dies on the client with `attempt to index a nil value (global 'os')`.
 *
 * Found in deployment, and it failed twice over: `/nxcui confirm` crashed in
 * Focus.acquire reaching for the clock, and the log line reporting that crash
 * crashed too, inside the logger's own timestamp.
 *
 * Every existing test missed it because wasmoon is plain Lua 5.4 and has the
 * whole standard library. A test runtime MORE capable than the target certifies
 * code the target cannot run — the one direction a harness must never be
 * trusted in.
 *
 * `realClock: true` throughout, deliberately. The harness normally installs a
 * frozen clock, and that override was itself enough to hide this: the defect was
 * put back on purpose and fourteen client-mode tests stayed green, because
 * nothing ever called the clock that would have reached for `os`.
 */
describe('Shared code on the client runtime, where os does not exist', () => {
  let lua;
  beforeEach(async () => {
    lua = await createResourceEngine('nxc_lib', {
      server: false, realClock: true, blocks: ['shared_scripts'],
    });
  });
  afterEach(() => lua.global.close());

  test('os really is gone, or none of these tests mean anything', async () => {
    const r = await lua.doString(`return type(os) .. ',' .. type(io)`);
    assert.equal(r, 'nil,nil');
  });

  test('the clock works without os', async () => {
    const r = await lua.doString(`return Nxc.Time.nowMs()`);
    assert.equal(typeof r, 'number');
    assert.ok(r > 0);
  });

  test('iso8601 works without os.date', async () => {
    const r = await lua.doString(`return Nxc.Time.iso8601(1700000000000)`);
    // A fixed instant, so the arithmetic is checked and not merely exercised.
    assert.equal(r, '2023-11-14T22:13:20.000Z');
  });

  test('the logger can write its own timestamp', async () => {
    // The second crash in deployment was here: the diagnostic reporting the
    // failure failed the same way. A logger that cannot report its own error is
    // worse than no logger.
    const r = await lua.doString(`
      local seen
      Nxc.Logger.setSink(function(record) seen = record.timestamp end)
      Nxc.Logger.warn('client.test', { detail = 'x' })
      return tostring(seen)
    `);
    assert.match(r, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('a correlation id can be generated', async () => {
    const r = await lua.doString(`return Nxc.Correlation.new()`);
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  });

  test('the rate limiter works, since it is a client-side defence too', async () => {
    const r = await lua.doString(`
      -- A slow refill, so the stubbed timer advancing 16ms per call cannot
      -- quietly refill the bucket between takes. A limiter test that depends on
      -- how fast the clock moves is testing the clock. Zero is refused outright,
      -- which is correct — a bucket that never refills is a bucket that jams.
      local limiter = Nxc.RateLimit.new({ capacity = 2, refillPerSecond = 0.001 })
      return {
        first = limiter:allow('k'),
        second = limiter:allow('k'),
        third = limiter:allow('k'),
      }
    `);
    assert.equal(r.first, true);
    assert.equal(r.second, true);
    assert.equal(r.third, false);
  });
});

describe('Timestamp arithmetic, which is now ours rather than os.date', () => {
  let lua;
  beforeEach(async () => {
    lua = await createResourceEngine('nxc_lib', {
      server: false, realClock: true, blocks: ['shared_scripts'],
    });
  });
  afterEach(() => lua.global.close());

  test('known instants format correctly', async () => {
    const r = await lua.doString(`
      return {
        epoch = Nxc.Time.iso8601(0),
        leapDay = Nxc.Time.iso8601(1709208000000),
        millis = Nxc.Time.iso8601(1700000000123),
        y2038 = Nxc.Time.iso8601(2147483648000),
      }
    `);
    // Hand-rolled civil-from-days arithmetic is exactly the sort of thing that
    // is subtly wrong at boundaries, so the boundaries are the cases.
    assert.equal(r.epoch, '1970-01-01T00:00:00.000Z');
    assert.equal(r.leapDay, '2024-02-29T12:00:00.000Z');
    assert.equal(r.millis, '2023-11-14T22:13:20.123Z');
    assert.equal(r.y2038, '2038-01-19T03:14:08.000Z');
  });
});
