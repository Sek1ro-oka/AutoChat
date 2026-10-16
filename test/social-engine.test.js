import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, budgetDay } from '../src/store.js';
import { Ledger } from '../src/ledger.js';
import { Social } from '../src/social/engine.js';
import { applyParams } from '../src/social/params.js';
import { GROUP_KEYS } from '../src/group-settings.js';
import { GroupMemory } from '../src/social/memory.js';

// 2027-01-15 16:00 北京时间：白天、非节假日，所以时段只影响计价不影响决策。
const CLOCK = 1800000000000;

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

const REPLY = '我觉得二分就行。先说数据范围。';

function harness({ config = {}, reply = REPLY, model = null, ledger = false } = {}) {
  const store = new Store();
  const clock = { value: CLOCK };
  const calls = [];
  const sent = [];
  const fake = model ?? {
    calls,
    complete: async messages => {
      calls.push(messages);
      return { text: reply, usage: { prompt_tokens: 500, completion_tokens: 30 } };
    },
  };
  const send = async (action, params) => { sent.push({ action, params }); return { message_id: 9000 + sent.length }; };
  const social = new Social({
    config: makeConfig(config), store, model: fake, log: () => {},
    ledger: ledger ? new Ledger({ store }) : null,
    now: () => clock.value, random: () => 0, sleep: async () => {},
  });
  const event = (over = {}) => ({
    post_type: 'message', message_type: 'group', self_id: '10000',
    user_id: '30001', group_id: '20000', message_id: String(over.message_id ?? 1),
    time: Math.floor(clock.value / 1000),
    message: [{ type: 'text', data: { text: '随便说说' } }],
    ...over,
  });
  return { store, social, send, sent, calls, clock, event };
}

const texts = sent => sent.map(item => item.params.message[0].data.text);

test('group memory is seeded, bounded, labelled and echo-safe', () => {
  const store = new Store();
  const memory = new GroupMemory({ store, ttlMs: 3600000, now: () => CLOCK });

  store.noteMessage({ groupId: '20000', messageId: '1', userId: '30001', at: CLOCK - 1000, text: '最早的' });
  assert.deepEqual(memory.ring('20000').map(entry => entry.text), ['最早的']);
  assert.equal(memory.lookup('20000', '1').text, '最早的');
  assert.equal(memory.lookup('20000', '404'), null, 'an unknown quote is not invented');
  assert.deepEqual(
    [memory.label('20000', '30001'), memory.label('20000', '30002'), memory.label('20000', '30001')],
    ['群友1', '群友2', '群友1'], 'QQ numbers are relabelled and stay stable',
  );

  for (let index = 0; index < 30; index += 1) {
    memory.remember({ id: String(100 + index), group: '20000', user: '30001', at: CLOCK + index, text: `第${index}条` });
  }
  assert.equal(memory.ring('20000').length, 20, 'the ring is capped');
  assert.equal(memory.ring('20000').at(-1).text, '第29条');

  memory.remember({ id: '999', group: '90000', user: '10000', at: CLOCK + 100, text: '我说的话', fromBot: true });
  memory.remember({ id: '999', group: '90000', user: '10000', at: CLOCK + 105, text: '我说的话', fromBot: true });
  assert.equal(memory.ring('90000').length, 1, 'a self-echo is the same line, not a new one');
  memory.remember({ id: '1000', group: '90000', user: '30001', at: CLOCK + 106, text: '我说的话' });
  assert.equal(memory.ring('90000').length, 2, 'the same words from someone else are not');
  assert.equal(memory.isBotLine('90000', '999'), true);
  assert.equal(memory.isBotLine('90000', '1000'), false);
  assert.equal(memory.botTexts('90000', 5).length, 1);
  assert.equal(memory.active('90000', 120000), 2);
  store.close();
});

test('the simulation is inert until it is switched on', async () => {
  const { store, social, send, event, calls } = harness({ config: { socialEnabled: false } });
  assert.equal(await social.observe(event(), send, () => true), false);
  assert.equal(calls.length, 0);
  // Group text stays out of SQLite while the feature is off.
  assert.equal(store.recentMessages('20000').length, 0);
  assert.equal(store.listSimStates().length, 0);
  store.close();
});

test('a message below the threshold stays unanswered and costs nothing', async () => {
  const { store, social, send, event, calls } = harness();
  await social.observe(event({ message: [{ type: 'text', data: { text: '嗯' } }] }), send, () => true);
  assert.equal(calls.length, 0);
  assert.equal(store.recentMessages('20000').length, 1, 'the message itself is still recorded');
  assert.equal(store.getSimState('20000').state, 'observing');
  assert.equal(social.describe().groups[0].decision.reason, 'below_threshold');
  store.close();
});

