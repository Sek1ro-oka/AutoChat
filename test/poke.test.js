import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { Store, budgetDay } from '../src/store.js';
import { Poke, POKE_MODES } from '../src/poke.js';
import { createRuntimeConfig, applyRuntimeValue, runtimeValues } from '../src/runtime-config.js';

// 2027-01-15 16:00 in Beijing. A fixed clock makes the cooldown, the echo window
// and the UTC+8 day bucket all predictable; nothing here waits on real time.
const CLOCK = 1800000000000;
const SELF = '10000';
const GROUP = '20000';
const PEER = '30001';
const OTHER = '30002';
const DAY = budgetDay(CLOCK);

function makeConfig(overrides = {}) {
  return {
    botId: SELF, groupId: GROUP, groupIds: [GROUP],
    pokeEnabled: true, pokeMode: 'reply', pokeCooldownSeconds: 30, pokeDailyLimit: 20,
    pokeReplyText: '别戳啦',
    ...overrides,
  };
}

// `writes` records every `set` / `bump` / `remove`, so "off means no store traffic"
// is asserted on calls rather than on a key prefix a typo could dodge.
function harness({ overrides = {}, transport = null } = {}) {
  const store = new Store();
  const writes = [];
  for (const method of ['set', 'bump', 'remove']) {
    const original = store[method].bind(store);
    store[method] = (...args) => { writes.push({ method, key: args[0] }); return original(...args); };
  }
  const clock = { value: CLOCK };
  const sent = [];
  const logs = [];
  const config = makeConfig(overrides);
  const poke = new Poke({
    config, store, now: () => clock.value,
    log: (event, detail) => logs.push({ event, detail }),
  });
  // The real `send` is `OneBot.call`, which answers `null` for `send_poke`.
  const call = async (action, params) => {
    sent.push({ action, params });
    return transport ? transport(action, params) : null;
  };
  const notice = (o = {}) => ({
    time: Math.floor(clock.value / 1000), self_id: SELF, post_type: 'notice',
    notice_type: 'notify', sub_type: 'poke', group_id: Number(GROUP),
    user_id: Number(PEER), target_id: Number(SELF), ...o,
  });
  const privateNotice = (o = {}) => {
    const event = notice(o);
    delete event.group_id;
    return event;
  };
  return {
    store, writes, clock, sent, logs, poke, call, notice, privateNotice,
    advance: ms => { clock.value += ms; },
    events: () => logs.map(entry => entry.event),
    counts: () => writes.filter(write => write.method === 'bump').map(write => write.key),
    text: () => [{ type: 'text', data: { text: '别戳啦' } }],
  };
}

test('the mode list is the documented one', () => {
  assert.deepEqual([...POKE_MODES], ['off', 'reply', 'active']);
});

// --- the switches -------------------------------------------------------------

