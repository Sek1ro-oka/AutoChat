import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { RULE_REPLY } from '../src/terms.js';

const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03',
  BLOCK_TERMS: '禁词,BLOCK', TRIGGER_TERMS: '暗号,SECRET' };
function fixture(t, overrides = {}, answer = '正常回答') {
  const config = loadConfig({ ...env, ...overrides }), store = new Store();
  t.after(() => store.close());
  let calls = 0;
  const sent = [], requests = [];
  const bot = new Bot(config, store, { complete: async messages => {
    calls++;
    requests.push(messages);
    return { text: answer, usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } }, { now: () => now });
  return { config, store, bot, sent, requests, calls: () => calls,
    send: async (action, params) => sent.push({ action, params }) };
}
function event(text, overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001,
    user_id: 10000002, message_id: 1, time: now / 1000,
    message: [{ type: 'text', data: { text } }], ...overrides };
}

test('input blocks refuse and trigger keywords echo without model, history or charges', async t => {
  for (const [text, expected] of [['包含禁词的问题', RULE_REPLY], ['请给我暗号', '暗号'],
    ['a secret question', 'SECRET'], ['a block question', RULE_REPLY]]) {
    const f = fixture(t);
    await f.bot.ingest(event(text), f.send);
    await f.bot.ingest(event(text), f.send);
    assert.equal(f.calls(), 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].params.message[0].data.text, expected);
    assert.deepEqual(f.store.history('private:10000002'), []);
    assert.deepEqual(f.store.balance(budgetDay(now), f.config.budgetMicro),
      { used: 0, held: 0, remaining: f.config.budgetMicro });
  }
});

test('group rules require mention by default and optional unmentioned matching stays in allowed group', async t => {
  const group = { message_type: 'group', group_id: 10000003, user_id: 10000004 };
  const defaultBot = fixture(t);
  await defaultBot.bot.ingest(event('暗号', group), defaultBot.send);
  assert.equal(defaultBot.sent.length, 0);
  await defaultBot.bot.ingest(event('暗号', { ...group, message_id: 2,
    message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: '暗号' } }] }), defaultBot.send);
  assert.equal(defaultBot.sent[0].params.message[0].data.text, '暗号');

  const f = fixture(t, { GROUP_KEYWORD_WITHOUT_AT: 'true' });
  await f.bot.ingest(event('暗号', group), f.send);
  await f.bot.ingest(event('禁词', { ...group, message_id: 2 }), f.send);
  await f.bot.ingest(event('暗号', { ...group, group_id: 10000005 }), f.send);
  await f.bot.ingest(event('普通群消息', { ...group, message_id: 3 }), f.send);
  await f.bot.ingest(event('暗号', { user_id: 10000005 }), f.send);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(item => item.action === 'send_group_msg' && item.params.group_id === 10000003));
  assert.equal(f.calls(), 0);
});

test('rules respect disabled replies and rate limits', async t => {
  const f = fixture(t);
  f.store.set('enabled', '0');
  await f.bot.ingest(event('暗号'), f.send);
  assert.equal(f.sent.length, 0);
  f.store.set('enabled', '1');
  for (let id = 2; id <= 6; id++) await f.bot.ingest(event('暗号', { message_id: id }), f.send);
  assert.equal(f.sent.filter(item => item.params.message[0].data.text === '暗号').length, 2);
  assert.equal(f.calls(), 0);
});

test('output block terms use fixed reply and retain actual cost; trigger terms are input-only', async t => {
  const blocked = fixture(t, {}, '返回了禁词');
  await blocked.bot.ingest(event('普通问题'), blocked.send);
  assert.equal(blocked.sent[0].params.message[0].data.text, RULE_REPLY);
  assert.equal(blocked.calls(), 1);
  assert.equal(blocked.store.balance(budgetDay(now), blocked.config.budgetMicro).used, 10);
  assert.deepEqual(blocked.store.history('private:10000002'), []);
  const triggered = fixture(t, {}, '返回了暗号');
  await triggered.bot.ingest(event('普通问题'), triggered.send);
  assert.equal(triggered.sent[0].params.message[0].data.text, '返回了暗号');
});

test('empty terms leave normal questions enabled and malformed group option is rejected', async t => {
  const f = fixture(t, { BLOCK_TERMS: ' , ', TRIGGER_TERMS: '' });
  await f.bot.ingest(event('普通问题'), f.send);
  assert.equal(f.calls(), 1);
  assert.throws(() => loadConfig({ ...env, GROUP_KEYWORD_WITHOUT_AT: 'yes' }), /GROUP_KEYWORD_WITHOUT_AT/);
});

test('block takes priority and multiple triggers use configured order', async t => {
  const f = fixture(t);
  await f.bot.ingest(event('暗号里面包含禁词'), f.send);
  await f.bot.ingest(event('SECRET以及暗号', { message_id: 2 }), f.send);
  assert.equal(f.sent[0].params.message[0].data.text, RULE_REPLY);
  assert.equal(f.sent[1].params.message[0].data.text, '暗号');
  assert.equal(f.calls(), 0);
});

test('blocked and triggered turns preserve existing history and never reach later model context in private or group', async t => {
  for (const group of [false, true]) {
    for (const ruleText of ['包含禁词的这一整条消息', '包含暗号的这一整条消息']) {
      const f = fixture(t);
      const user = group ? 10000004 : 10000002;
      const key = group ? 'group:10000003:10000004' : 'private:10000002';
      const makeEvent = (text, messageId) => event(text, {
        user_id: user, message_id: messageId, message_type: group ? 'group' : 'private',
        ...(group ? { group_id: 10000003,
          message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text } }] } : {}),
      });
      await f.bot.ingest(makeEvent('此前的正常问题', 1), f.send);
      const previous = f.store.history(key);
      assert.equal(previous.length, 2);
      await f.bot.ingest(makeEvent(ruleText, 2), f.send);
      assert.equal(f.calls(), 1);
      assert.deepEqual(f.store.history(key), previous);
      await f.bot.ingest(makeEvent('后续的正常问题', 3), f.send);
      assert.equal(f.calls(), 2);
      assert.deepEqual(f.requests[1].slice(1, -1), previous);
      for (const messages of f.requests) {
        assert.ok(messages.every(item => !item.content.includes(ruleText) && !item.content.includes(RULE_REPLY)));
      }
      assert.ok(f.store.history(key).every(item => !item.content.includes(ruleText) && !item.content.includes(RULE_REPLY)));
    }
  }
});
