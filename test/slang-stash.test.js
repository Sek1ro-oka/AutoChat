// Where a corrupt-import stash lands, and how many of them are kept.
//
// The stash holds the raw bytes an operator tried to import — which can include
// verbatim group messages — so two things matter here and nothing else does:
// it must sit somewhere the ACL sweep actually covers, and it must not grow
// without a bound. `test/slang.test.js` keeps the existing behaviour (an explicit
// directory is still honoured) under test; this file covers the default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { MAX_CORRUPT_STASHES, Slang } from '../src/social/slang.js';

const makeConfig = overrides => ({
  botId: '10000', groupId: '20000', groupIds: ['20000'],
  slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
  slangAutoExtract: false, slangExtractIntervalHours: 12,
  webSearchEnabled: false, searchDailyLimit: 50, searchInputReserve: 64000,
  budgetMicro: 1000000, maxOutput: 1024, inputPrice: 2, outputPrice: 8,
  cacheHitPrice: null, offPeakRatio: 0.5, costHolidays: [], systemPrompt: '内置人设',
  clearMs: 72 * 3600000,
  ...overrides,
});

const joinConfig = root => makeConfig({ databasePath: join(root, 'data', 'autochat.sqlite') });
// One millisecond per call: the stamp has millisecond resolution, so a fixed
// clock would make consecutive stashes collide on one file name and the cap
// would never be exercised. It starts in 2027 so a stash can never be mistaken
// for a real one; the expected names are derived, never hard-coded, because
// `toISOString()` prints UTC and the local day is not part of the contract.
const CLOCK_START = 1800000000000;
const tickingClock = step => { const clock = { value: CLOCK_START }; return () => (clock.value += step); };
const stampOf = ms => new Date(ms).toISOString().replace(/[:.]/g, '-');

const withTemp = (body) => {
  const root = mkdtempSync(join(tmpdir(), 'autochat-slang-stash-'));
  try { return body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('without an explicit directory a corrupt import is stashed under the data directory', () => {
  withTemp((root) => {
    const store = new Store();
    const slang = new Slang({ config: joinConfig(root), store, log: () => {}, now: tickingClock(1000) });
    // `data/` carries the startup ACL hardening *and* the gitignore entry;
    // `runtime/` carries neither, and is deliberately never walked by icacls.
    assert.equal(slang.corruptDirectory, join(root, 'data', 'slang-corrupt'));

    assert.throws(() => slang.importAll('{ 这不是 JSON'), /SLANG_IMPORT_INVALID/);
    const names = readdirSync(join(root, 'data', 'slang-corrupt'));
    assert.equal(names.length, 1, 'the unreadable import is kept, not dropped');
    assert.match(names[0], /^slang-corrupt-.*\.json$/);
    assert.equal(readFileSync(join(root, 'data', 'slang-corrupt', names[0]), 'utf8'), '{ 这不是 JSON',
      'the stash holds the bytes that failed to parse');
    store.close();
  });
});

test('a config without a database path still stashes under data/, not runtime/', () => {
  withTemp((root) => {
    const cwd = process.cwd();
    process.chdir(root);
    const store = new Store();
    try {
      const slang = new Slang({ config: makeConfig({}), store, log: () => {}, now: tickingClock(1000) });
      assert.equal(slang.corruptDirectory, join('data', 'slang-corrupt'));
      assert.ok(!slang.corruptDirectory.replace(/\\/g, '/').split('/').includes('runtime'),
        'the old default was a relative runtime/, which no sweep covers');
      slang.stashCorrupt('x');
      assert.equal(readdirSync(join(root, 'data', 'slang-corrupt')).length, 1);
    } finally {
      process.chdir(cwd);
      store.close();
    }
  });
});

test('an explicit corruptDirectory still wins (backwards compatible)', () => {
  withTemp((root) => {
    const explicit = join(root, 'elsewhere');
    const store = new Store();
    const slang = new Slang({
      config: joinConfig(root), store, log: () => {}, now: tickingClock(1000), corruptDirectory: explicit,
    });
    assert.equal(slang.corruptDirectory, explicit);
    const file = slang.stashCorrupt('{ broken');
    assert.equal(file, join(explicit, `slang-corrupt-${stampOf(CLOCK_START + 1000)}.json`));
    assert.equal(readFileSync(file, 'utf8'), '{ broken');
    store.close();
  });
});

test('the stash pile is capped, and the newest stashes are the ones kept', () => {
  withTemp((root) => {
    const store = new Store();
    const directory = join(root, 'data', 'slang-corrupt');
    const slang = new Slang({ config: joinConfig(root), store, log: () => {}, now: tickingClock(1000) });
    for (let i = 0; i < 25; i += 1) {
      // Exactly what a failing import does, so the cap is exercised through the
      // real path rather than through a hand-built directory listing.
      assert.throws(() => slang.importAll(`{ 这不是 JSON #${i}`), /SLANG_IMPORT_INVALID/);
      assert.ok(readdirSync(directory).length <= MAX_CORRUPT_STASHES,
        `the pile exceeded its cap after ${i + 1} failed imports`);
    }
    const names = readdirSync(directory).sort();
    assert.equal(names.length, MAX_CORRUPT_STASHES);
    // The retained names are the 20 newest stamps; the five oldest are gone.
    assert.deepEqual(names, Array.from({ length: MAX_CORRUPT_STASHES }, (_, index) => (
      `slang-corrupt-${stampOf(CLOCK_START + 1000 * (index + 6))}.json`
    )));
    assert.ok(!names.includes(`slang-corrupt-${stampOf(CLOCK_START + 1000)}.json`), 'the oldest stash was pruned');
    store.close();
  });
});

test('the cap counts only stash files, so an unrelated neighbour survives', () => {
  withTemp((root) => {
    const store = new Store();
    const directory = join(root, 'data', 'slang-corrupt');
    mkdirSync(directory, { recursive: true });
    const stranger = join(directory, 'notes.txt');
    writeFileSync(stranger, 'not a stash');
    const slang = new Slang({ config: joinConfig(root), store, log: () => {}, now: tickingClock(1000) });
    for (let i = 0; i < MAX_CORRUPT_STASHES + 3; i += 1) slang.stashCorrupt(`{ broken ${i}`);
    assert.equal(readdirSync(directory).filter(name => /^slang-corrupt-.*\.json$/.test(name)).length, MAX_CORRUPT_STASHES);
    assert.ok(readdirSync(directory).includes('notes.txt'), 'pruning must not touch files it did not create');
    store.close();
  });
});
