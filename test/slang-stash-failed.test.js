// The failure half of the corrupt-import stash (I-03 · Phase A · D-05).
//
// `stashCorrupt` still returns null when it cannot write: the import must fail
// with the parse error the operator can act on, never with a disk error it can
// do nothing about. What changed is that the reason no longer disappears with
// it. `test/slang-stash.test.js` covers where a stash lands and how many are
// kept; this file covers the paths where nothing lands at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_CORRUPT_STASHES, Slang } from '../src/social/slang.js';

const CLOCK = 1800000000000;
const stampOf = ms => new Date(ms).toISOString().replace(/[:.]/g, '-');

const withTemp = body => {
  const root = mkdtempSync(join(tmpdir(), 'autochat-slang-stash-failed-'));
  try { return body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// These paths are reached while the import is already failing, so the store and
// the model are never consulted — a logger that records the call is the whole
// fixture.
const build = corruptDirectory => {
  const seen = [];
  return {
    seen,
    slang: new Slang({
      config: {}, store: null, model: null, now: () => CLOCK, corruptDirectory,
      log: (event, detail) => seen.push({ event, detail }),
    }),
  };
};

test('a stash that cannot be written reports why and still returns null', () => withTemp(root => {
  // A regular file where the directory should be: `mkdirSync` throws EEXIST and
  // no retry can help — exactly the case that used to vanish into `return null`.
  const blocked = join(root, 'slang-corrupt');
  writeFileSync(blocked, 'not a directory');
  const { seen, slang } = build(blocked);
  assert.equal(slang.stashCorrupt('{ 这不是 JSON'), null);
  assert.deepEqual(seen.map(item => item.event), ['slang_stash_failed']);
  assert.deepEqual(Object.keys(seen[0].detail), ['name', 'message'], 'no stack, no error object, no raw text');
  assert.equal(seen[0].detail.name, 'Error');
  assert.match(seen[0].detail.message, /EEXIST|ENOTDIR/);
}));

test('a rejected import says how much was rejected and whether a copy survived', () => withTemp(root => {
  const stash = join(root, 'stash');
  const { seen, slang } = build(stash);
  const raw = '{ 这不是 JSON';
  assert.throws(() => slang.importAll(raw), /SLANG_IMPORT_INVALID/);
  // The successful path also hardens the stash, which logs an event of its own
  // (src/permissions.js) — and does so differently on each platform — so this
  // looks for the import record rather than pinning the whole sequence.
  const [corrupt] = seen.filter(item => item.event === 'slang_import_corrupt');
  assert.deepEqual(corrupt.detail, {
    bytes: Buffer.byteLength(raw, 'utf8'), stashed: true, file: `slang-corrupt-${stampOf(CLOCK)}.json`,
  });
  // The name in the log has to be the file an operator can actually open.
  assert.deepEqual(readdirSync(stash), [corrupt.detail.file]);
}));

test('a rejected import whose copy could not be kept says so instead of guessing', () => withTemp(root => {
  const blocked = join(root, 'slang-corrupt');
  writeFileSync(blocked, 'not a directory');
  const { seen, slang } = build(blocked);
  assert.throws(() => slang.importAll('{ 这不是 JSON'), /SLANG_IMPORT_INVALID/);
  assert.deepEqual(seen.map(item => item.event), ['slang_stash_failed', 'slang_import_corrupt']);
  assert.deepEqual(seen[1].detail, {
    bytes: Buffer.byteLength('{ 这不是 JSON', 'utf8'), stashed: false, file: null,
  });
}));

test('housekeeping that cannot read the stash directory reports the phase', () => withTemp(root => {
  const blocked = join(root, 'stash');
  writeFileSync(blocked, 'not a directory');
  const { seen, slang } = build(blocked);
  assert.equal(slang.pruneCorruptStashes(), 0);
  assert.deepEqual(seen.map(item => item.event), ['slang_stash_prune_failed']);
  assert.deepEqual(seen[0].detail.phase, 'read');
  assert.equal(seen[0].detail.name, 'Error');
}));

test('a stash that cannot be removed is reported with its own phase', () => withTemp(root => {
  const stash = join(root, 'stash');
  mkdirSync(stash, { recursive: true });
  // Directories wearing a stash's name: `unlinkSync` cannot remove them on any
  // platform, which stands in for the everyday Windows case of a file that is
  // still held open. One over the cap, so exactly one removal is attempted.
  const names = Array.from({ length: MAX_CORRUPT_STASHES + 1 }, (_, index) =>
    `slang-corrupt-2027-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z.json`);
  for (const name of names) mkdirSync(join(stash, name));
  const { seen, slang } = build(stash);
  assert.equal(slang.pruneCorruptStashes(), 0, 'a stash that could not be removed is not counted as removed');
  assert.deepEqual(seen.map(item => item.event), ['slang_stash_prune_failed']);
  assert.deepEqual(seen[0].detail.phase, 'unlink');
}));
