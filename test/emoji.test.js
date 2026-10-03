import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationText } from '../src/emoji.js';
import { Bot, parseEvent } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
const now = 1800000000000;
const config = { botId: '10000001', privateUser: '10000002', adminId: '10000002', groupId: '10000003',
  budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, maxOutput: 128, contextTokens: 16000,
  clearMs: 72 * 3600000, systemPrompt: '保持角色，按上下文回应用户的表情', blockTerms: [] };
const face = id => ({ type: 'face', data: { id } });
const text = value => ({ type: 'text', data: { text: value } });
function event(message, overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: 1, time: now / 1000, message, ...overrides };
}
function fixture(t, overrides = {}) {
  const store = new Store(), calls = [], sent = [];
  t.after(() => store.close());
  const bot = new Bot({ ...config, ...overrides }, store, { complete: async messages => {
    calls.push(messages); return { text: '怎么，笑得这么开心～', usage: { prompt_tokens: 30, completion_tokens: 10 } };
  } }, { now: () => now });
  return { store, bot, calls, sent, send: async (action, params) => sent.push(params.message[0].data.text) };
}
test('QQ faces become names in segment order; Unicode emoji and combined sequences remain intact', () => {
  assert.equal(conversationText([text('你好😂👩🏽‍💻'), face(14), face('5'), text('🥰')]),
    '你好😂👩🏽‍💻[QQ表情：微笑][QQ表情：流泪]🥰');
  assert.match(conversationText([face('9999')]), /名称未知/);
  assert.equal(conversationText([face('../secret'), face(null), face({}), face(-1), face(1.5), face('1\n'), null]), '');
});
test('face-only and Unicode-only messages invoke persona model, preserve context, budget and dedup', async t => {
  const f = fixture(t);
  await f.bot.ingest(event([face(14)]), f.send);
  await f.bot.ingest(event([face(14)]), f.send);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].at(-1).content, '[QQ表情：微笑]');
  assert.equal(f.calls[0][0].content, config.systemPrompt);
  await f.bot.ingest(event([text('😂👩🏽‍💻')], { message_id: 2 }), f.send);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].at(-1).content, '😂👩🏽‍💻');
  assert.equal(f.calls[1][1].content, '[QQ表情：微笑]');
  assert.equal(f.store.history('private:10000002').length, 4);
  assert.equal(f.store.balance(budgetDay(now), config.budgetMicro).used, 280);
});
test('group faces require mention, whitelist remains enforced and unknown faces receive a turn', async t => {
  const f = fixture(t);
  for (const overrides of [{ user_id: 10000004 }, { message_type: 'group', group_id: 10000003 },
    { message_type: 'group', group_id: 10000004 }]) {
    assert.equal(parseEvent(event([face(14)], overrides), config, now), null);
  }
  await f.bot.ingest(event([{ type: 'at', data: { qq: '10000001' } }, face('9999')],
    { message_type: 'group', group_id: 10000003 }), f.send);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].at(-1).content, /名称未知/);
});
test('blocked text split by faces stays blocked; paused and budget-exhausted bots never call model', async t => {
  for (const mode of ['block', 'pause', 'budget']) {
    const f = fixture(t, { blockTerms: ['禁止'], ...(mode === 'budget' ? { budgetMicro: 1 } : {}) });
    if (mode === 'pause') f.store.set('enabled', '0');
    await f.bot.ingest(event(mode === 'block' ? [text('禁'), face(14), text('止')] : [face(14)]), f.send);
    assert.equal(f.calls.length, 0); assert.equal(f.store.history('private:10000002').length, 0);
    if (mode === 'block') assert.equal(f.sent[0], '我是什么都不会告诉你的');
  }
});
