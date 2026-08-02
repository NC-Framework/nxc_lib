import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Health', () => {
  test('starts in starting and reaches serviceable', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test', version = '0.1.0' })
      local before = Nxc.Health.evaluate()
      Nxc.Health.setConfigurationRegistered(true)
      local after = Nxc.Health.evaluate()
      return { before = before, after = after }
    `);
    assert.equal(r.before, 'degraded', 'unregistered configuration is degraded, not serviceable');
    assert.equal(r.after, 'serviceable');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('a missing required dependency holds the resource in starting', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test', dependencies = { 'nxc_lib' } })
      Nxc.Health.setConfigurationRegistered(true)
      local blocked = Nxc.Health.evaluate()
      Nxc.Health.setDependency('nxc_lib', true)
      return { blocked = blocked, ready = Nxc.Health.evaluate() }
    `);
    assert.equal(r.blocked, 'starting');
    assert.equal(r.ready, 'serviceable');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('a missing optional dependency is degraded, not failed', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test' })
      Nxc.Health.dependency('nxc_properties', true)
      Nxc.Health.setConfigurationRegistered(true)
      return { state = Nxc.Health.evaluate(), detail = Nxc.Health.report().detail }
    `);
    assert.equal(r.state, 'degraded', 'a later-phase dependency being absent is correct behaviour');
    assert.match(r.detail, /optional dependency absent/);
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('fail is terminal until re-initialised', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test' })
      Nxc.Health.setConfigurationRegistered(true)
      Nxc.Health.fail('bootstrap validation failed: no database connection')
      local failed = Nxc.Health.evaluate()
      local detail = Nxc.Health.report().detail
      Nxc.Health.init({ resource = 'nxc_test' })
      return { failed = failed, detail = detail, afterInit = Nxc.Health.evaluate() }
    `);
    assert.equal(r.failed, 'failed');
    assert.match(r.detail, /bootstrap validation/);
    assert.notEqual(r.afterInit, 'failed');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('the report lists dependencies deterministically', async () => {
    await withFrozenClock(lua);
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test', dependencies = { 'zeta', 'alpha' } })
      local rep = Nxc.Health.report()
      return { first = rep.dependencies[1].name, second = rep.dependencies[2].name }
    `);
    assert.equal(r.first, 'alpha');
    assert.equal(r.second, 'zeta');
    await lua.doString(`Nxc.Time.resetClock()`);
  });

  test('setting an unknown dependency is rejected', async () => {
    const r = await lua.doString(`
      Nxc.Health.init({ resource = 'nxc_test' })
      return not pcall(function() Nxc.Health.setDependency('nope', true) end)
    `);
    assert.equal(r, true);
  });
});
