import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Permissions', () => {
  test('denies when no resolver is installed', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({
        name = 'police.evidence.view', description = 'View evidence records.',
        risk = 'high',
      })
      return Nxc.Permissions.has({}, 'police.evidence.view')
    `);
    assert.equal(r, false, 'a permission system that fails open is worse than none');
  });

  test('denies an unregistered capability even when the resolver allows it', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.setResolver(function() return true end)
      return Nxc.Permissions.has({}, 'made.up.capability')
    `);
    assert.equal(r, false, 'a typo must not become an open door');
  });

  test('allows a registered capability the resolver grants', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({
        name = 'business.accounts.withdraw', description = 'Withdraw business funds.',
        risk = 'high',
      })
      Nxc.Permissions.setResolver(function(actor, cap)
        return cap == 'business.accounts.withdraw'
      end)
      return {
        granted = Nxc.Permissions.has({}, 'business.accounts.withdraw'),
      }
    `);
    assert.equal(r.granted, true);
  });

  test('a throwing resolver denies rather than propagating', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({ name = 'a.b.c', description = 'x', risk = 'low' })
      Nxc.Permissions.setResolver(function() error('resolver exploded') end)
      return Nxc.Permissions.has({}, 'a.b.c')
    `);
    assert.equal(r, false);
  });

  test('require returns a structured forbidden error', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({ name = 'a.b.c', description = 'x', risk = 'low' })
      local out = Nxc.Permissions.require({}, 'a.b.c', 'c-0000000000000001')
      return { ok = out.ok, code = out.error.code, capability = out.error.details.capability }
    `);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NXC_LIB_FORBIDDEN');
    assert.equal(r.capability, 'a.b.c');
  });

  test('a malformed capability name is rejected at registration', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      return {
        tooFew = not pcall(function()
          Nxc.Permissions.register({ name = 'police.evidence', description = 'x', risk = 'low' }) end),
        uppercase = not pcall(function()
          Nxc.Permissions.register({ name = 'Police.Evidence.View', description = 'x', risk = 'low' }) end),
      }
    `);
    assert.equal(r.tooFew, true);
    assert.equal(r.uppercase, true);
  });

  test('a capability requires a description and a risk classification', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      return {
        noDescription = not pcall(function()
          Nxc.Permissions.register({ name = 'a.b.c', description = '', risk = 'low' }) end),
        noRisk = not pcall(function()
          Nxc.Permissions.register({ name = 'a.b.c', description = 'x' }) end),
      }
    `);
    assert.equal(r.noDescription, true);
    assert.equal(r.noRisk, true);
  });

  test('a critical capability is always audited', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({
        name = 'police.evidence.destroy', description = 'Destroy evidence.',
        risk = 'critical', audited = false,
      })
      return Nxc.Permissions.get('police.evidence.destroy').audited
    `);
    assert.equal(r, true, 'opting out would make the classification meaningless');
  });

  test('duplicate registration is rejected', async () => {
    const r = await lua.doString(`
      Nxc.Permissions.reset()
      Nxc.Permissions.register({ name = 'a.b.c', description = 'x', risk = 'low' })
      return not pcall(function()
        Nxc.Permissions.register({ name = 'a.b.c', description = 'y', risk = 'low' }) end)
    `);
    assert.equal(r, true);
  });
});
