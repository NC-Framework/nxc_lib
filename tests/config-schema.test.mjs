import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('ConfigSchema', () => {
  test('the shipped schema is valid', async () => {
    const r = await lua.doString(`
      local out = Nxc.ConfigSchema.validate()
      if out.ok then return { ok = true } end
      local first = out.error.details.fields[1]
      return { ok = false, field = first.field, reason = first.reason }
    `);
    assert.equal(r.ok, true, `schema invalid: ${r.field} ${r.reason}`);
  });

  test('every field declares all fourteen required properties', async () => {
    const r = await lua.doString(`
      local required = {
        'key', 'type', 'description', 'default', 'validation', 'scope', 'clientVisible',
        'editCapability', 'auditClassification', 'sensitive', 'reloadBehavior',
        'migrationBehavior', 'rollbackBehavior', 'changeEvent',
      }
      local missing = 0
      for _, f in ipairs(Nxc.ConfigSchema.FIELDS) do
        for _, p in ipairs(required) do
          if f[p] == nil then missing = missing + 1 end
        end
      end
      return { count = #Nxc.ConfigSchema.FIELDS, missing = missing }
    `);
    assert.ok(r.count >= 7);
    assert.equal(r.missing, 0);
  });

  test('validation catches a field missing a property', async () => {
    const r = await lua.doString(`
      local saved = Nxc.ConfigSchema.FIELDS
      Nxc.ConfigSchema.FIELDS = { { key = 'nxc_lib.a.b', type = 'string' } }
      local out = Nxc.ConfigSchema.validate()
      Nxc.ConfigSchema.FIELDS = saved
      return { ok = out.ok, count = #out.error.details.fields }
    `);
    assert.equal(r.ok, false);
    assert.ok(r.count > 1, 'every missing property is reported, not just the first');
  });

  test('validation rejects an unknown reload behavior', async () => {
    const r = await lua.doString(`
      local saved = Nxc.ConfigSchema.FIELDS
      local f = {}
      for k, v in pairs(saved[1]) do f[k] = v end
      f.reloadBehavior = 'Whenever'
      Nxc.ConfigSchema.FIELDS = { f }
      local out = Nxc.ConfigSchema.validate()
      Nxc.ConfigSchema.FIELDS = saved
      return { ok = out.ok, reason = out.error.details.fields[1].reason }
    `);
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown reload behavior/);
  });

  test('a sensitive field cannot be client-visible', async () => {
    const r = await lua.doString(`
      local saved = Nxc.ConfigSchema.FIELDS
      local f = {}
      for k, v in pairs(saved[1]) do f[k] = v end
      f.sensitive = true
      f.clientVisible = true
      Nxc.ConfigSchema.FIELDS = { f }
      local out = Nxc.ConfigSchema.validate()
      Nxc.ConfigSchema.FIELDS = saved
      return { ok = out.ok, reason = out.error.details.fields[1].reason }
    `);
    assert.equal(r.ok, false, 'scope resolution must never expose a sensitive value');
    assert.match(r.reason, /sensitive field cannot be client-visible/);
  });

  test('defaults are available before registration completes', async () => {
    const r = await lua.doString(`
      local d = Nxc.ConfigSchema.defaults()
      return {
        level = d['nxc_lib.logging.level'],
        timeout = d['nxc_lib.rpc.defaultTimeoutMs'],
        envelope = d['nxc_lib.rpc.maxEnvelopeBytes'],
      }
    `);
    assert.equal(r.level, 'info');
    assert.equal(r.timeout, 10000);
    assert.equal(r.envelope, 32768, 'matches Envelope.MAX_BYTES');
  });

  test('the declared envelope ceiling matches the code default', async () => {
    const r = await lua.doString(`
      return Nxc.ConfigSchema.defaults()['nxc_lib.rpc.maxEnvelopeBytes'] == Nxc.Envelope.MAX_BYTES
    `);
    assert.equal(r, true, 'a schema default that disagrees with the code is a silent trap');
  });

  test('registration passes the resource name and fields to the registrar', async () => {
    const r = await lua.doString(`
      local seen = {}
      local out = Nxc.ConfigSchema.register(function(resource, fields)
        seen.resource = resource
        seen.count = #fields
        return true
      end)
      return { ok = out.ok, resource = seen.resource, count = seen.count }
    `);
    assert.equal(r.ok, true);
    assert.equal(r.resource, 'nxc_lib');
    assert.ok(r.count >= 7);
  });

  test('a refused registration is a failure, not a silent success', async () => {
    const r = await lua.doString(`
      local out = Nxc.ConfigSchema.register(function() return false end)
      return { ok = out.ok, code = out.error.code }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_INTERNAL');
  });

  test('a throwing registrar is caught rather than propagating', async () => {
    const r = await lua.doString(`
      local out = Nxc.ConfigSchema.register(function() error('nxc_config exploded') end)
      return { ok = out.ok, reason = out.error.details.reason }
    `);
    assert.equal(r.ok, false);
    assert.match(r.reason, /exploded/);
  });

  test('every key follows the resource.group.key convention', async () => {
    const r = await lua.doString(`
      local bad = {}
      for _, f in ipairs(Nxc.ConfigSchema.FIELDS) do
        if not f.key:match('^nxc_lib%.[%a][%w]*%.[%a][%w]*$') then
          bad[#bad + 1] = f.key
        end
      end
      return { count = #bad, first = bad[1] }
    `);
    assert.equal(r.count, 0, `bad key: ${r.first}`);
  });
});
