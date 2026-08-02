import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => { lua = await createEngine(); });
afterEach(() => lua.global.close());

describe('Correlation', () => {
  test('generated ids are well formed', async () => {
    const id = await lua.doString(`return Nxc.Correlation.new()`);
    assert.match(id, /^c-[0-9a-f]{16}$/);
  });

  test('ids do not collide across rapid generation', async () => {
    const ids = await lua.doString(`
      local seen, out = {}, {}
      for i = 1, 500 do
        local id = Nxc.Correlation.new()
        if seen[id] then return { duplicate = id } end
        seen[id] = true
      end
      return { duplicate = false }
    `);
    assert.equal(ids.duplicate, false, 'a counter guarantees uniqueness within a tick');
  });

  test('a child id keeps the parent so a search finds the whole tree', async () => {
    const r = await lua.doString(`
      local parent = Nxc.Correlation.new()
      local child = Nxc.Correlation.child(parent, 1)
      return {
        parent = parent, child = child,
        root = Nxc.Correlation.root(child),
        valid = Nxc.Correlation.isValid(child),
      }
    `);
    assert.ok(r.child.startsWith(r.parent));
    assert.equal(r.root, r.parent);
    assert.equal(r.valid, true);
  });

  test('malformed ids are rejected', async () => {
    const r = await lua.doString(`
      return {
        empty = Nxc.Correlation.isValid(''),
        wrongPrefix = Nxc.Correlation.isValid('x-0000000000000001'),
        tooShort = Nxc.Correlation.isValid('c-0001'),
        notString = Nxc.Correlation.isValid(12345),
        tooLong = Nxc.Correlation.isValid('c-' .. string.rep('a', 200)),
        injection = Nxc.Correlation.isValid("c-0000000000000001'; DROP TABLE"),
      }
    `);
    for (const [k, v] of Object.entries(r)) {
      assert.equal(v, false, `${k} must be rejected`);
    }
  });

  test('coerce keeps a valid id and replaces an invalid one', async () => {
    const r = await lua.doString(`
      local good = Nxc.Correlation.new()
      return {
        kept = Nxc.Correlation.coerce(good) == good,
        replaced = Nxc.Correlation.isValid(Nxc.Correlation.coerce('<script>')),
      }
    `);
    assert.equal(r.kept, true);
    assert.equal(r.replaced, true, 'a malformed id must never reach an audit record');
  });

  test('child rejects an invalid parent', async () => {
    const threw = await lua.doString(`
      return not pcall(function() return Nxc.Correlation.child('nonsense') end)
    `);
    assert.equal(threw, true);
  });
});
