import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { Bot, parseEvent } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { OneBot } from '../src/onebot.js';

const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', PRIVATE_USER_QQS: '10000002,10000005',
  ADMIN_QQ: '10000005', GROUP_QQS: '10000003,10000007', ONEBOT_ACCESS_TOKEN: 'test',
  DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2', PRICE_OUTPUT_CNY_PER_MILLION: '8',
  PRICE_VERIFIED_DATE: '2026-10-03', GROUP_MANAGEMENT_ENABLED: 'true' };
function event(text = '/禁言 10000003 10000004 10', overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: 1, time: now / 1000, message: [{ type: 'text', data: { text } }], ...overrides };
}
function fixture(t, { config = {}, botRole = 'admin', targetRole = 'member', handler } = {}) {
  const c = loadConfig({ ...env, ...config }), store = new Store(), calls = [], sent = [];
  t.after(() => store.close());
  const bot = new Bot(c, store, { complete: async () => { throw new Error('MUST_NOT_CALL_MODEL'); } }, { now: () => now });
  const api = async (action, params) => {
    if (action === 'send_private_msg' || action === 'send_group_msg') { sent.push(params.message[0].data.text); return {}; }
    calls.push({ action, params });
    if (handler) return handler(action, params);
    if (action === 'get_group_member_info') return { ...params, role: params.user_id === 10000001 ? botRole : targetRole };
    if (action === 'set_group_ban') return {};
    throw new Error('UNEXPECTED_ACTION');
  };
  return { c, store, bot, api, calls, sent };
}

test('management controller mutes and unmutes with permission checks, no history or model charges, and dedup', async t => {
  const f = fixture(t);
  f.store.set('enabled', '0'); // Model pause does not revoke explicit group management.
  const previous = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer' }];
  f.store.save('private:10000002', 'private', previous);
  await f.bot.ingest(event(), f.api);
  await f.bot.ingest(event(), f.api);
  await f.bot.ingest(event('/解除禁言 10000007 10000004', { message_id: 2 }), f.api);
  assert.deepEqual(f.calls.filter(call => call.action === 'set_group_ban').map(call => call.params), [
    { group_id: 10000003, user_id: 10000004, duration: 600 },
    { group_id: 10000007, user_id: 10000004, duration: 0 },
  ]);
  assert.ok(f.calls.filter(call => call.action === 'get_group_member_info').every(call => call.params.no_cache === true));
  assert.match(f.sent[0], /已将/); assert.match(f.sent[1], /已解除/);
  assert.deepEqual(f.store.history('private:10000002'), previous);
  assert.deepEqual(f.store.balance(budgetDay(now), f.c.budgetMicro), { used: 0, held: 0, remaining: f.c.budgetMicro });
});
test('private controller can operate admin targets only when bot is group owner', async t => {
  const f = fixture(t, { botRole: 'owner', targetRole: 'admin' });
  await f.bot.ingest(event(), f.api);
  await f.bot.ingest(event('/解除禁言 10000003 10000004', { message_id: 2 }), f.api);
  assert.deepEqual(f.calls.filter(c => c.action === 'set_group_ban').map(c => c.params.duration), [600, 0]);
});

test('disabled feature, other private admin and group messages cannot execute management', async t => {
  for (const variant of ['disabled', 'other', 'group']) {
    const f = fixture(t, { config: variant === 'disabled' ? { GROUP_MANAGEMENT_ENABLED: 'false' } : {} });
    const message = variant === 'group' ? event('', { message_type: 'group', group_id: 10000003,
      message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: '/禁言 10000003 10000004 10' } }] })
      : event(undefined, variant === 'other' ? { user_id: 10000005 } : {});
    await f.bot.ingest(message, f.api);
    assert.equal(f.calls.length, 0);
    assert.match(f.sent[0], variant === 'disabled' ? /已关闭/ : /仅限/);
  }
});

test('invalid input, unlisted groups and bot-self target never reach management APIs', async t => {
  for (const text of ['/禁言 10000003 10000004 0', '/禁言 10000003 10000004 43201',
    '/禁言 10000003 10000004 1.5', '/禁言 10000003 10000004 1e3',
    '/禁言 10000003 10000004 10 extra', '/禁言 invalid 10000004 10',
    '/禁言 10000008 10000004 10', '/禁言 10000003 10000001 10', '/解除禁言 10000003']) {
    const f = fixture(t); await f.bot.ingest(event(text), f.api); assert.equal(f.calls.length, 0);
  }
});