test('a scored message is reserved, sampled, answered in bubbles and remembered', async () => {
  const { store, social, send, sent, calls, event } = harness({ ledger: true });
  social.setParams({ threshold: 0 });
  assert.equal(await social.observe(event(), send, () => true), true);

  assert.equal(calls.length, 1);
  assert.equal(sent.length, 2, 'one bubble per sentence');
  assert.equal(sent[0].action, 'send_group_msg');
  assert.deepEqual(texts(sent), ['我觉得二分就行。', '先说数据范围。']);
  assert.equal(sent[0].params.group_id, 20000);

  const day = budgetDay(CLOCK);
  const [charges] = store.chargeDays(1);
  assert.equal(charges.day, day);
  assert.equal(charges.calls, 1);
  assert.ok(charges.used > 0, 'settled against the shared daily ledger');
  assert.equal(charges.held, 0);
  const [sample] = store.recentSamples(5);
  assert.equal(sample.session, 'social:group:20000');
  assert.equal(sample.miss + sample.hit, 500);
  assert.equal(sample.out, 30);

  assert.equal(store.setting(`social_count:${day}:20000`), '1');
  assert.equal(store.getSimState('20000').state, 'probing');
  // Our own lines live in memory, not in the messages table.
  assert.equal(store.recentMessages('20000').length, 1);
  assert.equal(social.describe().groups[0].decision.reason, 'scored');
  store.close();
});

test('the daily counter is incremented through the store transaction, not a stale read', async () => {
  // Two different lines, so neither answer is dropped as a repeat of the last one.
  let answers = 0;
  const { store, social, send, sent, event, clock } = harness({
    model: {
      calls: [],
      complete: async () => {
        answers += 1;
        return { text: `第 ${answers} 句回复，措辞不同。`, usage: { prompt_tokens: 500, completion_tokens: 30 } };
      },
    },
  });
  social.setParams({ threshold: 0, cooldownSeconds: 5, dailyLimit: 20 });
  const day = budgetDay(CLOCK);
  const key = `social_count:${day}:20000`;

  const bumped = [];
  const originalBump = store.bump.bind(store);
  store.bump = (name, delta = 1) => { bumped.push([name, delta]); return originalBump(name, delta); };

  assert.equal(await social.observe(event({ message_id: 1 }), send, () => true), true);
  assert.deepEqual(bumped, [[key, 1]], 'the answer costs one bump of today key');
  assert.equal(store.setting(key), '1');
  assert.equal(social.spokeToday('20000', day), 1);

  clock.value += 60000;
  assert.equal(await social.observe(event({ message_id: 2 }), send, () => true), true);
  assert.equal(sent.length, 2, 'the second answer really went out');
  assert.deepEqual(bumped, [[key, 1], [key, 1]], 'every answer goes through Store#bump');
  assert.equal(store.setting(key), '2', 'the count is monotonic: +1 per answer, never reset');
  assert.equal(social.spokeToday('20000', day), 2);

  // With `bump` turned into a read that writes nothing, a third answer must
  // leave the stored count where it was: no other path writes this counter.
  store.bump = name => Number(store.setting(name, '0'));
  clock.value += 60000;
  assert.equal(await social.observe(event({ message_id: 3 }), send, () => true), true);
  assert.equal(sent.length, 3);
  assert.equal(store.setting(key), '2', 'bump is the only writer of the daily counter');
  store.close();
});

test('the cooldown, the daily cap and the switches each stop a scored message', async () => {
  const { store, social, send, event, calls, clock } = harness();
  social.setParams({ threshold: 0, dailyLimit: 20, cooldownSeconds: 45 });

  await social.observe(event({ message_id: 1 }), send, () => true);
  assert.equal(calls.length, 1);
  await social.observe(event({ message_id: 2 }), send, () => true);
  assert.equal(calls.length, 1);
  assert.equal(social.describe().groups[0].decision.reason, 'cooldown');

  social.setParams({ dailyLimit: 1 });        // the cap is now below today's count
  clock.value += 60000;
  await social.observe(event({ message_id: 3 }), send, () => true);
  assert.equal(calls.length, 1);
  assert.equal(social.describe().groups[0].decision.reason, 'daily_limit');

  social.setParams({ dailyLimit: 20, group: '20000', muted: true });
  clock.value += 60000;
  await social.observe(event({ message_id: 4 }), send, () => true);
  assert.equal(social.describe().groups[0].decision.reason, 'muted');

  social.setParams({ group: '20000', muted: false });
  store.set('groupEnabled', '0');
  await social.observe(event({ message_id: 5 }), send, () => true);
  assert.equal(social.describe().groups[0].decision.reason, 'group_off');

  store.set('groupEnabled', '1'); store.set('enabled', '0');
  await social.observe(event({ message_id: 6 }), send, () => true);
  assert.equal(social.describe().groups[0].decision.reason, 'disabled');
  assert.equal(calls.length, 1);
  store.close();
});

