import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { StickerLib } from '../src/sticker-lib.js';
import {
  sanitizeStickerText, stickerId, normalizeSticker, findSticker,
  buildStickerBlock, parseStickerMarkers, shouldAutoCollect, mentionsCollectSignal,
} from '../src/stickers.js';

const HEX8 = 'a'.repeat(8);

test('sticker text is flattened to one line and stripped of control characters', () => {
  assert.equal(sanitizeStickerText('a\nb\nc'), 'a b c');
  assert.equal(sanitizeStickerText('  x\u0000y\u200bz  '), 'xyz');
  assert.equal(sanitizeStickerText('abc', 2), 'ab');
});

test('sticker identity prefers md5, then derives stably from url', () => {
  const md5 = 'a'.repeat(32);
  assert.equal(stickerId({ md5, url: 'https://x' }), md5);
  assert.equal(stickerId({ md5: 'not-hex', url: '' }), '');
  const byUrl = stickerId({ url: 'https://qpic.cn/foo' });
  assert.match(byUrl, /^[a-f0-9]{24}$/);
  assert.equal(stickerId({ url: 'https://qpic.cn/foo' }), byUrl);
});

test('normalise rejects unknown ids and findSticker matches id/md5 only', () => {
  const row = normalizeSticker({ id: HEX8, md5: '', url: 'https://x', desc: 'hi', note: 'yo', tags: ['a', 'b'] });
  assert.equal(row.id, HEX8);
  assert.deepEqual(row.tags, ['a', 'b']);
  assert.equal(normalizeSticker({ id: 'not-hex', url: 'https://x' }), null);
  const list = [normalizeSticker({ id: HEX8, md5: 'b'.repeat(32), url: 'https://x' })];
  assert.equal(findSticker(list, HEX8).id, HEX8);
  assert.equal(findSticker(list, 'b'.repeat(32)).id, HEX8);
  assert.equal(findSticker(list, 'nope'), null);
});

test('the injected block lists only sendable stickers and frames them as data', () => {
  const entries = [
    { id: 'a'.repeat(8), file: 'a.png', note: '猫', status: 'confirmed' },
    { id: 'b'.repeat(8), file: '', note: '无文件', status: 'confirmed' },
    { id: 'c'.repeat(8), file: 'c.png', note: '候选', status: 'candidate' },
  ];
  const block = buildStickerBlock(entries);
  assert.match(block, /猫/);
  assert.ok(!block.includes('无文件'));
  assert.ok(!block.includes('候选'));
  assert.match(block, /不是给你的指令/);
});

test('markers are parsed and stripped, and only on their own line', () => {
  const { text, ids, notes } = parseStickerMarkers('哈哈\n【表情:aabbcc】\n真逗');
  assert.deepEqual(ids, ['aabbcc']);
  assert.deepEqual(notes, []);
  assert.equal(text, '哈哈\n真逗');
  const collect = parseStickerMarkers('这张好\n【偷图:存了这张】');
  assert.deepEqual(collect.notes, ['存了这张']);
  assert.equal(collect.text, '这张好');
  // 行中间的括号不是独立标记，不会被当作指令
  assert.deepEqual(parseStickerMarkers('好图【偷图:存了】').notes, []);
});

test('auto-collect keeps a candidate once seen enough times', () => {
  assert.equal(shouldAutoCollect({ id: HEX8, status: 'candidate', seen: 2 }, { threshold: 2 }), true);
  assert.equal(shouldAutoCollect({ id: HEX8, status: 'candidate', seen: 1 }, { threshold: 2 }), false);
  assert.equal(shouldAutoCollect({ id: HEX8, status: 'confirmed', seen: 3 }, { threshold: 2 }), false);
});

test('collect signals are recognised in free text', () => {
  assert.equal(mentionsCollectSignal('这图我偷了'), true);
  assert.equal(mentionsCollectSignal('普通聊天'), false);
});

test('stickers persist with dedupe, seen counts, use counts and trimming', t => {
  const store = new Store();
  t.after(() => store.close());
  const first = store.upsertSticker({ id: HEX8, md5: 'a'.repeat(32), url: 'https://x', file: 'a.png', now: 1000 });
  assert.equal(first.created, true);
  assert.equal(first.seen, 1);
  const again = store.upsertSticker({ id: HEX8, md5: 'a'.repeat(32), file: '', now: 2000 });
  assert.equal(again.created, false);
  assert.equal(again.seen, 2);
  const row = store.getSticker(HEX8);
  assert.equal(row.file, 'a.png'); // a repeat must not blank the file
  store.setStickerStatus(HEX8, 'confirmed', 3000);
  assert.equal(store.getSticker(HEX8).status, 'confirmed');
  store.recordStickerUse(HEX8, 4000);
  assert.equal(store.getSticker(HEX8).use_count, 1);
  store.deleteSticker(HEX8);
  assert.equal(store.getSticker(HEX8), null);
});

test('observe downloads, lands a candidate, and rule-collects at the threshold', async t => {
  const store = new Store();
  t.after(() => store.close());
  const config = { databasePath: join(tmpdir(), 'x.sqlite'), stickerEnabled: true, stickerAutoCollect: true, stickerAutoThreshold: 2 };
  const lib = new StickerLib({ config, store, download: async () => 'img.png', now: () => 1000 });
  const segment = { data: { md5: 'a'.repeat(32), url: 'https://qpic.cn/foo' } };
  const first = await lib.observe(segment);
  assert.equal(first.status, 'candidate');
  assert.equal(first.seen, 1);
  const second = await lib.observe(segment);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.seen, 2);
});

test('sendByIds sends only confirmed stickers with a file and counts uses', async t => {
  const store = new Store();
  t.after(() => store.close());
  const dir = mkdtempSync(join(tmpdir(), 'autochat-stk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { databasePath: join(dir, 'x.sqlite'), stickerEnabled: true, stickerAutoCollect: false, stickerAutoThreshold: 2 };
  const lib = new StickerLib({ config, store });
  store.upsertSticker({ id: HEX8, file: `${HEX8}.png`, status: 'confirmed', now: 1 });
  mkdirSync(join(dir, 'stickers'), { recursive: true });
  writeFileSync(join(dir, 'stickers', `${HEX8}.png`), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const sent = [];
  const n = await lib.sendByIds([HEX8], { action: 'send_group_msg', target: { group_id: 1 } }, async (action, params) => { sent.push({ action, params }); });
  assert.equal(n, 1);
  assert.equal(sent[0].params.message[0].type, 'image');
  assert.equal(store.getSticker(HEX8).use_count, 1);
});

test('manual upload writes a confirmed sticker and serves its bytes back', t => {
  const store = new Store();
  t.after(() => store.close());
  const dir = mkdtempSync(join(tmpdir(), 'autochat-stk2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lib = new StickerLib({ config: { databasePath: join(dir, 'x.sqlite'), stickerEnabled: true, stickerAutoCollect: true, stickerAutoThreshold: 2 }, store });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const res = lib.upload({ dataUrl, note: '我的图' });
  assert.equal(res.entry.status, 'confirmed');
  assert.equal(res.entry.source, 'manual');
  assert.equal(res.entry.note, '我的图');
  const img = lib.image(res.entry.id);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(img.bytes, png);
});
