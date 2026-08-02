import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => {
  lua = await createEngine();
  await withFrozenClock(lua, 1700000000000);
});
afterEach(() => lua.global.close());

// Capture records instead of printing them, so assertions see the structure
// rather than a formatted line.
beforeEach(async () => {
  await lua.doString(`
    __records = {}
    Nxc.Logger.setLevel('debug')
    Nxc.Logger.setEnvironment('test')
    Nxc.Logger.setSink(function(record) __records[#__records + 1] = record end)
  `);
});

describe('Logger', () => {
  test('a record carries the required structured fields', async () => {
    const r = await lua.doString(`
      Nxc.Logger.info('shop.purchase.completed', { itemId = 'water' }, {
        correlationId = 'c-0000000000000001',
        actorCharacter = 'chr_1',
        result = 'success',
        duration = 42,
      })
      local rec = __records[1]
      return {
        severity = rec.severity, action = rec.action, environment = rec.environment,
        resource = rec.resource, version = rec.version,
        correlationId = rec.correlationId, result = rec.result, duration = rec.duration,
        itemId = rec.context.itemId, hasTimestamp = rec.timestamp ~= nil,
      }
    `);
    assert.equal(r.severity, 'info');
    assert.equal(r.action, 'shop.purchase.completed');
    assert.equal(r.environment, 'test');
    assert.equal(r.resource, 'nxc_lib');
    assert.equal(r.correlationId, 'c-0000000000000001');
    assert.equal(r.result, 'success');
    assert.equal(r.duration, 42);
    assert.equal(r.itemId, 'water');
    assert.equal(r.hasTimestamp, true);
  });

  test('secrets are redacted at the call site, not downstream', async () => {
    const r = await lua.doString(`
      Nxc.Logger.info('webhook.delivered', {
        endpointHost = 'discord.com',
        webhook = 'https://discord.com/api/webhooks/1/supersecret',
        token = 'abc123',
      })
      local ctx = __records[1].context
      return { host = ctx.endpointHost, webhook = ctx.webhook, token = ctx.token }
    `);
    assert.equal(r.host, 'discord.com', 'safe fields survive');
    assert.equal(r.webhook, '[redacted]');
    assert.equal(r.token, '[redacted]');
  });

  test('records below the configured level are dropped', async () => {
    const count = await lua.doString(`
      Nxc.Logger.setLevel('warn')
      Nxc.Logger.debug('a')
      Nxc.Logger.info('b')
      Nxc.Logger.warn('c')
      Nxc.Logger.error('d')
      return #__records
    `);
    assert.equal(count, 2, 'debug is disabled in production');
  });

  test('a failing sink does not take the caller down', async () => {
    const r = await lua.doString(`
      Nxc.Logger.setSink(function() error('sink exploded') end)
      local ok = pcall(function() Nxc.Logger.info('still.fine') end)
      return ok
    `);
    assert.equal(r, true, 'a log failure degrades diagnosis; it does not fail the operation');
  });

  test('forContext binds the correlation id so call sites cannot forget it', async () => {
    const r = await lua.doString(`
      local log = Nxc.Logger.forContext({
        resource = 'nxc_banking', correlationId = 'c-000000000000000a',
      })
      log.warn('transfer.denied', { reason = 'insufficient' })
      local rec = __records[1]
      return { resource = rec.resource, correlationId = rec.correlationId, severity = rec.severity }
    `);
    assert.equal(r.resource, 'nxc_banking');
    assert.equal(r.correlationId, 'c-000000000000000a');
    assert.equal(r.severity, 'warn');
  });

  test('an unknown level is rejected', async () => {
    const threw = await lua.doString(`
      return not pcall(function() Nxc.Logger.setLevel('verbose') end)
    `);
    assert.equal(threw, true);
  });

  test('a permission denial is a warning, not an error', async () => {
    // The system working as designed. A pattern of denials is the security
    // signal, which is why it is logged at all.
    const r = await lua.doString(`
      Nxc.Logger.warn('permission.denied', { capability = 'police.evidence.destroy' })
      return __records[1].severity
    `);
    assert.equal(r, 'warn');
  });

  test('a resource names itself, because the default is wrong everywhere but here', async () => {
    const r = await lua.doString(`
      local seen = {}
      Nxc.Logger.setSink(function(record) seen[#seen + 1] = record.resource end)

      Nxc.Logger.info('before', {})
      Nxc.Logger.setResource('nxc_core')
      Nxc.Logger.info('after', {})

      return { before = seen[1], after = seen[2] }
    `);
    // Every resource loads nxc_lib into its OWN Lua state, so Nxc.RESOURCE reads
    // nxc_lib inside nxc_core. Without setResource, every line in the system
    // claims one origin.
    assert.equal(r.before, 'nxc_lib');
    assert.equal(r.after, 'nxc_core');
  });

  test('setResource refuses a name that is not one', async () => {
    const r = await lua.doString(`
      local a = pcall(Nxc.Logger.setResource, '')
      local b = pcall(Nxc.Logger.setResource, nil)
      return { empty = a, missing = b }
    `);
    assert.equal(r.empty, false);
    assert.equal(r.missing, false);
  });

  test('an explicit resource on the call still wins', async () => {
    const r = await lua.doString(`
      local seen
      Nxc.Logger.setSink(function(record) seen = record.resource end)
      Nxc.Logger.setResource('nxc_core')
      Nxc.Logger.info('act', {}, { resource = 'nxc_banking' })
      return seen
    `);
    assert.equal(r, 'nxc_banking');
  });
});
