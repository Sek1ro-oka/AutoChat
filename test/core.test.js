import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, budgetDay } from '../src/store.js';
import { Bot, parseEvent } from '../src/bot.js';
import { prepareMessages, estimateInput, usageCost } from '../src/model.js';
import { loadConfig } from '../src/config.js';

export function settings(overrides = {}) {
  return { botId: '10000001', privateUser: '10000002', adminId: '10000002', groupId: '10000003',
    budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, maxOutput: 128,
    contextTokens: 16000, clearMs: 72 * 3600000, systemPrompt: '简洁回答', blockTerms: [],
    model: 'deepseek-flash', ...overrides };
}
export function event(overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001,
    user_id: 10000002, message_id: 1, time: 1800000000,
    message: [{ type: 'text', data: { text: '你好' } }], ...overrides };
}
const now = 1800000000000;
function fixture(t, overrides = {}, modelOverride) {
  const config = settings(overrides), store = new Store();
  t.after(() => store.close());
  const requests = [], sent = [];
  const model = modelOverride || { complete: async messages => {
    requests.push(messages);
    return { text: '你好[CQ:at,qq=123]', usage: { prompt_tokens: 20, completion_tokens: 10 } };
  } };
  let clock = now;
  const bot = new Bot(config, store, model, { now: () => clock });
  return { config, store, bot, requests, sent, send: async (action, params) => sent.push({ action, params }),
    advance: ms => { clock += ms; }, time: () => clock };
}

test('message filters reject wrong users, self, old events, non-array and unrelated @', () => {
  const config = settings();
  for (const e of [event({ user_id: 123 }), event({ user_id: 10000001 }), event({ self_id: 999 }),
    event({ time: 1 }), event({ message: '[CQ:at,qq=10000001] hi' }), event({ message: [null] }),
    event({ message_type: 'group', group_id: 10000003 }),
    event({ message_type: 'group', group_id: 10000003, message: [{ type: 'at', data: { qq: 'other' } }] })]) {
    assert.equal(parseEvent(e, config, now), null);
  }
});

test('private replies use safe text segments; duplicate events invoke model once', async t => {
  const f = fixture(t);
  await f.bot.ingest(event(), f.send);
  await f.bot.ingest(event(), f.send);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent[0].action, 'send_private_msg');
  assert.deepEqual(f.sent[0].params.message, [{ type: 'text', data: { text: '你好[CQ:at,qq=123]' } }]);
  assert.equal(f.store.history('private:10000002').length, 2);
  assert.equal(f.store.balance(budgetDay(now), 1000000).used, 120);
});

test('private, group and group members have isolated histories', async t => {
  const f = fixture(t);
  await f.bot.ingest(event(), f.send);
  for (const user of [10000002, 10000004]) {
    await f.bot.ingest(event({ message_type: 'group', group_id: 10000003, user_id: user,
      message_id: user, message: [{ type: 'at', data: { qq: '10000001' } },
        { type: 'text', data: { text: '群问题' } }] }), f.send);
  }
  assert.equal(f.requests.length, 3);
  for (const request of f.requests) assert.equal(request.length, 2);
  assert.equal(f.store.history('group:10000003:10000004').length, 2);
});

test('empty @ gives local help and does not spend budget', async t => {
  const f = fixture(t);
  await f.bot.ingest(event({ message_type: 'group', group_id: 10000003,
    message: [{ type: 'at', data: { qq: '10000001' } }] }), f.send);
  assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 1);
});

test('72h group cleanup is fixed, clears all members and preserves private', t => {
  const f = fixture(t);
  const due = f.store.groupDue(f.config.groupId);
  f.store.save('private:10000002', 'private', [{ role: 'user', content: '私聊' }]);
  f.store.save('group:10000003:10000002', 'group:10000003', [{ role: 'user', content: '群聊' }]);
  f.advance(f.config.clearMs - 1); f.bot.maintenance();
  assert.equal(f.store.groupDue(f.config.groupId), due);
  assert.equal(f.store.history('group:10000003:10000002').length, 1);
  f.advance(1); f.bot.maintenance();
  assert.equal(f.store.history('group:10000003:10000002').length, 0);
  assert.equal(f.store.history('private:10000002').length, 1);
  assert.equal(f.store.groupDue(f.config.groupId), due + f.config.clearMs);
});

