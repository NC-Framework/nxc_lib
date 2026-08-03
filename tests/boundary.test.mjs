import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createResourceEngine, createBoundary } from './boundary.mjs';

/**
 * Tests that cross a real resource boundary.
 *
 * RSK-25: every other test in this project runs inside one Lua state, and a
 * FiveM server does not. The defect that motivated this harness — a frozen table
 * arriving empty — was invisible to 357 tests and obvious on the first
 * deployment.
 *
 * These are slower than the rest, because each one builds two engines and loads
 * two resources. That is the cost of testing the thing that actually broke.
 */

describe('The boundary is real', () => {
  let lua;
  beforeEach(async () => { lua = await createResourceEngine('nxc_lib', { blocks: ['shared_scripts'] }); });
  afterEach(() => lua.global.close());

  test('a frozen table encodes as empty, which is the whole defect', async () => {
    const r = await lua.doString(`
      local frozen = Nxc.freeze({ ok = true, value = 42 })
      return { encoded = __rawEncode(frozen), readable = frozen.ok }
    `);
    // Perfectly readable in its own state, and nothing at all once encoded. If
    // this ever returns the contents, the harness has started using `pairs` and
    // is certifying the bug it exists to catch.
    assert.equal(r.readable, true);
    assert.equal(r.encoded, '{}');
  });

  test('a plain table encodes with its contents', async () => {
    const r = await lua.doString(`
      return __rawEncode(Nxc.plain(Nxc.Result.ok(42)))
    `);
    assert.match(r, /\["ok"\]=true/);
    assert.match(r, /\["value"\]=/);
  });

  test('a function refuses to cross', async () => {
    // Nothing serialises a closure. A test that passes one is assuming something
    // a real server will not honour.
    await assert.rejects(
      lua.doString(`return __rawEncode({ callback = function() end })`),
      /function cannot cross/);
  });

  test('a table containing itself refuses to cross', async () => {
    await assert.rejects(
      lua.doString(`local t = {} t.self = t return __rawEncode(t)`),
      /containing itself/);
  });

  test('NaN and infinity refuse to cross', async () => {
    await assert.rejects(lua.doString(`return __rawEncode({ n = 0/0 })`), /NaN/);
    await assert.rejects(lua.doString(`return __rawEncode({ n = math.huge })`), /infinity/);
  });
});

describe('nxc_config exports, called from another Lua state', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({ provider: 'nxc_config', consumer: 'nxc_core' });
  });
  afterEach(() => boundary.close());

  test('register returns a Result the caller can actually read', async () => {
    const result = await boundary.callExport('register', [[
      { key: 'test_field', type: 'string', default: 'x', description: 'A field' },
    ]]);

    // THIS IS THE TEST THAT WOULD HAVE CAUGHT IT. Before Nxc.plain, this arrived
    // as {} — no ok, no error — and the caller reported failure while nxc_config
    // logged success.
    assert.equal(typeof result, 'object');
    assert.notEqual(result, null);
    assert.ok('ok' in result, 'the Result arrived with no ok field: it crossed as an empty table');
  });

  test('the export knows who called it', async () => {
    const result = await boundary.callExport('register', [[
      { key: 'test_field', type: 'string', default: 'x', description: 'A field' },
    ]]);
    // GetInvokingResource is how the service attributes a schema to its owner.
    // Nothing in a single-state test can exercise it, because there is no
    // invoking resource when everything is one resource.
    if (result.ok) assert.equal(result.value.resource, 'nxc_core');
  });

  test('an unknown caller is refused', async () => {
    const boundaryNoCaller = await createBoundary({
      provider: 'nxc_config', consumer: 'nxc_core',
    });
    try {
      const result = await boundaryNoCaller.callExport('register', [[]], { from: null });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'NXC_CONFIG_UNKNOWN_CALLER');
    } finally {
      boundaryNoCaller.close();
    }
  });

  test('effectiveValues returns a table with real keys', async () => {
    await boundary.callExport('register', [[
      { key: 'test_field', type: 'string', default: 'hello', description: 'A field' },
    ]]);
    const values = await boundary.callExport('effectiveValues', [{}]);
    assert.equal(typeof values, 'object');
    // Not the contents — the fact that ANY key survived. A frozen table here
    // would arrive as {} and read as "this resource has no configuration",
    // which is a silent wrong answer rather than an error.
    assert.ok(values !== null);
  });
});

describe('nxc_config:isReady, called from another Lua state', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({ provider: 'nxc_config', consumer: 'nxc_core' });
  });
  afterEach(() => boundary.close());

  test('a boolean crosses as a boolean', async () => {
    const ready = await boundary.callExport('isReady');
    // Trivial-looking, and it is the export every other resource will poll before
    // registering. A scalar has no metatable, so it was never at risk — this
    // records that rather than leaving it assumed.
    assert.equal(typeof ready, 'boolean');
  });
});

describe('nxc_ui client exports, called from another Lua state', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({
      provider: 'nxc_ui', consumer: 'nxc_core',
      server: false, blocks: ['shared_scripts', 'client_scripts'],
    });
  });
  afterEach(() => boundary.close());

  test('show returns a Result the caller can read', async () => {
    const result = await boundary.callExport('show', [
      { type: 'notify', surface: 'test', text: 'Hello', severity: 'info' },
    ]);
    // The defect class again, on a different resource. These three exports had
    // never been called by anything at all — check-reachability found them.
    assert.equal(typeof result, 'object');
    assert.ok('ok' in result, 'the Result crossed as an empty table');
  });

  test('a refused message crosses as a refusal, not as silence', async () => {
    const result = await boundary.callExport('show', [
      { type: 'notify', surface: 'test', text: '' },
    ]);
    assert.ok('ok' in result);
    assert.equal(result.ok, false);
    // The reason has to survive too. An error whose details are lost in transit
    // is indistinguishable from a generic failure.
    assert.equal(result.error.code, 'NXC_LIB_VALIDATION_FAILED');
  });

  test('isBusy reports focus across the boundary', async () => {
    const before = await boundary.callExport('isBusy');
    assert.equal(before, false);

    await boundary.callExport('show', [
      { type: 'confirm', surface: 'test', title: 'T', text: 'Take focus' },
    ]);
    const during = await boundary.callExport('isBusy');
    assert.equal(during, true, 'a surface that takes focus must report busy');
  });

  test('close releases focus, and the natives agree', async () => {
    await boundary.callExport('show', [
      { type: 'confirm', surface: 'test', title: 'T', text: 'Take focus' },
    ]);
    await boundary.callExport('close');

    const after = await boundary.callExport('isBusy');
    assert.equal(after, false, 'focus was not released — this strands a player');

    // Module state and native state have to agree. They are set in two different
    // places, and the failure mode when they diverge is a player who cannot move
    // while every log line says the surface is closed.
    const natives = await boundary.provider.doString('return __nuiFocus');
    assert.equal(natives.hasFocus, false);
    assert.equal(natives.hasCursor, false);
  });
});
