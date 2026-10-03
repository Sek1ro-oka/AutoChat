import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Bot } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { OneBot } from '../src/onebot.js';
import { loadConfig } from '../src/config.js';
const start = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQS: '10000003,10000007',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03', GROUP_ANTI_SPAM_ENABLED: 'true' };
function event(id, time = start, overrides = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 10000001, user_id: 10000004,
    group_id: 10000003, message_id: id, time: time / 1000, message: [{ type: 'text', data: { text: '刷屏' } }], ...overrides };
}
function fixture(t, overrides = {}, handler) {
  const config = loadConfig({ ...env, ...overrides }), store = new Store(), calls = [], logs = [];
  let clock = start;
  t.after(() => store.close());
  const bot = new Bot(config, store, { complete: async () => assert.fail('Must not call model') },
    { now: () => clock, log: value => logs.push(value) });
  const api = async (action, params) => {
    calls.push({ action, params });
    if (handler) return handler(action, params);
    if (action === 'get_group_member_info') return { ...params, role: params.user_id === 10000001 ? 'admin' : 'member' };
    assert.ok(['set_group_ban', 'send_group_msg'].includes(action)); return {};
  };
  return { config, store, calls, logs, bot, api, advance: ms => { clock += ms; }, now: () => clock };
}
async function burst(f, from = 1, overrides = {}, alive) {
  for (let id = from; id < from + 5; id++) await f.bot.ingest(event(id, f.now(), overrides), f.api, alive);
}
test('five consecutive non-mentioned group messages mute once for five minutes with no AI or history', async t => {
  const f = fixture(t); f.store.set('enabled', '0'); f.store.set('groupEnabled', '0');
  for (let id = 1; id < 5; id++) await f.bot.ingest(event(id), f.api);
  assert.equal(f.calls.length, 0);
  await f.bot.ingest(event(5), f.api);
  assert.deepEqual(f.calls.map(c => c.action), ['get_group_member_info', 'get_group_member_info', 'set_group_ban', 'send_group_msg']);
  assert.ok(f.calls.slice(0,2).every(c => c.params.no_cache));
  assert.deepEqual(f.calls[2].params, { group_id: 10000003, user_id: 10000004, duration: 300 });
  assert.deepEqual(f.calls[3].params.message, [{ type: 'at', data: { qq: '10000004' } },
    { type: 'text', data: { text: ' 你话太多了！' } }]);
  assert.equal(f.store.history('group:10000003:10000004').length, 0);
  assert.equal(f.store.balance(budgetDay(start), 1000000).used, 0);
});
test('text, image and face messages count together; a pending model reply does not delay moderation', async t => {
  const f = fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const bot = new Bot(f.config, f.store, { complete: async () => {
    entered(); await pending; return { text: '正常回复', usage: { prompt_tokens: 20, completion_tokens: 10 } };
  } }, { now: f.now });
  const first = bot.ingest(event(1, start, { message: [{ type: 'at', data: { qq: '10000001' } },
    { type: 'text', data: { text: '一个问题' } }] }), f.api);
  await started;
  try {
    await bot.ingest(event(2, start, { message: [{ type: 'image', data: { file: 'test.png' } }] }), f.api);
    await bot.ingest(event(3, start, { message: [{ type: 'face', data: { id: 14 } }] }), f.api);
    await bot.ingest(event(4), f.api); await bot.ingest(event(5), f.api);
    assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 1);
  } finally { release(); await first; }
});
test('duplicates, other speakers, expired windows and out-of-order events do not trigger a mute', async t => {
  const f = fixture(t);
  for (let n = 0; n < 10; n++) await f.bot.ingest(event(1), f.api);
  for (let id = 2; id <= 4; id++) await f.bot.ingest(event(id), f.api);
  await f.bot.ingest(event(5, start, { user_id: 10000005 }), f.api);
  for (let id = 6; id < 10; id++) await f.bot.ingest(event(id), f.api);
  f.advance(11000); await f.bot.ingest(event(10, f.now()), f.api);
  await f.bot.ingest(event(11, start), f.api);
  assert.equal(f.calls.length, 0);
});
test('groups count independently, bot messages interrupt and private or unlisted groups are ignored', async t => {
  const f = fixture(t);
  for (let id = 1; id < 5; id++) await f.bot.ingest(event(id), f.api);
  await f.bot.ingest(event(5, start, { user_id: 10000001 }), f.api);
  await f.bot.ingest(event(6), f.api);
  await burst(f, 10, { group_id: 10000007 });
  await burst(f, 20, { group_id: 10000009 });
  await burst(f, 30, { message_type: 'private' });
  assert.deepEqual(f.calls.filter(c => c.action === 'set_group_ban').map(c => c.params.group_id), [10000007]);
});
test('disabled mode, stale events, incorrect bot identity and disconnect never submit moderation', async t => {
  const off = fixture(t, { GROUP_ANTI_SPAM_ENABLED: 'false' }); await burst(off); assert.equal(off.calls.length, 0);
  const f = fixture(t);
  await burst(f, 1, { time: (start - 31000) / 1000 });
  await burst(f, 10, { self_id: 10000006 });
  await burst(f, 20, {}, () => false);
  assert.equal(f.calls.length, 0);
});
test('live permission and identity checks protect owner/admin and fail closed', async t => {
  for (const mode of ['bot_member', 'owner', 'admin', 'bad_identity', 'read_failure']) {
    const f = fixture(t, {}, async (action, params) => {
      assert.equal(action, 'get_group_member_info');
      if (mode === 'read_failure') throw new Error('FAILED');
      const bot = params.user_id === 10000001;
      return { ...params, user_id: mode === 'bad_identity' ? 10000009 : params.user_id,
        role: bot ? (mode === 'bot_member' ? 'member' : 'admin') : mode };
    });
    await burst(f); assert.ok(!f.calls.some(c => c.action === 'set_group_ban'));
  }
});
test('failed mute is not retried; persistent cooldown survives restart and expires', async t => {
  const f = fixture(t, {}, async (action, params) => {
    if (action === 'set_group_ban') throw new Error('UNKNOWN_RESULT');
    return { ...params, role: params.user_id === 10000001 ? 'admin' : 'member' };
  });
  await burst(f); assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 1);
  const next = new Bot(f.config, f.store, {}, { now: f.now });
  for (let id = 10; id < 20; id++) await next.ingest(event(id), f.api);
  assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 1);
  f.advance(301000); await burst(f, 30);
  assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 2);
});
test('configurable thresholds and strict config validation', async t => {
  const f = fixture(t, { GROUP_ANTI_SPAM_COUNT: '2', GROUP_ANTI_SPAM_MUTE_MINUTES: '3' });
  await f.bot.ingest(event(1), f.api); await f.bot.ingest(event(2), f.api);
  assert.equal(f.calls.find(c => c.action === 'set_group_ban').params.duration, 180);
  for (const invalid of [{ GROUP_ANTI_SPAM_ENABLED: 'yes' }, { GROUP_ANTI_SPAM_COUNT: '1' },
    { GROUP_ANTI_SPAM_WINDOW_SECONDS: '0' }, { GROUP_ANTI_SPAM_MUTE_MINUTES: '1.5' }])
    assert.throws(() => loadConfig({ ...env, ...invalid }));
});
test('configured notice uses safe text, can be disabled, and notice failure never repeats mute', async t => {
  const f = fixture(t, { GROUP_ANTI_SPAM_REPLY: '少刷屏[CQ:at,qq=all]' });
  await burst(f);
  assert.deepEqual(f.calls.at(-1).params.message[1], { type: 'text', data: { text: ' 少刷屏[CQ:at,qq=all]' } });
  const off = fixture(t, { GROUP_ANTI_SPAM_REPLY: '' }); await burst(off);
  assert.ok(!off.calls.some(c => c.action === 'send_group_msg'));
  const failed = fixture(t, {}, async (action, params) => {
    if (action === 'send_group_msg') throw new Error('UNKNOWN_SEND');
    return action === 'get_group_member_info' ? { ...params, role: params.user_id === 10000001 ? 'admin' : 'member' } : {};
  });
  await burst(failed); await burst(failed, 10);
  assert.equal(failed.calls.filter(c => c.action === 'set_group_ban').length, 1);
  assert.equal(failed.calls.filter(c => c.action === 'send_group_msg').length, 1);
  assert.ok(failed.logs.includes('anti_spam_notice_failed'));
});
test('mock NapCat WebSocket routes unmentioned messages to verified moderation API', async t => {
  const f = fixture(t), actions = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let completed;
  const done = new Promise(resolve => { completed = resolve; });
  server.on('connection', socket => socket.on('message', raw => {
    const body = JSON.parse(raw); actions.push(body.action);
    const data = body.action === 'get_login_info' ? { user_id: 10000001 }
      : body.action === 'get_group_member_info' ? { ...body.params, role: body.params.user_id === 10000001 ? 'admin' : 'member' } : {};
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: body.echo, data }));
    if (body.action === 'set_group_ban') { assert.equal(body.params.duration, 300); completed(); }
  }));
  const transport = new OneBot({ ...f.config, wsUrl: `ws://127.0.0.1:${server.address().port}`, actionTimeoutMs: 1000 }, {
    onEvent: (...args) => f.bot.ingest(...args), log: name => {
      if (name === 'onebot_connected') for (const socket of server.clients)
        for (let id = 1; id <= 5; id++) socket.send(JSON.stringify(event(id)));
    },
  });
  t.after(async () => { transport.stop(); for (const socket of server.clients) socket.terminate(); await f.bot.antiSpam.tail;
    await new Promise(resolve => server.close(resolve)); });
  transport.start(); await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))]);
  assert.equal(actions.filter(action => action === 'set_group_ban').length, 1);
});
