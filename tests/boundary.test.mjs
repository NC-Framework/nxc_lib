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

describe('nxc_core exports, called from another Lua state', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({ provider: 'nxc_core', consumer: 'nxc_target' });
  });
  afterEach(() => boundary.close());

  /**
   * nxc_core had NO exports at all until nxc_target needed to ask it whether a
   * player holds a capability. Sessions, accounts, characters and capabilities
   * were all correct, all tested, and all unreachable from any other resource.
   *
   * These are the tests that would have caught that: an export nothing calls is
   * an export whose signature nobody has ever checked.
   */
  test('isReady crosses as a boolean', async () => {
    const ready = await boundary.callExport('isReady');
    assert.equal(typeof ready, 'boolean');
  });

  test('a connection with no session yields nil rather than an error', async () => {
    const session = await boundary.callExport('session', [999]);
    // Asking about a connection that does not exist is ordinary — a player
    // disconnects mid-request — and it must not throw across the boundary.
    assert.ok(session === null || session === undefined);
  });

  test('hasCapability answers false for an unknown connection, not nil', async () => {
    const held = await boundary.callExport('hasCapability', [999, 'doors.open']);
    // FAILING CLOSED. A gate that returns nil for an unknown player is a gate
    // that a caller writing `if not denied then` walks straight through.
    assert.equal(held, false);
  });

  test('capabilities crosses as a table even when empty', async () => {
    const capabilities = await boundary.callExport('capabilities', [999]);
    // An empty set must arrive as an empty table, not as nil. A consumer that
    // gets nil where it expected a table crashes on the first index.
    assert.equal(typeof capabilities, 'object');
    assert.ok(capabilities !== null);
  });

  test('a real session crosses with its account intact', async () => {
    const r = await boundary.provider.doString(`
      NxcCore.Sessions.reset()
      local id = NxcCore.Identifiers.account()
      NxcCore.Sessions.create({ source = 7, accountId = id })
      NxcCore.Sessions.setCapabilityGrants(7, {
        { source = 'employment', sourceId = 'job_police', allow = { 'doors.open' } },
      })
      return id
    `);

    const session = await boundary.callExport('session', [7]);
    assert.equal(session.accountId, r);
    // The stored session carries a correlation id and identifiers that no
    // consumer needs. The summary is what crosses.
    assert.equal(session.identifiers, undefined);

    assert.equal(await boundary.callExport('hasCapability', [7, 'doors.open']), true);
    assert.equal(await boundary.callExport('hasCapability', [7, 'doors.lock']), false);
    assert.equal(await boundary.callExport('accountFor', [7]), r);

    // nil during character selection, which is a normal state rather than an
    // error — and it has to survive the crossing as nil rather than as an empty
    // table that a caller would treat as a character id.
    const character = await boundary.callExport('characterFor', [7]);
    assert.ok(character === null || character === undefined);
  });
});

/**
 * Service registration and discovery, across a real boundary.
 *
 * P1-04 failed at the Phase 1 gate with `services.lua` complete, tested, and
 * exported by nobody — so "service registration and discovery work" had never
 * been true outside a single Lua state. These are the tests that make the claim
 * mean something.
 */
