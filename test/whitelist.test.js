import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { parseEvent, Bot } from '../src/bot.js';
import { Store } from '../src/store.js';

function config() {
  return loadConfig({ BOT_QQ: '10000001', PRIVATE_USER_QQS: '10000002,10000004,10000004',
    GROUP_QQ: '10000005', ADMIN_QQ: '10000002', ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test',
    PRICE_INPUT_CNY_PER_MILLION: '2', PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-02' });
}
function event(user, groupId) {
  return { post_type: 'message', message_type: groupId ? 'group' : 'private',
    self_id: 10000001, user_id: user, group_id: groupId, message_id: user, time: 1800000000,
    message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: 'hello' } }] };
}

test('multiple private users are deduplicated, authorized and isolated', async t => {
  const c = config(); assert.deepEqual(c.privateUsers, ['10000002', '10000004']);
  const store = new Store(); t.after(() => store.close());
  const requests = [], sent = [];
  const bot = new Bot(c, store, { complete: async messages => {
    requests.push(messages); return { text: 'answer', usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } }, { now: () => 1800000000000 });
  for (const id of [10000002, 10000004]) await bot.ingest(event(id), async (...args) => sent.push(args));
  assert.equal(requests.length, 2); assert.ok(requests.every(messages => messages.length === 2));
  assert.equal(store.history('private:10000002').length, 2);
  assert.equal(store.history('private:10000004').length, 2);
  assert.equal(parseEvent(event(10000006), c, 1800000000000), null);
});

test('replacement group accepts new group and rejects removed group', () => {
  const c = config();
  assert.ok(parseEvent(event(10000004, 10000005), c, 1800000000000));
  assert.equal(parseEvent(event(10000004, 10000003), c, 1800000000000), null);
});
