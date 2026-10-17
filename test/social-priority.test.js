import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Social } from '../src/social/engine.js';
import {
  BURST_WINDOW_MS, PRIORITY, priorityOf, reasonOf, shouldUpgrade,
} from '../src/social/priority.js';

// 2027-01-15 16:00 北京时间。The clock is injected everywhere, so no case below
// ever waits on a real 2000 ms window.
const CLOCK = 1800000000000;

const makeConfig = overrides => ({
  botId: '10000', groupId: '20000', groupIds: ['20000'],
  socialEnabled: true, socialThreshold: 0, socialCooldownSeconds: 45, socialDailyLimit: 20,
  socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
  socialMessageTtlMs: 24 * 3600000, botName: '小助手', botNicknames: [],
  socialIdleEnabled: false, socialIdleMinutes: 45, socialIdleHours: '0-23',
  blockTerms: [], budgetMicro: 1000000, maxOutput: 1024,
  inputPrice: 2, outputPrice: 8, cacheHitPrice: null, offPeakRatio: 0.5, costHolidays: [],
  systemPrompt: '内置人设',
  ...overrides,
});

function harness(config = {}) {
  const store = new Store();
  const clock = { value: CLOCK };
  const calls = [];
  const sent = [];
  const logs = [];
  const model = {
    calls,
    // A distinct line per call: repeating ourselves is a separate rule
    // (attention.js `isRepeat`) and would hide what these cases are about.
    complete: async messages => {
      calls.push(messages);
      return { text: `第${calls.length}句回答。`, usage: { prompt_tokens: 500, completion_tokens: 30 } };
    },
  };
  const send = async (action, params) => { sent.push({ action, params }); return { message_id: 9000 + sent.length }; };
  const social = new Social({
    config: makeConfig(config), store, model,
    log: (event, detail) => logs.push({ event, detail }),
    now: () => clock.value, random: () => 0, sleep: async () => {},
  });
  const event = (over = {}) => ({
    post_type: 'message', message_type: 'group', self_id: '10000',
    user_id: '30001', group_id: '20000', message_id: String(over.message_id ?? 1),
    time: Math.floor(clock.value / 1000),
    message: [{ type: 'text', data: { text: '随便说说' } }],
    ...over,
  });
  const say = (text, over = {}) => social.observe(
    event({ ...over, message: [{ type: 'text', data: { text } }] }), send, () => true,
  );
  return { social, clock, calls, sent, logs, say, event, send };
}

// --- the table ---------------------------------------------------------------

test('the priority table is a frozen, finite, integer enum', () => {
  assert.ok(Object.isFrozen(PRIORITY));
  assert.deepEqual({ ...PRIORITY }, { addressed: 4, reply: 3, name: 2, question: 2, others: 1, base: 1 });
  for (const value of Object.values(PRIORITY)) assert.ok(Number.isInteger(value));
  assert.equal(BURST_WINDOW_MS, 2000, 'the window is a constant, not a config key');
});

test('the highest tier among the reasons wins', () => {
  assert.equal(priorityOf([]), PRIORITY.base, 'no reasons still means plain chatter');
  assert.equal(priorityOf(['base']), PRIORITY.base);
  assert.equal(priorityOf(['base', 'others']), PRIORITY.others);
  assert.equal(priorityOf(['base', 'question']), PRIORITY.question);
  assert.equal(priorityOf(['base', 'question', 'name']), PRIORITY.name);
  assert.equal(priorityOf(['base', 'others', 'reply']), PRIORITY.reply);
  assert.equal(priorityOf(['base', 'addressed']), PRIORITY.addressed, 'an @ is the top tier');
});

test('suppressors never take part in the ordering', () => {
  // `activity` is an environment reading; `night` and `repeat` only subtract.
  // If any of them ranked, a quiet night would outrank a direct question.
  assert.equal(priorityOf(['base', 'activity', 'night', 'repeat']), PRIORITY.base);
  assert.equal(priorityOf(['activity']), PRIORITY.base, 'a lone suppressor still means base');
  assert.equal(reasonOf(['base', 'night', 'repeat', 'question']), 'question');
});

test('an unknown reason counts as base and is reported, never silently ranked', () => {
  const unknown = [];
  assert.equal(priorityOf(['base', 'nonsense'], reason => unknown.push(reason)), PRIORITY.base);
  assert.deepEqual(unknown, ['nonsense']);
  assert.equal(priorityOf(['base', 'reply', 'nonsense'], () => {}), PRIORITY.reply, 'it cannot demote a real tier');
  assert.equal(priorityOf('base'), PRIORITY.base, 'a non-array is treated as no reasons at all');
});

test('only a strictly higher priority upgrades', () => {
  assert.equal(shouldUpgrade(PRIORITY.base, PRIORITY.question), true);
  assert.equal(shouldUpgrade(PRIORITY.question, PRIORITY.question), false, 'the same thing said twice is not an upgrade');
  assert.equal(shouldUpgrade(PRIORITY.reply, PRIORITY.base), false);
});

test('reasonOf names the reason that carried the tier', () => {
  assert.equal(reasonOf(['base']), 'base');
  assert.equal(reasonOf(['base', 'question']), 'question');
  assert.equal(reasonOf(['base', 'question', 'name']), 'question', 'the first reason at that tier wins');
  assert.equal(reasonOf(undefined), 'base');
});

// --- the window --------------------------------------------------------------
// `arbitrate` is the whole mechanism: pure modulo `this.burst`, no timers.

