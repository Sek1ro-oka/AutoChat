import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { loadConfig } from '../src/config.js';
const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03', GROUP_ADMIN_COMMANDS_ENABLED: 'true' };
function event(text = '禁言 10000006 5', overrides = {}) {
  return { post_type: 'message', message_type: 'group', self_id: 10000001, user_id: 10000004,
    group_id: 10000003, message_id: 1, time: now / 1000,
    message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text } }], ...overrides };
}
function fixture(t, { config = {}, senderRole = 'admin', botRole = 'admin', targetRole = 'member', handler } = {}) {
  const c = loadConfig({ ...env, ...config }), store = new Store(), calls = [], sent = [];
  t.after(() => store.close());
  const bot = new Bot(c, store, { complete: async () => assert.fail('No model for management') }, { now: () => now });
  const api = async (action, params) => {
    if (action === 'send_group_msg' || action === 'send_private_msg') { sent.push(params.message[0].data.text); return {}; }
    calls.push({ action, params });
    if (handler) return handler(action, params);
    return action === 'get_group_member_info' ? { ...params,
      role: params.user_id === 10000001 ? botRole : params.user_id === 10000006 ? targetRole : senderRole } : {};
  };
  return { c, store, bot, api, calls, sent };
}
test('group admin and owner can mute with live checks, dedup, no private whitelist, no AI budget or history', async t => {
  for (const senderRole of ['admin', 'owner']) {
    const f = fixture(t, { senderRole }); f.store.set('enabled', '0'); f.store.set('groupEnabled', '0');
    await f.bot.ingest(event(), f.api); await f.bot.ingest(event(), f.api);
    assert.deepEqual(f.calls.map(c => c.action), ['get_group_member_info', 'get_group_member_info', 'get_group_member_info', 'set_group_ban']);
    assert.deepEqual(f.calls.slice(0,3).map(c => c.params.user_id), [10000004,10000001,10000006]);
    assert.ok(f.calls.slice(0,3).every(c => c.params.no_cache));
    assert.equal(f.calls.at(-1).params.duration, 300); assert.match(f.sent[0], /已将/);
    assert.equal(f.store.history('group:10000003:10000004').length, 0);
    assert.equal(f.store.balance(budgetDay(now), f.c.budgetMicro).used, 0);
  }
});
test('member pretending to be admin and private controller without group rank cannot mute', async t => {
  for (const user_id of [10000004, 10000002]) {
    const f = fixture(t, { senderRole: 'member' });
    await f.bot.ingest(event(undefined, { user_id, sender: { role: 'owner' } }), f.api);
    assert.equal(f.calls.length, 1); assert.match(f.sent[0], /仅限本群管理员/);
  }
});
test('disabled mode, unlisted groups, missing structured bot mention and invalid mixed commands never mute', async t => {
  const off = fixture(t, { config: { GROUP_ADMIN_COMMANDS_ENABLED: 'false' } });
  await off.bot.ingest(event(), off.api); assert.equal(off.calls.length, 0); assert.match(off.sent[0], /已关闭/);
  const f = fixture(t, { config: { GROUP_KEYWORD_WITHOUT_AT: 'true', TRIGGER_TERMS: '禁言' } });
  await f.bot.ingest(event(undefined, { group_id: 10000009 }), f.api);
  await f.bot.ingest(event(undefined, { message: [{ type: 'text', data: { text: '禁言 10000006 5' } }] }), f.api);
  await f.bot.ingest(event(undefined, { message_id: 2, message: [...event().message, { type: 'face', data: { id: 14 } }] }), f.api);
  assert.equal(f.calls.length, 0); assert.match(f.sent[0], /必须明确/); assert.match(f.sent[1], /用法/);
});
test('invalid duration or target never reaches APIs; slash and minute suffix are accepted', async t => {
  for (const text of ['禁言 10000006 0', '禁言 10000006 43201', '禁言 10000006 1.5',
    '禁言 10000006 -5', '禁言 abc 5', '禁言 10000006 5 多余']) {
    const f = fixture(t); await f.bot.ingest(event(text), f.api); assert.equal(f.calls.length, 0); assert.match(f.sent[0], /用法/);
  }
  const f = fixture(t); await f.bot.ingest(event('/禁言 10000006 5分钟'), f.api);
  assert.equal(f.calls.at(-1).params.duration, 300);
  assert.throws(() => loadConfig({ ...env, GROUP_ADMIN_COMMANDS_ENABLED: 'yes' }));
});
test('protected targets, missing bot rank, wrong identity, read failure and disconnect prevent mutation', async t => {
  for (const variant of ['owner', 'admin', 'bot_member', 'identity', 'read_error', 'disconnect']) {
    let alive = true;
    const f = fixture(t, { handler: async (action, params) => {
      assert.equal(action, 'get_group_member_info');
      if (variant === 'read_error') throw new Error('FAILED');
      if (variant === 'disconnect') alive = false;
      return { ...params, group_id: variant === 'identity' ? 10000009 : params.group_id,
        role: params.user_id === 10000001 ? (variant === 'bot_member' ? 'member' : 'admin')
          : params.user_id === 10000006 ? variant : 'admin' };
    } });
    await f.bot.ingest(event(), f.api, () => alive);
    assert.ok(!f.calls.some(c => c.action === 'set_group_ban'));
  }
});
test('mute failure is not retried or reported successful; rate limit blocks fourth command', async t => {
  const f = fixture(t, { handler: async (action, params) => {
    if (action === 'set_group_ban') throw new Error('ONEBOT_TIMEOUT');
    return { ...params, role: params.user_id === 10000006 ? 'member' : 'admin' };
  } });
  await f.bot.ingest(event(), f.api); await f.bot.ingest(event(), f.api);
  assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 1);
  assert.match(f.sent[0], /结果未知/); assert.ok(!f.sent[0].includes('已将'));
  for (let id = 2; id <= 4; id++) await f.bot.ingest(event(undefined, { message_id: id }), f.api);
  assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 3); assert.match(f.sent.at(-1), /较频繁/);
});
test('bot owner may mute admin targets, bot admin may not, and owner targets remain protected', async t => {
  const ownerBot = fixture(t, { botRole: 'owner', targetRole: 'admin' });
  await ownerBot.bot.ingest(event(), ownerBot.api);
  assert.equal(ownerBot.calls.filter(c => c.action === 'set_group_ban').length, 1);
  assert.match(ownerBot.sent[0], /已将/);
  for (const roles of [{ botRole: 'admin', targetRole: 'admin' }, { botRole: 'owner', targetRole: 'owner' }]) {
    const f = fixture(t, roles); await f.bot.ingest(event(), f.api);
    assert.ok(!f.calls.some(c => c.action === 'set_group_ban'));
  }
});
test('group admins can unmute through omitted minutes or explicit slash/non-slash command', async t => {
  for (const text of ['禁言 10000006', '解除禁言 10000006', '/解除禁言 10000006', '/禁言 10000006']) {
    const f = fixture(t); await f.bot.ingest(event(text), f.api); await f.bot.ingest(event(text), f.api);
    const bans = f.calls.filter(c => c.action === 'set_group_ban');
    assert.equal(bans.length, 1); assert.equal(bans[0].params.duration, 0);
    assert.match(f.sent[0], /已解除/); assert.equal(f.store.history('group:10000003:10000004').length, 0);
    assert.equal(f.store.balance(budgetDay(now), f.c.budgetMicro).used, 0);
  }
});
test('unmute enforces caller and target hierarchy and rejects extra duration on explicit unmute', async t => {
  for (const roles of [{ senderRole: 'member' }, { targetRole: 'admin' }, { targetRole: 'owner', botRole: 'owner' }]) {
    const f = fixture(t, roles); await f.bot.ingest(event('解除禁言 10000006'), f.api);
    assert.ok(!f.calls.some(c => c.action === 'set_group_ban'));
  }
  const owner = fixture(t, { botRole: 'owner', targetRole: 'admin' });
  await owner.bot.ingest(event('解除禁言 10000006'), owner.api);
  assert.equal(owner.calls.at(-1).params.duration, 0);
  const invalid = fixture(t); await invalid.bot.ingest(event('解除禁言 10000006 5'), invalid.api);
  assert.equal(invalid.calls.length, 0); assert.match(invalid.sent[0], /用法/);
});
function mentionCommand(command, minutes) {
  return [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: ` ${command} ` } },
    { type: 'at', data: { qq: '10000006' } }, ...(minutes === undefined ? [] : [{ type: 'text', data: { text: ` ${minutes}` } }])];
}
test('structured target mentions support mute and both unmute forms using actual QQ ID', async t => {
  for (const [command, minutes, duration] of [['禁言', '5', 300], ['禁言', undefined, 0], ['解除禁言', undefined, 0]]) {
    const f = fixture(t); const message = mentionCommand(command, minutes);
    await f.bot.ingest(event('', { message }), f.api); await f.bot.ingest(event('', { message }), f.api);
    assert.deepEqual(f.calls.at(-1).params, { group_id: 10000003, user_id: 10000006, duration });
    assert.equal(f.calls.filter(c => c.action === 'set_group_ban').length, 1);
    assert.equal(f.store.history('group:10000003:10000004').length, 0);
  }
});
test('ambiguous targets, @all, literal nickname and extra bot mention never reach mutation APIs', async t => {
  const base = mentionCommand('禁言', '5');
  for (const message of [
    [...base, { type: 'at', data: { qq: '10000008' } }],
    base.map(item => item.type === 'at' && item.data.qq === '10000006' ? { type: 'at', data: { qq: 'all' } } : item),
    [...base, { type: 'at', data: { qq: '10000001' } }],
    [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: '禁言 @张三 5' } }],
    [...base, { type: 'text', data: { text: ' 10000008' } }],
  ]) {
    const f = fixture(t); await f.bot.ingest(event('', { message }), f.api);
    assert.equal(f.calls.length, 0); assert.match(f.sent[0], /用法/);
  }
});