test('POKE_ENABLED=false sends nothing, writes nothing, logs nothing', async () => {
  const h = harness({ overrides: { pokeEnabled: false, pokeMode: 'active' } });
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.equal(await h.poke.observe(h.privateNotice(), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.logs, []);
});

test('a bot stopped from the console does not answer a poke either', async () => {
  const h = harness();
  h.store.set('enabled', '0');
  h.writes.length = 0;
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
});

test('mode off is silent even with the master switch on', async () => {
  const h = harness({ overrides: { pokeMode: 'off' } });
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.equal(await h.poke.observe(h.privateNotice(), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
});

test('only a notify/poke notice for this account is a poke', async () => {
  const h = harness();
  const cases = [
    { post_type: 'message', message_type: 'group', self_id: SELF, user_id: Number(PEER) },
    h.notice({ sub_type: 'shake' }),
    h.notice({ notice_type: 'group_increase' }),
    h.notice({ self_id: '99999' }),
    h.notice({ user_id: 'not-a-number' }),
    h.notice({ target_id: undefined }),
    null,
    'poke',
  ];
  for (const event of cases) assert.equal(await h.poke.observe(event, h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
});

// --- reply mode ---------------------------------------------------------------

test('reply mode answers a group poke at the bot with one text message', async () => {
  const h = harness();
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.deepEqual(h.sent, [{
    action: 'send_group_msg', params: { group_id: Number(GROUP), message: h.text() },
  }]);
  assert.deepEqual(h.counts(), [`poke_count:${DAY}:group:${GROUP}`]);
  assert.deepEqual(h.logs.at(-1), { event: 'poke_handled', detail: { mode: 'reply', scope: 'group' } });
});

test('reply mode answers a private poke on the private channel', async () => {
  const h = harness();
  assert.equal(await h.poke.observe(h.privateNotice(), h.call), true);
  assert.deepEqual(h.sent, [{
    action: 'send_private_msg', params: { user_id: Number(PEER), message: h.text() },
  }]);
  assert.deepEqual(h.counts(), [`poke_count:${DAY}:private:${PEER}`]);
});

test('reply mode never calls a poke action', async () => {
  const h = harness();
  await h.poke.observe(h.notice(), h.call);
  await h.advance(31000);
  await h.poke.observe(h.privateNotice(), h.call);
  assert.deepEqual(h.sent.map(item => item.action), ['send_group_msg', 'send_private_msg']);
});

test('a poke that does not aim at the bot is ignored in a group', async () => {
  const h = harness({ overrides: { pokeMode: 'active' } });
  assert.equal(await h.poke.observe(h.notice({ user_id: Number(OTHER), target_id: 30003 }), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
});

test('an empty reply text in reply mode says nothing and counts nothing', async () => {
  const h = harness({ overrides: { pokeReplyText: '' } });
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
});

// --- active mode --------------------------------------------------------------

test('active mode pokes back, naming the poker and the group', async () => {
  const h = harness({ overrides: { pokeMode: 'active' } });
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.deepEqual(h.sent.map(item => item.action), ['send_group_msg', 'send_poke']);
  assert.deepEqual(h.sent[1].params, { group_id: Number(GROUP), user_id: Number(PEER) });
});

test('active mode in private chat uses the private poke packet', async () => {
  const h = harness({ overrides: { pokeMode: 'active' } });
  await h.poke.observe(h.privateNotice(), h.call);
  assert.deepEqual(h.sent.map(item => item.action), ['send_private_msg', 'send_poke']);
  assert.deepEqual(h.sent[1].params, { user_id: Number(PEER) });
});

test('active mode with no text still pokes back', async () => {
  const h = harness({ overrides: { pokeMode: 'active', pokeReplyText: '' } });
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.deepEqual(h.sent.map(item => item.action), ['send_poke']);
});

// --- the echo of our own poke ------------------------------------------------

test('our own poke echoed as user_id === self_id does not excite', async () => {
  const h = harness({ overrides: { pokeMode: 'active' } });
  assert.equal(await h.poke.observe(h.notice({ user_id: Number(SELF), target_id: Number(PEER) }), h.call), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.logs, [{ event: 'poke_self_echo', detail: { shape: 'poker' } }]);
});

test('the echoed poke does not excite, and the guard expires after ten seconds', async () => {
  const h = harness({ overrides: { pokeMode: 'active', pokeCooldownSeconds: 5 } });
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.equal(h.sent.length, 2);
  h.advance(6000); // cooldown is over, the ten-second echo window is not
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.logs.filter(entry => entry.event === 'poke_self_echo'),
    [{ event: 'poke_self_echo', detail: { shape: 'target' } }]);
  h.advance(5000); // eleven seconds later this is a real second poke
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.equal(h.sent.length, 4);
});

test('an outgoing poke is forgotten once the echo window closes', async () => {
  const h = harness({ overrides: { pokeMode: 'active', pokeCooldownSeconds: 5 } });
  await h.poke.observe(h.notice(), h.call);
  assert.equal(h.poke.outgoing.size, 1);
  h.advance(11000);
  await h.poke.observe(h.notice(), h.call);
  assert.equal(h.poke.outgoing.size, 1);
});

// --- limits -------------------------------------------------------------------

test('the per-user cooldown blocks the second poke and then expires', async () => {
  const h = harness();
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  h.advance(29000);
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.logs.at(-1),
    { event: 'poke_rate_limited', detail: { reason: 'cooldown', scope: 'group' } });
  h.advance(1000);
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.equal(h.sent.length, 2);
});

test('the cooldown is per user: another member is still answered', async () => {
  const h = harness();
  await h.poke.observe(h.notice(), h.call);
  assert.equal(await h.poke.observe(h.notice({ user_id: Number(OTHER) }), h.call), true);
  assert.equal(h.sent.length, 2);
});

test('the daily cap is per group and stops further answers', async () => {
  const h = harness({ overrides: { pokeDailyLimit: 2 } });
  for (const user of [PEER, OTHER, '30003']) {
    await h.poke.observe(h.notice({ user_id: Number(user) }), h.call);
  }
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.counts(), [`poke_count:${DAY}:group:${GROUP}`, `poke_count:${DAY}:group:${GROUP}`]);
  assert.equal(h.store.setting(`poke_count:${DAY}:group:${GROUP}`), '2');
  assert.deepEqual(h.logs.at(-1),
    { event: 'poke_rate_limited', detail: { reason: 'daily', scope: 'group' } });
});

test('private pokes are counted per user, not against a group', async () => {
  const h = harness({ overrides: { pokeDailyLimit: 1 } });
  assert.equal(await h.poke.observe(h.privateNotice(), h.call), true);
  h.advance(31000);
  assert.equal(await h.poke.observe(h.privateNotice(), h.call), false);
  assert.equal(await h.poke.observe(h.privateNotice({ user_id: Number(OTHER) }), h.call), true);
  assert.equal(h.store.setting(`poke_count:${DAY}:private:${PEER}`), '1');
  assert.equal(h.store.setting(`poke_count:${DAY}:private:${OTHER}`), '1');
});

test('the daily cap also bounds send_poke in active mode', async () => {
  const h = harness({ overrides: { pokeDailyLimit: 1, pokeMode: 'active' } });
  await h.poke.observe(h.notice(), h.call);
  h.advance(31000);
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.equal(h.sent.filter(item => item.action === 'send_poke').length, 1);
});

// --- failure handling ---------------------------------------------------------

test('a failed reply is logged once and never retried', async () => {
  const h = harness({ transport: () => { throw new Error('ONEBOT_ACTION_FAILED'); } });
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.logs.find(entry => entry.event === 'poke_reply_failed'),
    { event: 'poke_reply_failed', detail: { name: 'Error', message: 'ONEBOT_ACTION_FAILED' } });
  assert.equal(h.logs.filter(entry => entry.event === 'poke_reply_failed').length, 1);
});

test('a failed poke action is logged once and never retried', async () => {
  const h = harness({
    overrides: { pokeMode: 'active' },
    transport: action => { if (action === 'send_poke') throw new Error('ONEBOT_ACTION_FAILED'); return null; },
  });
  assert.equal(await h.poke.observe(h.notice(), h.call), true);
  assert.deepEqual(h.sent.map(item => item.action), ['send_group_msg', 'send_poke']);
  assert.equal(h.logs.filter(entry => entry.event === 'poke_action_failed').length, 1);
  assert.deepEqual(h.logs.find(entry => entry.event === 'poke_action_failed').detail,
    { name: 'Error', message: 'ONEBOT_ACTION_FAILED' });
});

test('a dead socket is skipped before anything is counted', async () => {
  const h = harness();
  assert.equal(await h.poke.observe(h.notice(), h.call, () => false), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.logs, [{ event: 'poke_skipped_offline', detail: { scope: 'group' } }]);
});

test('a broken store is contained and reported, not thrown at the runtime', async () => {
  const h = harness();
  h.store.setting = () => { throw new Error('SQLITE_BUSY'); };
  assert.equal(await h.poke.observe(h.notice(), h.call), false);
  assert.deepEqual(h.logs, [{ event: 'poke_failed', detail: { name: 'Error', message: 'SQLITE_BUSY' } }]);
});

// --- configuration and runtime fields ----------------------------------------

test('all five knobs are runtime fields, so the settings page renders them', () => {
  const store = new Store();
  const config = createRuntimeConfig(makeConfig({ pokeEnabled: false, pokeReplyText: '' }), store);
  const view = runtimeValues(config, store);
  assert.ok(view.groups.some(group => group.id === 'poke'));
  const fields = view.fields.filter(field => field.group === 'poke');
  assert.deepEqual(fields.map(field => field.name),
    ['pokeEnabled', 'pokeMode', 'pokeCooldownSeconds', 'pokeDailyLimit', 'pokeReplyText']);
  assert.deepEqual(fields.map(field => field.value), ['false', 'reply', '30', '20', '']);
  assert.deepEqual(fields.map(field => field.kind), ['boolean', 'enum', 'integer', 'integer', 'string']);
  assert.deepEqual(fields[1].options, ['off', 'reply', 'active']);
});

test('a console edit applies to the next poke without a restart', async () => {
  const store = new Store();
  const config = createRuntimeConfig(makeConfig({ pokeEnabled: false }), store);
  const clock = { value: CLOCK };
  const sent = [];
  const poke = new Poke({ config, store, now: () => clock.value, log: () => {} });
  const call = async (action, params) => { sent.push({ action, params }); return null; };
  const notice = () => ({
    self_id: SELF, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: Number(GROUP), user_id: Number(PEER), target_id: Number(SELF),
  });
  assert.equal(await poke.observe(notice(), call), false);
  applyRuntimeValue(config, store, 'pokeEnabled', 'true');
  assert.equal(await poke.observe(notice(), call), true);
  applyRuntimeValue(config, store, 'pokeMode', 'off');
  clock.value += 31000;
  assert.equal(await poke.observe(notice(), call), false);
  applyRuntimeValue(config, store, 'pokeMode', 'active');
  clock.value += 31000;
  assert.equal(await poke.observe(notice(), call), true);
  assert.deepEqual(sent.map(item => item.action), ['send_group_msg', 'send_group_msg', 'send_poke']);
  applyRuntimeValue(config, store, 'pokeDailyLimit', '1');
  clock.value += 31000;
  assert.equal(await poke.observe(notice(), call), false);
});

test('the environment defaults match the documented ones', () => {
  const env = {
    BOT_QQ: '10000001', PRIVATE_USER_QQS: '10000002', GROUP_QQ: '10000005', ADMIN_QQ: '10000002',
    ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
    PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-02',
  };
  const config = loadConfig(env);
  assert.equal(config.pokeEnabled, false);
  assert.equal(config.pokeMode, 'reply');
  assert.equal(config.pokeCooldownSeconds, 30);
  assert.equal(config.pokeDailyLimit, 20);
  assert.equal(config.pokeReplyText, '');
  assert.equal(config.pokeMode, 'reply'); // mode is independent of the switch
  const on = loadConfig({ ...env, POKE_ENABLED: 'true', POKE_MODE: 'active', POKE_REPLY_TEXT: '  嘿  ' });
  assert.equal(on.pokeEnabled, true);
  assert.equal(on.pokeMode, 'active');
  assert.equal(on.pokeReplyText, '嘿');
});

test('bad poke settings fail the boot with the offending name', () => {
  const env = {
    BOT_QQ: '10000001', PRIVATE_USER_QQS: '10000002', GROUP_QQ: '10000005', ADMIN_QQ: '10000002',
    ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
    PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-02',
  };
  assert.throws(() => loadConfig({ ...env, POKE_ENABLED: 'yes' }), /POKE_ENABLED/);
  assert.throws(() => loadConfig({ ...env, POKE_MODE: 'loud' }), /POKE_MODE/);
  assert.throws(() => loadConfig({ ...env, POKE_COOLDOWN_SECONDS: '4' }), /POKE_COOLDOWN_SECONDS/);
  assert.throws(() => loadConfig({ ...env, POKE_COOLDOWN_SECONDS: '3601' }), /POKE_COOLDOWN_SECONDS/);
  assert.throws(() => loadConfig({ ...env, POKE_DAILY_LIMIT: '0' }), /POKE_DAILY_LIMIT/);
  assert.throws(() => loadConfig({ ...env, POKE_DAILY_LIMIT: '201' }), /POKE_DAILY_LIMIT/);
  assert.throws(() => loadConfig({ ...env, POKE_REPLY_TEXT: '字'.repeat(201) }), /POKE_REPLY_TEXT/);
  assert.throws(() => loadConfig({ ...env, POKE_MODE: 'off', POKE_ENABLED: 'maybe' }), /POKE_ENABLED/);
});
