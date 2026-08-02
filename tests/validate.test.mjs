import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('Validate', () => {
  test('accepts a payload matching its schema', async () => {
    const r = await lua.doString(`
      local schema = {
        amount = { type = 'integer', min = 1 },
        note = { type = 'string', required = false, max = 20 },
      }
      local out = Nxc.Validate.against(schema, { amount = 5, note = 'ok' })
      return { ok = out.ok }
    `);
    assert.equal(r.ok, true);
  });

  test('reports which field failed and why', async () => {
    const r = await lua.doString(`
      local schema = { amount = { type = 'integer', min = 10 } }
      local out = Nxc.Validate.against(schema, { amount = 2 })
      return {
        ok = out.ok,
        code = out.error.code,
        field = out.error.details.fields[1].field,
        reason = out.error.details.fields[1].reason,
      }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_VALIDATION_FAILED');
    assert.equal(r.field, 'amount');
    assert.match(r.reason, /at least 10/);
  });

  test('a missing required field is reported', async () => {
    const r = await lua.doString(`
      local out = Nxc.Validate.against({ id = { type = 'string' } }, {})
      return { ok = out.ok, reason = out.error.details.fields[1].reason }
    `);
    assert.equal(r.ok, false);
    assert.match(r.reason, /required/);
  });

  test('unknown keys are rejected rather than ignored', async () => {
    const r = await lua.doString(`
      local out = Nxc.Validate.against({ a = { type = 'string' } }, { a = 'x', sneaky = 1 })
      return { ok = out.ok, field = out.error.details.fields[1].field }
    `);
    assert.equal(r.ok, false, 'ignoring them lets a caller believe a typo was applied');
    assert.equal(r.field, 'sneaky');
  });

  test('an integer field rejects a fraction', async () => {
    const r = await lua.doString(`
      local out = Nxc.Validate.against({ n = { type = 'integer' } }, { n = 1.5 })
      return { ok = out.ok }
    `);
    assert.equal(r.ok, false);
  });

  test('NaN and infinity are rejected', async () => {
    const r = await lua.doString(`
      local schema = { n = { type = 'number', min = 0, max = 100 } }
      return {
        nan = Nxc.Validate.against(schema, { n = 0/0 }).ok,
        inf = Nxc.Validate.against(schema, { n = math.huge }).ok,
      }
    `);
    assert.equal(r.nan, false, 'NaN fails every comparison and would pass a range check');
    assert.equal(r.inf, false);
  });

  test('a non-table payload is rejected', async () => {
    const r = await lua.doString(`
      return {
        str = Nxc.Validate.against({}, 'nope').ok,
        nilv = Nxc.Validate.against({}, nil).ok,
      }
    `);
    assert.equal(r.str, false);
    assert.equal(r.nilv, false);
  });

  test('arrays validate their elements', async () => {
    const r = await lua.doString(`
      local schema = { ids = { type = 'array', of = { type = 'string' }, max = 2 } }
      return {
        good = Nxc.Validate.against(schema, { ids = { 'a', 'b' } }).ok,
        tooMany = Nxc.Validate.against(schema, { ids = { 'a', 'b', 'c' } }).ok,
        wrongElement = Nxc.Validate.against(schema, { ids = { 'a', 5 } }).ok,
      }
    `);
    assert.equal(r.good, true);
    assert.equal(r.tooMany, false);
    assert.equal(r.wrongElement, false);
  });

  test('oneOf constrains allowed values', async () => {
    const r = await lua.doString(`
      local schema = { mode = { type = 'string', oneOf = { 'a', 'b' } } }
      return {
        allowed = Nxc.Validate.against(schema, { mode = 'a' }).ok,
        rejected = Nxc.Validate.against(schema, { mode = 'c' }).ok,
      }
    `);
    assert.equal(r.allowed, true);
    assert.equal(r.rejected, false);
  });

  test('an over-long string is rejected', async () => {
    const r = await lua.doString(`
      local out = Nxc.Validate.against(
        { s = { type = 'string' } }, { s = string.rep('x', 5000) })
      return { ok = out.ok }
    `);
    assert.equal(r.ok, false);
  });

  test('a compiled validator is reusable', async () => {
    const r = await lua.doString(`
      local v = Nxc.Validate.compile({ n = { type = 'integer' } })
      return { first = v({ n = 1 }).ok, second = v({ n = 'x' }).ok }
    `);
    assert.equal(r.first, true);
    assert.equal(r.second, false);
  });
});