test('restart keeps reserved budget, dedup and due time; overdue cleanup precedes messages', t => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-test-')), path = join(dir, 'state.sqlite');
  t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
  let store = new Store(path);
  const config = settings();
  store.ensureGroup(config.groupId, now, config.clearMs);
  store.save('group:10000003:10000002', 'group:10000003', [{ role: 'user', content: 'old' }]);
  store.save('private:10000002', 'private', [{ role: 'user', content: 'private' }]);
  store.reserve(budgetDay(now), 800000, 1000000, now); store.claim('dedup', now); store.close();
  store = new Store(path);
  try {
    new Bot(config, store, {}, { now: () => now + config.clearMs * 2 + 1 });
    assert.equal(store.balance(budgetDay(now), 1000000).remaining, 200000);
    assert.equal(store.claim('dedup', now), false);
    assert.equal(store.history('group:10000003:10000002').length, 0);
    assert.equal(store.history('private:10000002').length, 1);
    assert.equal(store.groupDue(config.groupId), now + config.clearMs * 3);
  } finally { store.close(); }
});

test('budget reservations are atomic across database connections', t => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-test-')), path = join(dir, 'state.sqlite');
  const a = new Store(path), b = new Store(path);
  t.after(() => { a.close(); b.close(); for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
  const id = a.reserve('2026-10-02', 600000, 1000000, now);
  assert.ok(id); assert.equal(b.reserve('2026-10-02', 600000, 1000000, now), null);
  a.settle(id, 100000);
  assert.ok(b.reserve('2026-10-02', 600000, 1000000, now));
});

test('budget day changes at Hong Kong midnight and new day has separate budget', t => {
  const f = fixture(t);
  assert.equal(budgetDay(Date.parse('2026-10-02T15:59:59Z')), '2026-10-02');
  assert.equal(budgetDay(Date.parse('2026-10-02T16:00:00Z')), '2026-10-03');
  f.store.reserve('2026-10-02', 1000000, 1000000, now);
  assert.equal(f.store.reserve('2026-10-02', 1, 1000000, now), null);
  assert.ok(f.store.reserve('2026-10-03', 1, 1000000, now));
});

test('usage beyond reservation locks future calls for that day', t => {
  const f = fixture(t);
  const id = f.store.reserve('2026-10-02', 100, 1000000, now);
  f.store.settle(id, 101);
  assert.equal(f.store.reserve('2026-10-02', 1, 1000000, now), null);
  assert.ok(f.store.reserve('2026-10-03', 1, 1000000, now));
});

test('timeout and missing usage keep reservations and do not retry', async t => {
  for (const mode of ['timeout', 'missing']) {
    let calls = 0;
    const f = fixture(t, {}, { complete: async () => {
      calls++; if (mode === 'timeout') throw new Error('secret-server-message');
      return { text: 'answer' };
    } });
    await f.bot.ingest(event(), f.send);
    assert.equal(calls, 1);
    assert.ok(f.store.balance(budgetDay(now), 1000000).held > 0);
    assert.ok(!JSON.stringify(f.sent).includes('secret-server-message'));
  }
});

test('insufficient budget does not call the model', async t => {
  const f = fixture(t, { budgetMicro: 1 });
  await f.bot.ingest(event(), f.send);
  assert.equal(f.requests.length, 0); assert.match(f.sent[0].params.message[0].data.text, /预算/);
});

test('context trimming removes complete oldest turns and rejects oversized current input', () => {
  const config = settings({ contextTokens: 500 });
  const messages = prepareMessages([{ role: 'user', content: 'x'.repeat(200) },
    { role: 'assistant', content: 'y'.repeat(200) }], 'new', config);
  assert.equal(messages.length, 2); assert.ok(estimateInput(messages) <= 500);
  assert.throws(() => prepareMessages([], 'x'.repeat(1000), config), /INPUT_TOO_LONG/);
  assert.equal(usageCost({ prompt_tokens: -1, completion_tokens: 1 }, config), null);
});

test('admins can stop and recover; group members cannot stop', async t => {
  const f = fixture(t);
  await f.bot.ingest(event({ message: [{ type: 'text', data: { text: '/停止' } }] }), f.send);
  await f.bot.ingest(event({ message_id: 2 }), f.send);
  assert.equal(f.requests.length, 0);
  await f.bot.ingest(event({ message_id: 3, message: [{ type: 'text', data: { text: '/启动' } }] }), f.send);
  await f.bot.ingest(event({ message_id: 4 }), f.send);
  assert.equal(f.requests.length, 1);
  await f.bot.ingest(event({ message_id: 5, message_type: 'group', group_id: 10000003,
    user_id: 10000004, message: [{ type: 'at', data: { qq: '10000001' } },
      { type: 'text', data: { text: '/停止' } }] }), f.send);
  assert.equal(f.store.setting('enabled'), '1');
});

test('clear removes persisted current conversation', async t => {
  const f = fixture(t);
  await f.bot.ingest(event(), f.send);
  await f.bot.ingest(event({ message_id: 2, message: [{ type: 'text', data: { text: '/清空' } }] }), f.send);
  assert.deepEqual(f.store.history('private:10000002'), []);
});

test('rate limiting caps user calls; prompts are not repeated for every excess event', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 8; i++) await f.bot.ingest(event({ message_id: i }), f.send);
  assert.equal(f.requests.length, 3); assert.equal(f.sent.length, 4);
});

