import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Social } from '../src/social/engine.js';

// 2027-01-15 16:00 北京时间（hour = 16）。
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

function harness({ config = {}, reply = '来冒个泡。' } = {}) {
  const store = new Store();
  const clock = { value: CLOCK };
  const sent = [];
  const model = { complete: async () => ({ text: reply, usage: { prompt_tokens: 200, completion_tokens: 10 } }) };
  const send = async (action, params) => { sent.push({ action, params }); return { message_id: 9000 + sent.length }; };
  const social = new Social({
    config: makeConfig(config), store, model, log: () => {},
    now: () => clock.value, random: () => 0, sleep: async () => {},
  });
  return { store, social, send, sent, clock };
}

test('idleAllowed honours a start-end hour window inclusively', () => {
  const { social } = harness();
  assert.equal(social.idleAllowed(9, '9-22'), true);
  assert.equal(social.idleAllowed(16, '9-22'), true);
  assert.equal(social.idleAllowed(22, '9-22'), true);
  assert.equal(social.idleAllowed(23, '9-22'), false);
  assert.equal(social.idleAllowed(8, '9-22'), false);
  assert.equal(social.idleAllowed(16, 'bogus'), false);
});

test('idleTick stays silent while the switch is off', async () => {
  const { store, social, send, sent } = harness();
  store.noteMessage({ groupId: '20000', messageId: '1', userId: '30001', at: CLOCK - 60 * 60000, text: '旧消息' });
  await social.idleTick(send, () => true);
  assert.equal(sent.length, 0);
});

test('idleTick speaks once after the silence threshold, then keeps the cooldown', async () => {
  const { store, social, send, sent } = harness({ config: { socialIdleEnabled: true } });
  store.noteMessage({ groupId: '20000', messageId: '1', userId: '30001', at: CLOCK - 60 * 60000, text: '旧消息' });
  await social.idleTick(send, () => true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.message[0].type, 'text');
  // 发言已记入 lastSpokeAt，紧接着再扫不应再冒泡（冷却 + 静默重置）。
  await social.idleTick(send, () => true);
  assert.equal(sent.length, 1);
});

test('idleTick respects the hour window and the mute switch', async () => {
  const { store, social, send, sent } = harness({ config: { socialIdleEnabled: true, socialIdleHours: '0-8' } });
  store.noteMessage({ groupId: '20000', messageId: '1', userId: '30001', at: CLOCK - 60 * 60000, text: '旧消息' });
  await social.idleTick(send, () => true);
  assert.equal(sent.length, 0, 'outside the allowed window');

  const muted = harness({ config: { socialIdleEnabled: true, socialIdleHours: '0-23' } });
  muted.store.set('social_mute:20000', '1');
  muted.store.noteMessage({ groupId: '20000', messageId: '1', userId: '30001', at: CLOCK - 60 * 60000, text: '旧消息' });
  await muted.social.idleTick(muted.send, () => true);
  assert.equal(muted.sent.length, 0, 'muted groups never idle-speak');
});
