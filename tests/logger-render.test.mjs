import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, withFrozenClock } from './harness.mjs';

let lua;
beforeEach(async () => {
  lua = await createEngine();
  await withFrozenClock(lua, 1700000000000);
});
afterEach(() => lua.global.close());

// SEPARATE FILE ON PURPOSE. logger.test.mjs replaces the sink for every test it
// runs, which is right for asserting on record structure and removes the very
// thing under test here: the default sink is what renders the line an operator
// reads.

/**
 * The default sink renders context tables into the line an operator reads.
 *
 * These use the DEFAULT sink — the one every resource ships with — by capturing
 * `print` rather than replacing the sink, because the rendering is the thing
 * under test and replacing the sink removes it.
 */
describe('The rendered line distinguishes nothing from something', () => {
  test('an empty list renders as [], not as {...}', async () => {
    const r = await lua.doString(`
      local line
      local realPrint = print
      print = function(text) line = text end
      Nxc.Logger.info('config.registered', { fields = 7, removedKeys = {} })
      print = realPrint
      return line
    `);
    // `{...}` reads as "there is something here I am not showing you". A real
    // deployment logged removedKeys={...} on a FIRST registration, where nothing
    // had been removed — anyone reading it would conclude fields had vanished
    // from the schema.
    assert.match(r, /removedKeys=\[\]/);
    assert.doesNotMatch(r, /\{\.\.\.\}/);
  });

  test('a list renders its items', async () => {
    const r = await lua.doString(`
      local line
      local realPrint = print
      print = function(text) line = text end
      Nxc.Logger.info('config.registered', { removedKeys = { 'a', 'b' } })
      print = realPrint
      return line
    `);
    assert.match(r, /removedKeys=\[a,b\]/);
  });

  test('a map renders its keys, sorted, and not its values', async () => {
    const r = await lua.doString(`
      local line
      local realPrint = print
      print = function(text) line = text end
      Nxc.Logger.info('act', { changed = { zebra = 'secret', alpha = 'secret' } })
      print = realPrint
      return line
    `);
    // The keys are the useful part. The values may be anything at all, including
    // something that has no business in a log line.
    assert.match(r, /changed=\{alpha,zebra\}/);
    assert.doesNotMatch(r, /secret/);
  });
});