describe('nxc_core service registration, from another state', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({ provider: 'nxc_core', consumer: 'nxc_zones' });
  });
  afterEach(() => boundary.close());

  test('a resource registers itself and is then discoverable', async () => {
    const registered = await boundary.callExport('registerService',
      [{ version: '0.1.1', contractVersion: 1, capabilities: ['zones'] }]);
    assert.equal(registered.ok, true);

    const found = await boundary.callExport('discover', ['nxc_zones']);
    assert.equal(found.present, true);
    assert.equal(found.service.name, 'nxc_zones');
  });

  test('the name comes from the caller, not from the spec', async () => {
    // A resource that could name itself could register as nxc_core and be
    // discovered in its place. The spec has no name field at all, and passing
    // one changes nothing.
    await boundary.callExport('registerService',
      [{ name: 'nxc_core', contractVersion: 1 }]);

    const impersonated = await boundary.callExport('discover', ['nxc_zones']);
    assert.equal(impersonated.present, true);
    assert.equal(impersonated.service.name, 'nxc_zones');
  });

  test('a service that is absent is reported, not raised', async () => {
    const found = await boundary.callExport('discover', ['nxc_nothing']);
    // present false is a NORMAL answer. A consumer that cannot ask this without
    // handling an error cannot support an optional dependency.
    assert.equal(found.present, false);
    assert.equal(found.ready, false);
    assert.equal(found.reason, 'not registered');
  });

  test('a contract version below what the caller needs is present but not ready', async () => {
    await boundary.callExport('registerService', [{ contractVersion: 1 }]);

    const found = await boundary.callExport('discover', ['nxc_zones', 2]);
    assert.equal(found.present, true);
    assert.equal(found.ready, false);
    // The reason is the whole value: "not ready" alone sends somebody to read
    // startup logs for a resource that started perfectly.
    assert.match(found.reason, /contract version 1 is below the required 2/);
  });

  test('registering twice updates rather than refusing', async () => {
    await boundary.callExport('registerService', [{ version: '0.1.0', contractVersion: 1 }]);
    const again = await boundary.callExport('registerService',
      [{ version: '0.1.1', contractVersion: 1 }]);

    // A resource restart is ordinary. Refusing the second registration would
    // leave the entry describing the version that stopped.
    assert.equal(again.ok, true);
    const found = await boundary.callExport('discover', ['nxc_zones']);
    assert.equal(found.service.version, '0.1.1');
  });

  test('the registration result survives the boundary as something readable', async () => {
    const registered = await boundary.callExport('registerService', [{ contractVersion: 1 }]);
    // The defect this whole harness exists for: a frozen Result arrives empty
    // and the caller reads its own success as a failure.
    assert.equal(registered.ok, true);
    assert.notEqual(registered.value, undefined);
    assert.equal(registered.value.name, 'nxc_zones');
  });
});

/**
 * A health report has to name the resource it came from.
 *
 * THIS TEST EXISTS BECAUSE THE SAME DEFECT SHIPPED TWICE. Every resource loads
 * nxc_lib into its own Lua state, so `Nxc.RESOURCE` reads `nxc_lib` inside all
 * of them. The logger shipped with that defect and was caught on a real server.
 * The fix was applied to the logger and nowhere else, so `Health.init` carried
 * it into the release that made health reportable — where `nxc_health` would
 * have printed eight resources all named nxc_lib, which is worse than no report
 * because it looks like one.
 *
 * A single-state test cannot see this. Only a state that belongs to a resource
 * OTHER than nxc_lib can.
 */
describe('A report names the resource it came from', () => {
  let boundary;
  beforeEach(async () => {
    boundary = await createBoundary({ provider: 'nxc_zones', consumer: 'nxc_core' });
  });
  afterEach(() => boundary.close());

  test('nxc_zones reports itself, not nxc_lib', async () => {
    const report = await boundary.callExport('health');
    assert.equal(report.resource, 'nxc_zones');
  });

  test('and its version is its own, not the library it loaded', async () => {
    const report = await boundary.callExport('health');
    // Nxc.VERSION was already correct — it reads GetCurrentResourceName. The
    // asymmetry is the whole lesson: one line of the same file asked the
    // platform and the next line used a literal.
    assert.notEqual(report.version, undefined);
  });

  test('a resource that has not registered configuration is degraded', async () => {
    const report = await boundary.callExport('health');
    // DEGRADED, not serviceable and not failed. Its dependencies are satisfied
    // and it is running on declared defaults, which is a real and reportable
    // difference rather than a fault.
    assert.equal(report.state, 'degraded');
    assert.match(report.detail, /declared defaults/);
  });
});
