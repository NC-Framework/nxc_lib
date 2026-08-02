import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Envelope', () => {
  test('a request envelope carries method, id, and correlation', async () => {
    const r = await lua.doString(`
      local env = Nxc.Envelope.request('nxc_banking:transfer', { amount = 5 })
      return {
        kind = env.kind, method = env.method,
        validId = Nxc.Correlation.isValid(env.id),
        validCorrelation = Nxc.Correlation.isValid(env.correlationId),
      }
    `);
    assert.equal(r.kind, 'request');
    assert.equal(r.method, 'nxc_banking:transfer');
    assert.equal(r.validId, true);
    assert.equal(r.validCorrelation, true);
  });

  test('a malformed method name is rejected at construction', async () => {
    const r = await lua.doString(`
      return {
        noColon = not pcall(function() return Nxc.Envelope.request('transfer') end),
        tooMany = not pcall(function() return Nxc.Envelope.request('a:b:c') end),
        empty = not pcall(function() return Nxc.Envelope.request('') end),
      }
    `);
    assert.equal(r.noColon, true);
    assert.equal(r.tooMany, true);
    assert.equal(r.empty, true);
  });

  test('an event name must be resource:side:action', async () => {
    const r = await lua.doString(`
      return {
        good = Nxc.Envelope.event('nxc_inventory:server:itemAdded', {}).kind,
        bad = not pcall(function() return Nxc.Envelope.event('itemAdded', {}) end),
      }
    `);
    assert.equal(r.good, 'event');
    assert.equal(r.bad, true);
  });

  test('a failure response carries the player view, not the full error', async () => {
    const r = await lua.doString(`
      local req = Nxc.Envelope.request('nxc_banking:transfer', {})
      local res = Nxc.Envelope.failure(req, Nxc.Errors.forbidden('banking.accounts.transfer'))
      return {
        ok = res.ok, id = res.id == req.id,
        code = res.error.code, hasDetails = res.error.details ~= nil,
      }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.id, true);
    assert.equal(r.code, 'NXC_LIB_FORBIDDEN');
    assert.equal(r.hasDetails, false, 'details may name capabilities and thresholds');
  });

  test('validate rejects a non-table and an unknown kind', async () => {
    const r = await lua.doString(`
      return {
        str = Nxc.Envelope.validate('hello').ok,
        unknown = Nxc.Envelope.validate({ kind = 'sneaky' }).ok,
      }
    `);
    assert.equal(r.str, false);
    assert.equal(r.unknown, false);
  });

  test('validate rejects an envelope with a forged correlation id', async () => {
    const r = await lua.doString(`
      local env = Nxc.Envelope.request('nxc_banking:transfer', {})
      env.correlationId = "'; DROP TABLE --"
      local out = Nxc.Envelope.validate(env, 'request')
      return { ok = out.ok, code = out.error.code }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_MALFORMED_ENVELOPE');
  });

  test('validate rejects an unexpected kind', async () => {
    const r = await lua.doString(`
      local env = Nxc.Envelope.request('nxc_banking:transfer', {})
      return { ok = Nxc.Envelope.validate(env, 'response').ok }
    `);
    assert.equal(r.ok, false);
  });

  test('an oversized payload is rejected at the boundary', async () => {
    const r = await lua.doString(`
      local env = Nxc.Envelope.request('nxc_banking:transfer', { blob = string.rep('x', 40000) })
      local out = Nxc.Envelope.validate(env, 'request')
      return { ok = out.ok, code = out.error.code }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_PAYLOAD_TOO_LARGE');
  });

  test('a well-formed request validates', async () => {
    const r = await lua.doString(`
      local env = Nxc.Envelope.request('nxc_banking:transfer', { amount = 100 })
      return { ok = Nxc.Envelope.validate(env, 'request').ok }
    `);
    assert.equal(r.ok, true);
  });

  test('deadline expiry is computed against the clock', async () => {
    const clock = await withFrozenClock(lua);
    let r = await lua.doString(`
      __env = Nxc.Envelope.request('nxc_banking:transfer', {}, { timeoutMs = 5000 })
      return Nxc.Envelope.isExpired(__env)
    `);
    assert.equal(r, false);
    await clock.advance(6000);
    r = await lua.doString(`return Nxc.Envelope.isExpired(__env)`);
    assert.equal(r, true);
    await lua.doString(`Nxc.Time.resetClock()`);
  });
});
