import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Cancel', () => {
  test('a fresh token is not cancelled', async () => {
    const r = await lua.doString(`return Nxc.Cancel.token():isCancelled()`);
    assert.equal(r, false);
  });

  test('cancelling runs callbacks exactly once', async () => {
    const r = await lua.doString(`
      local calls = 0
      local t = Nxc.Cancel.token()
      t:onCancel(function() calls = calls + 1 end)
      t:cancel('done')
      t:cancel('done again')
      return { calls = calls, cancelled = t:isCancelled(), reason = t.reason }
    `);
    assert.equal(r.calls, 1, 'a cleanup path that runs twice releases twice');
    assert.equal(r.cancelled, true);
    assert.equal(r.reason, 'done');
  });

  test('registering after cancellation runs the callback immediately', async () => {
    const r = await lua.doString(`
      local ran = false
      local t = Nxc.Cancel.token()
      t:cancel('early')
      t:onCancel(function() ran = true end)
      return ran
    `);
    assert.equal(r, true, 'a late registration must not leak what it should release');
  });

  test('a failing callback does not prevent the others', async () => {
    const r = await lua.doString(`
      local second = false
      local t = Nxc.Cancel.token()
      t:onCancel(function() error('boom') end)
      t:onCancel(function() second = true end)
      t:cancel()
      return second
    `);
    assert.equal(r, true);
  });

  test('a deadline cancels the token on read', async () => {
    const clock = await withFrozenClock(lua);
    await lua.doString(`
      __t = Nxc.Cancel.token({ deadlineMs = Nxc.Time.nowMs() + 1000 })
    `);
    let cancelled = await lua.doString(`return __t:isCancelled()`);
    assert.equal(cancelled, false);

    await clock.advance(1500);
    cancelled = await lua.doString(`return __t:isCancelled()`);
    assert.equal(cancelled, true, 'evaluated on read, so no timer is required');

    const reason = await lua.doString(`return __t.reason`);
    assert.equal(reason, 'timeout');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('a timed-out token needs an explicit idempotency flag for its error', async () => {
    const clock = await withFrozenClock(lua);
    await lua.doString(`__t2 = Nxc.Cancel.token({ deadlineMs = Nxc.Time.nowMs() + 10 })`);
    await clock.advance(50);
    const r = await lua.doString(`
      local e = __t2:toError('c-0000000000000001', false)
      return { code = e.code, retryable = e.retryable }
    `);
    assert.equal(r.code, 'NXC_LIB_TIMEOUT');
    assert.equal(r.retryable, false);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('a live token produces no error', async () => {
    const r = await lua.doString(`return Nxc.Cancel.token():toError('c-0000000000000001') == nil`);
    assert.equal(r, true);
  });

  test('any() cancels when a source cancels', async () => {
    const r = await lua.doString(`
      local a, b = Nxc.Cancel.token(), Nxc.Cancel.token()
      local combined = Nxc.Cancel.any({ a, b })
      b:cancel('b went away')
      return { cancelled = combined:isCancelled(), reason = combined.reason }
    `);
    assert.equal(r.cancelled, true);
    assert.equal(r.reason, 'b went away');
  });
});
