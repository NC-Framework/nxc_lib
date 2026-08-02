import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Serialize', () => {
  test('sensitive keys are redacted at any depth', async () => {
    const r = await lua.doString(`
      local out = Nxc.Serialize.redact({
        user = 'tillie',
        password = 'hunter2',
        nested = { api_key = 'sk_live_abc', webhook = 'https://discord.com/api/webhooks/1/x' },
      })
      return {
        user = out.user, password = out.password,
        apiKey = out.nested.api_key, webhook = out.nested.webhook,
      }
    `);
    assert.equal(r.user, 'tillie', 'non-sensitive fields survive');
    assert.equal(r.password, '[redacted]');
    assert.equal(r.apiKey, '[redacted]');
    assert.equal(r.webhook, '[redacted]');
  });

  test('redaction is case-insensitive', async () => {
    const r = await lua.doString(`
      local out = Nxc.Serialize.redact({ Password = 'x', TOKEN = 'y', SigningKey = 'z' })
      return { p = out.Password, t = out.TOKEN, s = out.SigningKey }
    `);
    assert.equal(r.p, '[redacted]');
    assert.equal(r.t, '[redacted]');
    assert.equal(r.s, '[redacted]');
  });

  test('over-long strings are truncated so a record cannot be inflated', async () => {
    const r = await lua.doString(`
      local out = Nxc.Serialize.redact({ blob = string.rep('x', 2000) }, 100)
      return { length = #out.blob, truncated = out.blob:find('more') ~= nil }
    `);
    assert.ok(r.length < 200);
    assert.equal(r.truncated, true);
  });

  test('functions and threads are never emitted', async () => {
    const r = await lua.doString(`
      local out = Nxc.Serialize.redact({ fn = function() end, co = coroutine.create(function() end) })
      return { fn = out.fn, co = out.co }
    `);
    assert.equal(r.fn, '[function]');
    assert.equal(r.co, '[thread]');
  });

  test('approximateSize grows with content', async () => {
    const r = await lua.doString(`
      return {
        small = Nxc.Serialize.approximateSize({ a = 1 }),
        large = Nxc.Serialize.approximateSize({ a = string.rep('x', 1000) }),
      }
    `);
    assert.ok(r.large > r.small + 900);
  });

  test('isTransportable rejects functions, cycles, and bad keys', async () => {
    const r = await lua.doString(`
      local cyclic = {}
      cyclic.self = cyclic
      local okPlain = Nxc.Serialize.isTransportable({ a = 1, b = 'two', c = { d = true } })
      local okFn = Nxc.Serialize.isTransportable({ fn = function() end })
      local okCycle = Nxc.Serialize.isTransportable(cyclic)
      return { plain = okPlain, fn = okFn, cycle = okCycle }
    `);
    assert.equal(r.plain, true);
    assert.equal(r.fn, false);
    assert.equal(r.cycle, false);
  });
});