test('an exhausted budget blocks speech before the model is asked', async () => {
  const { store, social, send, event, calls } = harness({ config: { budgetMicro: 1 } });
  social.setParams({ threshold: 0 });
  await social.observe(event(), send, () => true);
  assert.equal(calls.length, 0);
  assert.equal(social.describe().groups[0].decision.reason, 'budget');
  store.close();
});

test('a message that addresses the bot is left to the answering path', async () => {
  const { store, social, send, sent, calls, event } = harness();
  social.setParams({ threshold: 0 });
  const addressed = event({ message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '在吗' } }] });
  assert.equal(await social.observe(addressed, send, () => true), false);
  assert.equal(calls.length, 0, 'never a second answer to one @');
  assert.equal(sent.length, 0);
  assert.equal(store.getSimState('20000').state, 'active', 'but it still counts as engagement');
  assert.equal(social.describe().groups[0].decision.reason, 'addressed_by_core');
  store.close();
});

test('the model may decline, and the turn is still accounted for', async () => {
  const { store, social, send, sent, event } = harness({ reply: '不回' });
  social.setParams({ threshold: 0 });
  assert.equal(await social.observe(event(), send, () => true), false);
  assert.equal(sent.length, 0);
  assert.equal(store.chargeDays(1)[0].calls, 1, 'the call happened and was settled');
  store.close();
});

test('repeating a line we just sent is dropped after rendering', async () => {
  const { store, social, send, sent, event, clock } = harness();
  social.setParams({ threshold: 0, cooldownSeconds: 5 });
  await social.observe(event({ message_id: 1 }), send, () => true);
  assert.equal(sent.length, 2);
  clock.value += 60000;
  assert.equal(await social.observe(event({ message_id: 2 }), send, () => true), false);
  assert.equal(sent.length, 2, 'nothing new was sent');
  store.close();
});

test('concurrent messages in one group are serialised into a single line', async () => {
  const { store, social, send, event, calls } = harness();
  social.setParams({ threshold: 0 });
  await Promise.all([
    social.observe(event({ message_id: 1 }), send, () => true),
    social.observe(event({ message_id: 2 }), send, () => true),
  ]);
  assert.equal(calls.length, 1, 'the second message hits the cooldown set by the first');
  store.close();
});

test('a failing model never escapes the participant and keeps the reservation', async () => {
  const model = { complete: async () => { throw new Error('boom'); } };
  const { store, social, send, sent, event } = harness({ model });
  social.setParams({ threshold: 0 });
  assert.equal(await social.observe(event(), send, () => true), false);
  assert.equal(sent.length, 0);
  const [charge] = store.chargeDays(1);
  assert.equal(charge.calls, 1);
  // Same policy as Q&A: an unanswered timeout may still be billed upstream, so
  // the reservation is kept rather than silently released.
  assert.equal(charge.used, 0);
  assert.ok(charge.held > 0, 'the uncertain reservation keeps holding budget');
  store.close();
});

test('a dead connection cancels the send but not the bookkeeping', async () => {
  const { store, social, send, sent, event } = harness();
  social.setParams({ threshold: 0 });
  assert.equal(await social.observe(event(), send, () => false), false);
  assert.equal(sent.length, 0);
  assert.equal(store.chargeDays(1)[0].calls, 1, 'the model call was already paid for');
  store.close();
});

test('the console view carries states and reasons, never chat text', async () => {
  const { store, social, send, event } = harness();
  social.setParams({ threshold: 0 });
  await social.observe(event({ message: [{ type: 'text', data: { text: '这句话不应该出现在控制台' } }] }), send, () => true);
  const view = social.describe({ now: CLOCK });
  assert.equal(JSON.stringify(view).includes('这句话不应该出现在控制台'), false);
  assert.equal(view.enabled, true);
  assert.equal(view.groups.length, 1);
  assert.equal(view.groups[0].decision.reasons.includes('base'), true);
  assert.deepEqual(Object.keys(view.params).sort(), ['cooldownSeconds', 'dailyLimit', 'idleEnabled', 'idleHours', 'idleMinutes', 'threshold']);
  store.close();
});

