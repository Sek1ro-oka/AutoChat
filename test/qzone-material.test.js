import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATERIAL_MAX_CHARS, MATERIAL_MIN_CHARS, MAX_BATCH, PREFILTER_REASONS,
  chunkBatch, prefilterReason, selectMaterial,
} from '../src/qzone-material.js';

const CTX = { botId: '10000', blockTerms: ['赌博'] };
const GOOD = '今天食堂的番茄炒蛋很好吃';

test('a usable group message has no reason', () => {
  assert.equal(prefilterReason({ text: GOOD, userId: '30001', ...CTX }), null);
});

test('the bot\'s own messages are dropped', () => {
  assert.equal(prefilterReason({ text: GOOD, userId: '10000', ...CTX }), 'own');
});

test('empty text is dropped', () => {
  assert.equal(prefilterReason({ text: '   ', userId: '30001', ...CTX }), 'empty');
});

test('a command is dropped', () => {
  assert.equal(prefilterReason({ text: '/帮助 看看有什么', userId: '30001', ...CTX }), 'command');
});

test('a message outside the length band is dropped', () => {
  assert.equal(prefilterReason({ text: '嗯', userId: '30001', ...CTX }), 'length');
  assert.equal(prefilterReason({ text: '啊'.repeat(MATERIAL_MAX_CHARS + 1), userId: '30001', ...CTX }), 'length');
  assert.equal(MATERIAL_MIN_CHARS, 4);
});

test('emoji and punctuation on their own are dropped', () => {
  assert.equal(prefilterReason({ text: '😂😂😂😂😂', userId: '30001', ...CTX }), 'emoji');
  assert.equal(prefilterReason({ text: '。。。。。。', userId: '30001', ...CTX }), 'emoji');
});

test('links, numbers, mentions and markers are dropped', () => {
  assert.equal(prefilterReason({ text: '看这个https://example.com挺好', userId: '30001', ...CTX }), 'link');
  assert.equal(prefilterReason({ text: '我的号是12345678', userId: '30001', ...CTX }), 'number');
  assert.equal(prefilterReason({ text: '@全体成员 开会了', userId: '30001', ...CTX }), 'mention');
  assert.equal(prefilterReason({ text: '【图片】今天天气不错', userId: '30001', ...CTX }), 'markup');
});

test('a blocked term is dropped', () => {
  assert.equal(prefilterReason({ text: '楼下又在赌博了', userId: '30001', ...CTX }), 'term');
});

test('every declared pre-filter reason is reachable', () => {
  const cases = [
    { text: GOOD, userId: '10000' }, { text: '  ', userId: '30001' }, { text: '/命令 在这里', userId: '30001' },
    { text: '嗯', userId: '30001' }, { text: '😂😂😂😂😂', userId: '30001' },
    { text: '看这个https://example.com挺好', userId: '30001' }, { text: '我的号是12345678', userId: '30001' },
    { text: '@全体成员 开会了', userId: '30001' }, { text: '【图片】今天天气不错', userId: '30001' },
    { text: '楼下又在赌博了', userId: '30001' },
  ];
  const seen = cases.map(item => prefilterReason({ ...CTX, ...item })).filter(Boolean);
  assert.deepEqual([...new Set(seen)].sort(), [...PREFILTER_REASONS].sort());
});

// --- selecting the batch ----------------------------------------------------

const CLOCK = 1800000000000;
const row = (id, at, text, { group = '20000', user = '30001' } = {}) =>
  ({ group_id: group, message_id: id, user_id: user, at, text });
const CTX2 = { now: CLOCK, ttlMs: 6 * 3600000, groupIds: ['20000'], botId: '10000', blockTerms: [], cursor: 0 };

test('only whitelisted groups are material', () => {
  const rows = [row('a', CLOCK - 1000, GOOD), row('b', CLOCK - 1000, '另一个群里的这句话也是素材', { group: '40000' })];
  assert.deepEqual(selectMaterial(rows, CTX2).map(item => item.messageId), ['a']);
});

test('stale material and already-consumed material are skipped', () => {
  const rows = [
    row('old', CLOCK - 7 * 3600000, '这是七小时前的闲聊内容'),
    row('done', CLOCK - 2000, '这一条已经评估过了不算'),
    row('new', CLOCK - 1000, '这一条是新的可以进入批次'),
  ];
  assert.deepEqual(selectMaterial(rows, { ...CTX2, cursor: CLOCK - 2000 }).map(item => item.messageId), ['new']);
});

test('messages that fail the pre-filter never reach the caller', () => {
  const rows = [row('bad', CLOCK - 1000, '我的号是12345678'), row('good', CLOCK - 900, GOOD)];
  assert.deepEqual(selectMaterial(rows, CTX2).map(item => item.messageId), ['good']);
});

test('the batch is ascending by time and carries what the prompt needs', () => {
  const rows = [row('b', CLOCK - 900, '第二条消息说今天天气很好'), row('a', CLOCK - 1000, '第一条消息说食堂好吃')];
  const material = selectMaterial(rows, CTX2);
  assert.deepEqual(material.map(item => item.messageId), ['a', 'b']);
  assert.deepEqual(Object.keys(material[0]).sort(), ['at', 'groupId', 'messageId', 'text', 'userId']);
});

test('a batch is capped at MAX_BATCH and keeps the oldest rows', () => {
  const material = Array.from({ length: MAX_BATCH + 10 }, (_, index) =>
    ({ at: index, messageId: String(index), text: 'x', groupId: '20000', userId: '1' }));
  const batch = chunkBatch(material);
  assert.equal(batch.length, MAX_BATCH);
  assert.equal(batch[0].messageId, '0');
});
