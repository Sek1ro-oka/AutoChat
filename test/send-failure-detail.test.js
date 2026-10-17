// The failure half of a send that did not happen (I-01 · Phase A).
//
// `docs/security.md` §3.3 says a failure must leave a detail behind, and these
// four `catch` blocks were the last sends that dropped it: the event name said
// *that* the text or the sticker did not go out, never *why*. The fix is one
// `errorDetail(error)` per site, so what this file pins is the contract that
// came out of it — the event name is unchanged, and the detail carries the
// error's name and message rather than the error object itself.
//
// Nothing here waits on a timer or opens a socket: `send` is a thunk that
// throws, and the logger is an array.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { StickerLib } from '../src/sticker-lib.js';
import { Social } from '../src/social/engine.js';

const CLOCK = 1800000000000;
const HEX8 = 'a'.repeat(8);
const TIMEOUT = 'TimeoutError';

// A thrown error can carry a chat message in its own fields, so the point of
// `errorDetail` is that exactly two strings survive it.
const boom = async () => {
  const error = new Error('send failed');
  error.name = TIMEOUT;
  throw error;
};

const recorder = () => {
  const logs = [];
  return { logs, log: (event, detail) => logs.push({ event, detail }) };
};

const only = (logs, event) => {
  const hits = logs.filter(item => item.event === event);
  assert.equal(hits.length, 1, `exactly one ${event} line`);
  return hits[0];
};

// --- src/sticker-lib.js -----------------------------------------------------

test('a sticker that could not be sent says why and is not counted as a use', async t => {
  const store = new Store();
  t.after(() => store.close());
  const dir = mkdtempSync(join(tmpdir(), 'autochat-send-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { logs, log } = recorder();
  const lib = new StickerLib({
    config: { databasePath: join(dir, 'x.sqlite'), stickerEnabled: true, stickerAutoCollect: false, stickerAutoThreshold: 2 },
    store, log, now: () => CLOCK,
  });
  store.upsertSticker({ id: HEX8, file: `${HEX8}.png`, status: 'confirmed', now: 1 });
  mkdirSync(join(dir, 'stickers'), { recursive: true });
  writeFileSync(join(dir, 'stickers', `${HEX8}.png`), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const sent = await lib.sendByIds([HEX8], { action: 'send_group_msg', target: { group_id: 1 } }, boom);
  assert.equal(sent, 0);
  assert.deepEqual(only(logs, 'sticker_send_failed').detail, { name: TIMEOUT, message: 'send failed' });
  assert.equal(store.getSticker(HEX8).use_count, 0, 'a send that failed is not a use');
});

// --- src/bot.js -------------------------------------------------------------

// The marker parser and the sender are the only parts of the sticker library
// this turn touches; the rest of the bot runs for real.
const stickerFake = () => ({
  enabled: () => true,
  block: () => '',
  hint: () => '',
  parseMarkers: () => ({ text: '好，这就发。', ids: [HEX8], notes: [] }),
  sendByIds: boom,
});

const BOT_ENV = {
  BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03',
};

test('a bot sticker that could not be sent leaves the error name behind', async t => {
  const config = loadConfig(BOT_ENV);
  const store = new Store();
  t.after(() => store.close());
  const { logs, log } = recorder();
  const bot = new Bot(config, store, {
    complete: async () => ({ text: '好，这就发。', usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  }, { now: () => CLOCK, log, stickers: stickerFake() });
  const sent = [];
  const send = async (action, params) => { sent.push({ action, params }); return { message_id: 1 }; };
  const event = {
    post_type: 'message', message_type: 'group', self_id: 10000001,
    user_id: 10000004, group_id: 10000003, message_id: 1, time: CLOCK / 1000,
    message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: '发个表情' } }],
  };

  assert.equal(await bot.ingest(event, send), true);
  assert.equal(sent.length, 1, 'the text reply itself went out');
  assert.deepEqual(only(logs, 'sticker_send_failed').detail, { name: TIMEOUT, message: 'send failed' });
});

// --- src/social/engine.js ---------------------------------------------------

const makeConfig = overrides => ({
  botId: '10000', groupId: '20000', groupIds: ['20000'],
  socialEnabled: true, socialThreshold: 6, socialCooldownSeconds: 45, socialDailyLimit: 20,
  socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
  socialMessageTtlMs: 24 * 3600000, botName: '小助手', botNicknames: [],
  socialIdleEnabled: false, socialIdleMinutes: 45, socialIdleHours: '0-23',
  blockTerms: [], budgetMicro: 1000000, maxOutput: 1024,
  inputPrice: 2, outputPrice: 8, cacheHitPrice: null, offPeakRatio: 0.5, costHolidays: [],
  systemPrompt: '内置人设',
  ...overrides,
});

function harness({ reply, stickers = null, log }) {
  const store = new Store();
  const social = new Social({
    config: makeConfig({}), store, stickers, log,
    model: { complete: async () => ({ text: reply, usage: { prompt_tokens: 500, completion_tokens: 30 } }) },
    now: () => CLOCK, random: () => 0, sleep: async () => {},
  });
  social.setParams({ threshold: 0 });
  const event = {
    post_type: 'message', message_type: 'group', self_id: '10000',
    user_id: '30001', group_id: '20000', message_id: '1', time: Math.floor(CLOCK / 1000),
    message: [{ type: 'text', data: { text: '随便说说' } }],
  };
  return { store, social, event };
}

test('social text that could not be sent says why and stops the burst', async t => {
  const { logs, log } = recorder();
  const { store, social, event } = harness({ reply: '我觉得二分就行。先说数据范围。', log });
  t.after(() => store.close());

  assert.equal(await social.observe(event, boom, () => true), false);
  assert.deepEqual(only(logs, 'social_send_failed').detail, { name: TIMEOUT, message: 'send failed' });
  assert.ok(!logs.some(item => item.event === 'social_spoke'), 'nothing is recorded as spoken');
});

test('social sticker that could not be sent is reported apart from the text', async t => {
  const { logs, log } = recorder();
  const stickers = {
    enabled: () => true, block: () => '', hint: () => '',
    parseMarkers: () => ({ text: '好，这就发。', ids: [HEX8] }),
    sendByIds: boom,
  };
  const { store, social, event } = harness({ reply: '好，这就发。', stickers, log });
  t.after(() => store.close());
  const sent = [];
  const send = async (action, params) => { sent.push({ action, params }); return { message_id: 9001 }; };

  assert.equal(await social.observe(event, send, () => true), true);
  assert.equal(sent.length, 1, 'the text bubble itself went out');
  assert.deepEqual(only(logs, 'social_sticker_send_failed').detail, { name: TIMEOUT, message: 'send failed' });
});
