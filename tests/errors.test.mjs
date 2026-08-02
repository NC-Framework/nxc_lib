import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('Errors', () => {
  test('an error carries the full project-wide shape', async () => {
    const e = await lua.doString(`
      local e = Nxc.Errors.new('NXC_LIB_INTERNAL', 'Something went wrong.', {
        correlationId = 'c-0000000000000001',
        details = { field = 'amount' },
      })
      return {
        code = e.code, message = e.message, resource = e.resource,
        correlationId = e.correlationId, retryable = e.retryable,
        detailField = e.details.field,
      }
    `);
    assert.equal(e.code, 'NXC_LIB_INTERNAL');
    assert.equal(e.resource, 'nxc_lib');
    assert.equal(e.correlationId, 'c-0000000000000001');
    assert.equal(e.retryable, false);
    assert.equal(e.detailField, 'amount');
  });

  test('retryable defaults correctly per condition', async () => {
    const r = await lua.doString(`
      return {
        validation = Nxc.Errors.validationFailed({}).retryable,
        forbidden = Nxc.Errors.forbidden('a.b.c').retryable,
        rateLimited = Nxc.Errors.rateLimited().retryable,
        session = Nxc.Errors.sessionInvalid().retryable,
      }
    `);
    assert.equal(r.validation, false, 'the same input will fail again');
    assert.equal(r.forbidden, false, 'capabilities do not change on retry');
    assert.equal(r.rateLimited, true);
    assert.equal(r.session, false);
  });

  test('timeout requires an explicit idempotency flag', async () => {
    const threw = await lua.doString(`
      local ok = pcall(function() return Nxc.Errors.timeout('c-0000000000000001') end)
      return not ok
    `);
    assert.equal(threw, true, 'guessing here is how duplicate transactions happen');
  });

  test('a timeout is retryable only when the operation is idempotent', async () => {
    const r = await lua.doString(`
      return {
        idempotent = Nxc.Errors.timeout('c-0000000000000001', true).retryable,
        notIdempotent = Nxc.Errors.timeout('c-0000000000000001', false).retryable,
      }
    `);
    assert.equal(r.idempotent, true);
    assert.equal(r.notIdempotent, false);
  });

  test('the player view strips details and resource', async () => {
    const r = await lua.doString(`
      local e = Nxc.Errors.forbidden('police.evidence.destroy', 'c-0000000000000001')
      local p = Nxc.Errors.toPlayer(e)
      local keys = {}
      for k in pairs(p) do keys[#keys+1] = k end
      table.sort(keys)
      return { keys = table.concat(keys, ','), hasDetails = p.details ~= nil }
    `);
    assert.equal(r.hasDetails, false, 'details are written for operators, not players');
    assert.equal(r.keys, 'code,correlationId,message,retryable');
  });

  test('an error requires a code', async () => {
    const threw = await lua.doString(`
      return not pcall(function() return Nxc.Errors.new('', 'x') end)
    `);
    assert.equal(threw, true);
  });

  test('registered codes are recognised and unknown ones are not', async () => {
    const r = await lua.doString(`
      return {
        known = Nxc.Errors.isRegistered('NXC_LIB_FORBIDDEN'),
        unknown = Nxc.Errors.isRegistered('NXC_LIB_MADE_UP'),
      }
    `);
    assert.equal(r.known, true);
    assert.equal(r.unknown, false);
  });
});
