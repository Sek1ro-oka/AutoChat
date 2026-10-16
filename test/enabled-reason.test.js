// Why the bot stopped (I-03 · Phase A · D-19). `/状态` used to answer 「停止」 for
// every cause: an operator's `/停止`, and the breaker tripping after three failed
// sends, looked identical — and the counter behind the breaker lives in memory,
// so a restart erased the only evidence there was. The reason is now written at
// the moment the decision is made, so it outlives the process that made it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQS: '10000002', ADMIN_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'SECRET', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03' };

function fixture(t) {
  const config = loadConfig(env), store = new Store(), logs = [], sent = [];
  t.after(() => store.close());
  let messageId = 0;
  const event = text => ({ post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: (messageId += 1), time: now / 1000, message: [{ type: 'text', data: { text } }] });
  // `boot()` stands in for a process restart: same database, fresh memory.
  const boot = () => new Bot(config, store, { complete: async () => ({ text: 'x', usage: {} }) },
    { now: () => now, log: (name, detail) => logs.push({ name, detail }) });
  return { store, logs, sent, event, boot, send: async (action, params) => sent.push(params.message[0].data.text) };
}

test('a meltdown and an admin stop are told apart, and both outlive a restart', async t => {
  const { store, logs, sent, event, boot, send } = fixture(t);
  const bot = boot();
  const failing = async () => { throw new Error('transport is gone'); };
  const target = { action: 'send_private_msg', target: { user_id: 10000002 } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await bot.reply(target, 'hi', failing, () => true), false);
  }
  // The breaker tripped, and now it says why.
  assert.equal(store.setting('enabled'), '0');
  assert.equal(store.setting('enabled_reason'), 'send_failures');
  assert.deepEqual(logs.filter(entry => entry.name === 'send_failed').map(entry => entry.detail),
    [{ failures: 1 }, { failures: 2 }, { failures: 3 }]);

  const restarted = boot();
  await restarted.ingest(event('/状态'), send);
  assert.match(sent.at(-1), /回复：停止（连续发送失败已自动熔断）/);

  await restarted.ingest(event('/启动'), send);
  assert.equal(store.setting('enabled'), '1');
  assert.equal(store.setting('enabled_reason'), '', 'a cleared reason may not stay behind as a stale one');
  await restarted.ingest(event('/状态'), send);
  assert.match(sent.at(-1), /回复：启用/);

  await restarted.ingest(event('/停止'), send);
  assert.equal(store.setting('enabled_reason'), 'admin_stop');
  assert.match(sent.at(-1), /已停止模型回复。/);
  const third = boot();
  await third.ingest(event('/状态'), send);
  assert.match(sent.at(-1), /回复：停止（管理员停止）/);

  // An installation that stopped before reasons existed: say so rather than
  // inventing a cause for it.
  store.remove('enabled_reason');
  await third.ingest(event('/状态'), send);
  assert.match(sent.at(-1), /回复：停止（原因未知（可能是旧版本遗留））/);
});

test('the group switch keeps a reason of its own', async t => {
  const { store, sent, event, boot, send } = fixture(t);
  const bot = boot();
  await bot.ingest(event('/群关闭'), send);
  assert.equal(store.setting('groupEnabled'), '0');
  assert.equal(store.setting('groupEnabled_reason'), 'admin_stop');
  assert.equal(store.setting('enabled'), null, 'the group switch never touches the global one');
  await bot.ingest(event('/群开启'), send);
  assert.equal(store.setting('groupEnabled'), '1');
  assert.equal(store.setting('groupEnabled_reason'), '');
  assert.match(sent.at(-1), /已启用群回复。/);
});