test('missing bot privilege, protected targets and mismatched identities prevent mutation', async t => {
  for (const options of [{ botRole: 'member' }, { botRole: 'unknown' }, { targetRole: 'admin' },
    { targetRole: 'owner' }, { handler: async (action, params) => ({ ...params, user_id: 999, role: 'owner' }) }]) {
    const f = fixture(t, options); await f.bot.ingest(event(), f.api);
    assert.ok(!f.calls.some(call => call.action === 'set_group_ban'));
  }
});

test('failed read prevents submission and failed mutation is never retried or reported as successful', async t => {
  for (const failure of ['read', 'ONEBOT_ACTION_FAILED', 'ONEBOT_TIMEOUT']) {
    const f = fixture(t, { handler: async (action, params) => {
      if (failure === 'read' || action === 'set_group_ban') throw new Error(failure);
      return { ...params, role: params.user_id === 10000001 ? 'owner' : 'member' };
    } });
    await f.bot.ingest(event(), f.api); await f.bot.ingest(event(), f.api);
    assert.equal(f.calls.filter(call => call.action === 'set_group_ban').length, failure === 'read' ? 0 : 1);
    assert.ok(!f.sent[0].startsWith('已将'));
    assert.match(f.sent[0], failure === 'read' ? /未发送/ : failure === 'ONEBOT_TIMEOUT' ? /结果未知/ : /拒绝/);
  }
});

test('connection loss during privilege check prevents mutation and management obeys rate limits', async t => {
  let live = true;
  const f = fixture(t, { handler: async (action, params) => { live = false; return { ...params, role: 'owner' }; } });
  await f.bot.ingest(event(), f.api, () => live);
  assert.equal(f.calls.length, 1); assert.equal(f.sent.length, 0);
  const limited = fixture(t);
  for (let id = 1; id <= 5; id++) await limited.bot.ingest(event(undefined, { message_id: id }), limited.api);
  assert.equal(limited.calls.filter(call => call.action === 'set_group_ban').length, 3);
});

test('legacy controller outside chat whitelist receives management commands only and config defaults off', () => {
  const c = loadConfig({ ...env, PRIVATE_USER_QQS: '10000005' });
  assert.ok(parseEvent(event(), c, now));
  assert.equal(parseEvent(event('normal chat'), c, now), null);
  assert.equal(loadConfig({ ...env, GROUP_MANAGEMENT_ENABLED: '' }).groupManagementEnabled, false);
  assert.equal(loadConfig({ ...env, PRIVATE_USER_QQ: '' }).groupManagerId, '10000002');
  assert.throws(() => loadConfig({ ...env, GROUP_MANAGEMENT_ENABLED: 'yes' }), /GROUP_MANAGEMENT_ENABLED/);
});

test('mock OneBot WebSocket executes verified mute and sends only private acknowledgement', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let socket;
  const calls = [];
  server.on('connection', connection => {
    socket = connection;
    connection.on('message', raw => {
      const request = JSON.parse(raw); calls.push(request);
      const data = request.action === 'get_login_info' ? { user_id: 10000001 }
        : request.action === 'get_group_member_info' ? { ...request.params, role: request.params.user_id === 10000001 ? 'admin' : 'member' }
          : {};
      connection.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }));
    });
  });
  const c = loadConfig({ ...env, ONEBOT_WS_URL: `ws://127.0.0.1:${server.address().port}` });
  const store = new Store(), bot = new Bot(c, store, { complete: async () => { throw new Error('MODEL_NOT_ALLOWED'); } }, { now: () => now });
  const transport = new OneBot(c, { onEvent: (...args) => bot.ingest(...args) });
  t.after(async () => { transport.stop(); for (const client of server.clients) client.terminate(); await bot.tail; store.close(); await new Promise(resolve => server.close(resolve)); });
  const until = async predicate => { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) throw new Error('TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  transport.start(); await until(() => transport.ready);
  socket.send(JSON.stringify(event()));
  await until(() => calls.some(call => call.action === 'send_private_msg')); await bot.tail;
  assert.deepEqual(calls.map(call => call.action), ['get_login_info', 'get_group_member_info', 'get_group_member_info', 'set_group_ban', 'send_private_msg']);
  assert.deepEqual(calls[3].params, { group_id: 10000003, user_id: 10000004, duration: 600 });
  assert.equal(calls[4].params.user_id, 10000002);
  assert.deepEqual(store.history('private:10000002'), []);
});