test('disconnection during generation settles usage but does not send or save stale reply', async t => {
  let live = true;
  const f = fixture(t, {}, { complete: async () => {
    live = false; return { text: 'answer', usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } });
  await f.bot.ingest(event(), f.send, () => live);
  assert.equal(f.sent.length, 0); assert.deepEqual(f.store.history('private:10000002'), []);
  assert.equal(f.store.balance(budgetDay(now), 1000000).used, 10);
});

test('bounded queue drops excess events without charging', async t => {
  const f = fixture(t);
  const jobs = Array.from({ length: 30 }, (_, i) => f.bot.ingest(event({ message_id: i + 1 }), f.send));
  assert.equal(f.bot.queued, 20);
  const results = await Promise.all(jobs);
  assert.equal(results.filter(Boolean).length, 20); assert.equal(f.requests.length, 3);
});

test('three consecutive send failures persist disabled state', async t => {
  const f = fixture(t);
  const fail = async () => { throw new Error('fail'); };
  for (let i = 1; i <= 3; i++) await f.bot.ingest(event({ message_id: i }), fail);
  assert.equal(f.store.setting('enabled'), '0');
  assert.deepEqual(f.store.history('private:10000002'), []);
});

test('input and output terms are blocked without persisting unsafe answers', async t => {
  const f = fixture(t, { blockTerms: ['BLOCK'] }, { complete: async () => ({ text: 'BLOCK',
    usage: { prompt_tokens: 2, completion_tokens: 2 } }) });
  await f.bot.ingest(event({ message: [{ type: 'text', data: { text: 'block' } }] }), f.send);
  assert.equal(f.store.balance(budgetDay(now), 1000000).used, 0);
  await f.bot.ingest(event({ message_id: 2 }), f.send);
  assert.equal(f.store.history('private:10000002').length, 0);
  assert.equal(f.store.balance(budgetDay(now), 1000000).used, 20);
});

test('configuration validates missing price, secret, remote WS and malformed IDs', () => {
  const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
    ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
    PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-02' };
  assert.equal(loadConfig(env).model, 'deepseek-flash');
  assert.throws(() => loadConfig({ ...env, PRICE_INPUT_CNY_PER_MILLION: '' }), /PRICE_INPUT/);
  assert.throws(() => loadConfig({ ...env, ONEBOT_ACCESS_TOKEN: '' }), /ONEBOT_ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...env, ONEBOT_WS_URL: 'ws://0.0.0.0:3001' }), /回环/);
  assert.throws(() => loadConfig({ ...env, GROUP_QQ: 'abc' }), /格式/);
});