test('console parameters are validated and clamped to their documented ranges', () => {
  const { store, social } = harness();
  assert.throws(() => social.setParams({ threshold: 101 }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ cooldownSeconds: 1 }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ dailyLimit: 0 }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ enabled: 'yes' }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ group: '99999', muted: true }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ idleMinutes: 1 }), /SOCIAL_PARAM_INVALID/);
  assert.throws(() => social.setParams({ idleHours: '25-30' }), /SOCIAL_PARAM_INVALID/);
  const view = social.setParams({ enabled: true, threshold: 4, cooldownSeconds: 30, dailyLimit: 5 });
  assert.deepEqual(view.params, {
    threshold: 4, cooldownSeconds: 30, dailyLimit: 5,
    idleEnabled: false, idleMinutes: 45, idleHours: '0-23',
  });
  assert.equal(social.describe().enabled, true);
  store.close();
});

// --- I-01 D-06 / E-05: 群作用域写不进去的补丁不许沉默，写一半也不行 -------

// A store that records every operation, so "nothing was written" can be asserted
// as "no operation happened at all" rather than "the row I looked at is fine".
const spyStore = (rows = {}) => {
  const state = { rows: { ...rows }, ops: [] };
  return {
    get rows() { return state.rows; },
    get ops() { return state.ops; },
    setting: (key, fallback = null) => (key in state.rows ? state.rows[key] : fallback),
    set: (key, value) => { state.rows[key] = String(value); state.ops.push(`set ${key}=${value}`); },
    remove: key => { delete state.rows[key]; state.ops.push(`remove ${key}`); },
  };
};

test('a group-scoped patch that names only idle fields is refused, not dropped', () => {
  const config = makeConfig();
  const store = spyStore();
  const seen = [];
  const log = op => seen.push(op);

  assert.throws(
    () => applyParams({ store, config, group: '20000', patch: { idleMinutes: 60 }, log }),
    /SOCIAL_PARAM_NOT_GROUP_SCOPED/,
    '群作用域明确拒绝了：这是失败，不是「保存成功」',
  );
  assert.deepEqual(store.ops, [], '被拒绝的补丁一个操作都没有发生');
  assert.deepEqual(store.rows, {});

  // 真正的空操作：engine.setParams({group, muted}) 会把 numbers 变成 {} 传进来，那不是错误。
  seen.length = 0;
  assert.equal(applyParams({ store, config, group: '20000', patch: {}, log }), false);
  assert.deepEqual(seen, ['social_params_noop']);
  assert.deepEqual(store.ops, []);

  // 合法字段照旧写入，返回值语义不变。
  assert.equal(applyParams({ store, config, group: '20000', patch: { threshold: 30 }, log }), true);
  assert.deepEqual(store.rows, { [GROUP_KEYS.socialThreshold('20000')]: '30' });
  assert.deepEqual(store.ops, [`set ${GROUP_KEYS.socialThreshold('20000')}=30`]);
  assert.deepEqual(seen, ['social_params_noop', 'social_params_changed']);
});

test('a group patch that fails half way through leaves the earlier field untouched', () => {
  const config = makeConfig();
  const key = GROUP_KEYS.socialThreshold('20000');
  const store = spyStore({ [key]: '11' });
  const before = { ...store.rows };

  // threshold 合法、cooldownSeconds 非法：旧实现会先把 threshold 写成 0 再抛错。
  assert.throws(
    () => applyParams({ store, config, group: '20000', patch: { threshold: 0, cooldownSeconds: 0 } }),
    /SOCIAL_PARAM_INVALID/,
  );
  assert.deepEqual(store.rows, before, 'store 与调用前逐字节一致');
  assert.deepEqual(store.ops, [], '校验阶段失败时没有任何写操作');
  assert.equal(store.setting(key), '11', '阈值没有被写成 0');

  // 同一个补丁把非法项改对，就应该整体成功。
  assert.equal(applyParams({ store, config, group: '20000', patch: { threshold: 0, cooldownSeconds: 45 } }), true);
  assert.equal(store.setting(key), '0');
  assert.equal(store.setting(GROUP_KEYS.socialCooldown('20000')), '45');
});

test('setParams still returns its describe view and only mutes when asked', () => {
  const { store, social } = harness();
  const view = social.setParams({ group: '20000', muted: true });
  assert.equal(Array.isArray(view.groups), true, '返回类型必须是 describe() 视图');
  assert.equal(view.params.threshold, 6);
  assert.equal(store.setting('social_mute:20000', 'absent'), '1');
  assert.throws(() => social.setParams({ group: '20000', idleMinutes: 60 }), /SOCIAL_PARAM_NOT_GROUP_SCOPED/);
  assert.equal(store.setting(GROUP_KEYS.socialThreshold('20000'), 'absent'), 'absent', '群作用域被拒绝后没有顺手写别的');
  store.close();
});