test('inside the window an equal priority is dropped and recorded', () => {
  const { social, logs } = harness();
  assert.equal(social.arbitrate('20000', ['base', 'activity'], CLOCK, true).speak, true, 'the window is empty');

  social.burst.set('20000', { at: CLOCK, priority: PRIORITY.base, reason: 'base' });
  const verdict = social.arbitrate('20000', ['base', 'activity'], CLOCK + 1500, true);
  assert.equal(verdict.speak, false);
  const suppressed = logs.find(item => item.event === 'social_suppressed');
  assert.deepEqual(suppressed.detail, {
    group: '20000', keptReason: 'base', droppedReason: 'base',
    keptPriority: PRIORITY.base, droppedPriority: PRIORITY.base,
  });
});

test('a strictly higher priority takes the slot inside the window', () => {
  const { social, logs } = harness();
  social.burst.set('20000', { at: CLOCK, priority: PRIORITY.base, reason: 'base' });
  const verdict = social.arbitrate('20000', ['base', 'question'], CLOCK + 1500, true);
  assert.equal(verdict.speak, true);
  assert.equal(verdict.priority, PRIORITY.question);
  assert.equal(logs.filter(item => item.event === 'social_suppressed').length, 0, 'nothing was dropped');
});

test('the window expires by timestamp, with no timer to clear', () => {
  const { social } = harness();
  social.burst.set('20000', { at: CLOCK, priority: PRIORITY.question, reason: 'question' });
  assert.equal(social.arbitrate('20000', ['base'], CLOCK + BURST_WINDOW_MS - 1, true).speak, false, 'still inside');
  assert.equal(social.arbitrate('20000', ['base'], CLOCK + BURST_WINDOW_MS, true).speak, true, 'exactly at the edge');
  assert.equal(social.burst.has('20000'), false, 'the stale slot is dropped when it is seen');
});

test('windows are per group', () => {
  const { social } = harness();
  social.burst.set('20000', { at: CLOCK, priority: PRIORITY.question, reason: 'question' });
  assert.equal(social.arbitrate('20000', ['base'], CLOCK + 1, true).speak, false);
  assert.equal(social.arbitrate('30000', ['base'], CLOCK + 1, true).speak, true, 'another group has its own slot');
});

test('a message the gates refused is never reported as a window drop', () => {
  const { social, logs } = harness();
  social.burst.set('20000', { at: CLOCK, priority: PRIORITY.base, reason: 'base' });
  assert.equal(social.arbitrate('20000', ['base'], CLOCK + 1, false).speak, false);
  assert.equal(logs.filter(item => item.event === 'social_suppressed').length, 0);
});

// --- wired into the engine ---------------------------------------------------

test('a higher-priority question preempts the cooldown it would otherwise hit', async () => {
  const { social, clock, calls, sent, say } = harness();
  assert.equal(await say('随便说说'), true, 'the first line goes out');
  assert.equal(sent.length, 1);

  // One second later the cooldown would normally refuse; the window is open and
  // the newcomer is a question, so it upgrades.
  clock.value += 1000;
  assert.equal(await say('这个怎么算？', { message_id: 2 }), true);
  assert.equal(sent.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(social.describe().groups[0].decision.speak, true);
});

test('an equal-priority message one second later is suppressed, not queued', async () => {
  const { social, clock, calls, sent, logs, say } = harness();
  assert.equal(await say('随便说说'), true);
  clock.value += 1000;

  assert.equal(await say('今天打本吗', { message_id: 2 }), false);
  assert.equal(sent.length, 1, 'nothing was sent twice');
  assert.equal(calls.length, 1, 'and no second model call was paid for');
  assert.ok(logs.some(item => item.event === 'social_suppressed'));

  const decision = social.describe().groups[0].decision;
  assert.equal(decision.speak, false, 'the console records that we did not speak');
  assert.equal(decision.reason, 'cooldown', 'the gate still owns the reason vocabulary');
});

test('the burst window is over by the time a later message arrives', async () => {
  const { social, clock, sent, say } = harness();
  assert.equal(await say('随便说说'), true);
  clock.value += BURST_WINDOW_MS;
  assert.equal(await say('今天打本吗', { message_id: 2 }), true, 'the same priority speaks again');
  assert.equal(sent.length, 2);
});

test('an @ bypasses the window and takes it', async () => {
  const { social, clock, sent, event, send } = harness();
  assert.equal(await social.observe(event(), send, () => true), true);
  clock.value += 500;

  const addressed = await social.observe(
    event({ message_id: 2, message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '在吗' } }] }),
    send, () => true,
  );
  assert.equal(addressed, false, 'the answering path owns an @, the simulation stays quiet');
  assert.deepEqual(social.burst.get('20000'), { at: clock.value, priority: PRIORITY.addressed, reason: 'addressed' });
  assert.equal(sent.length, 1, 'and it did not speak over it');
});

test('a blocked topic drops a would-be upgrade without a window record', async () => {
  const { social, clock, calls, sent, logs, say } = harness({ blockTerms: ['代练'] });
  assert.equal(await say('随便说说'), true);
  clock.value += 1000;

  assert.equal(await say('这个代练怎么算？', { message_id: 2 }), false);
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(social.describe().groups[0].decision.reason, 'blocked', 'the gate is the reason, not the window');
  assert.equal(logs.filter(item => item.event === 'social_suppressed').length, 0);
});
