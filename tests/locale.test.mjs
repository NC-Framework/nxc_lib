import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
before(async () => { lua = await createEngine(); });
after(() => lua.global.close());

describe('Locale', () => {
  test('resolves a loaded key', async () => {
    const r = await lua.doString(`
      Nxc.Locale.reset()
      Nxc.Locale.load('en', { ['banking.error.insufficientFunds'] = 'You do not have enough money.' })
      return Nxc.Locale.get('banking.error.insufficientFunds')
    `);
    assert.equal(r, 'You do not have enough money.');
  });

  test('interpolates values rather than concatenating', async () => {
    const r = await lua.doString(`
      Nxc.Locale.reset()
      Nxc.Locale.load('en', { ['banking.shortfall'] = 'You need {amount} more.' })
      return Nxc.Locale.get('banking.shortfall', { amount = '$42.00' })
    `);
    assert.equal(r, 'You need $42.00 more.');
  });

  test('falls back to the default locale', async () => {
    const r = await lua.doString(`
      Nxc.Locale.reset()
      Nxc.Locale.load('en', { ['a.b'] = 'English' })
      Nxc.Locale.set('fr')
      return Nxc.Locale.get('a.b')
    `);
    assert.equal(r, 'English');
  });

  test('a missing key never renders a raw key or an empty string', async () => {
    const r = await lua.doString(`
      Nxc.Locale.reset()
      local text = Nxc.Locale.get('shops.purchase.confirmOrder')
      return { text = text, missing = #Nxc.Locale.missingKeys() }
    `);
    assert.notEqual(r.text, '');
    assert.notEqual(r.text, 'shops.purchase.confirmOrder');
    assert.equal(r.text, 'Confirm Order');
    assert.equal(r.missing, 1, 'the gap is recorded so it is found before players do');
  });

  test('an unknown placeholder is left visible rather than blanked', async () => {
    const r = await lua.doString(`
      Nxc.Locale.reset()
      Nxc.Locale.load('en', { ['a.b'] = 'Hello {name}.' })
      return Nxc.Locale.get('a.b', {})
    `);
    assert.equal(r, 'Hello {name}.');
  });
});
