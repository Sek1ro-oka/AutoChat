import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Bot } from '../src/bot.js';
import { Model } from '../src/model.js';
import { Store, budgetDay } from '../src/store.js';
import { loadConfig } from '../src/config.js';
const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQS: '10000002,10000004', ADMIN_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'DEFAULT_SECRET', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03', MODEL_PROFILES: 'alt',
  MODEL_ALT_NAME: 'other-model', MODEL_ALT_BASE_URL: 'https://provider.example/v1', MODEL_ALT_API_KEY: 'ALT_SECRET',
  MODEL_ALT_PRICE_INPUT_CNY_PER_MILLION: '20', MODEL_ALT_PRICE_OUTPUT_CNY_PER_MILLION: '80',
  MODEL_ALT_PRICE_VERIFIED_DATE: '2026-10-03', WEB_SEARCH_ENABLED: 'true', VISION_ENABLED: 'true' };
function event(text, overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: 1, time: now / 1000, message: [{ type: 'text', data: { text } }], ...overrides };
}
function fixture(t, overrides = {}) {
  const config = loadConfig({ ...env, ...overrides }), store = new Store(), calls = [], sent = [];
  t.after(() => store.close());
  const complete = id => async messages => {
    calls.push({ id, messages }); return { text: '回复', usage: { prompt_tokens: 100, completion_tokens: 10 } };
  };
  const model = { complete: complete('default'), forProfile: p => ({ complete: complete(p.id) }) };
  const bot = new Bot(config, store, model, { now: () => now });
  return { config, store, calls, sent, model, bot, send: async (action, params) => sent.push(params.message[0].data.text) };
}
test('profiles validate endpoints, credentials, prices, IDs, flags and image reserve without exposing keys', () => {
  const config = loadConfig(env);
  assert.deepEqual(config.modelProfiles.map(p => p.id), ['default','alt']);
  assert.equal(config.modelProfiles[1].sendThinking, false);
  for (const override of [{ MODEL_ALT_API_KEY: '' }, { MODEL_ALT_BASE_URL: 'http://provider.example' },
    { MODEL_ALT_BASE_URL: 'https://user:secret@provider.example' }, { MODEL_ALT_PRICE_INPUT_CNY_PER_MILLION: '' },
    { MODEL_PROFILES: 'alt,alt' }, { MODEL_PROFILES: 'default' }, { MODEL_ALT_SUPPORTS_SEARCH: 'yes' },
    { MODEL_ALT_SUPPORTS_VISION: 'true', MODEL_ALT_IMAGE_INPUT_RESERVE_TOKENS: '' }]) {
    assert.throws(() => loadConfig({ ...env, ...override }), error => !error.message.includes('ALT_SECRET'));
  }
});
test('only private admin lists/selects models; switch persists across restart without changing budget', async t => {
  const f = fixture(t);
  await f.bot.ingest(event('/模型列表'), f.send);
  assert.match(f.sent[0], /other-model/); assert.ok(!f.sent[0].includes('SECRET'));
  await f.bot.ingest(event('/切换模型 alt', { message_id: 2 }), f.send);
  assert.equal(f.store.setting('active_model'), 'alt'); assert.equal(f.calls.length, 0);
  const next = new Bot(f.config, f.store, f.model, { now: () => now });
  await next.ingest(event('你好', { message_id: 3 }), f.send);
  assert.equal(f.calls[0].id, 'alt');
  assert.equal(f.store.balance(budgetDay(now), f.config.budgetMicro).used, 2800);
  const other = fixture(t);
  await other.bot.ingest(event('/切换模型 alt', { user_id: 10000004 }), other.send);
  await other.bot.ingest(event('/切换模型 alt', { message_type: 'group', group_id: 10000003, message_id: 2,
    message: [{ type: 'at', data: { qq: '10000001' } }, { type: 'text', data: { text: '/切换模型 alt' } }] }), other.send);
  assert.equal(other.store.setting('active_model'), null); assert.equal(other.calls.length, 0);
});
test('different profiles isolate histories, clear only selected context, and removed selection returns to default', async t => {
  const f = fixture(t);
  f.store.save('private:10000002', 'private', [{ role: 'user', content: 'OLD_PROVIDER_HISTORY' }, { role: 'assistant', content: 'answer' }]);
  f.store.set('active_model', 'alt');
  await f.bot.ingest(event('新模型问题'), f.send);
  assert.ok(!JSON.stringify(f.calls[0].messages).includes('OLD_PROVIDER_HISTORY'));
  assert.equal(f.store.history('private:10000002:model:alt').length, 2);
  await f.bot.ingest(event('/清空', { message_id: 2 }), f.send);
  assert.equal(f.store.history('private:10000002:model:alt').length, 0);
  assert.equal(f.store.history('private:10000002').length, 2);
  f.store.set('active_model', 'removed');
  new Bot(f.config, f.store, f.model, { now: () => now });
  assert.equal(f.store.setting('active_model'), 'default');
});
test('unsupported vision/search is rejected without model fees; auto-search falls back to text-only model', async t => {
  const f = fixture(t, { WEB_SEARCH_AUTO_ENABLED: 'true' }); f.store.set('active_model', 'alt');
  await f.bot.ingest(event('', { message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] }), f.send);
  await f.bot.ingest(event('/搜索 天气', { message_id: 2 }), f.send);
  assert.equal(f.calls.length, 0); assert.equal(f.store.balance(budgetDay(now), f.config.budgetMicro).used, 0);
  await f.bot.ingest(event('北京天气', { message_id: 3 }), f.send);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].id, 'alt');
});
test('model sends chosen endpoint/key/name and omits vendor-specific thinking for other providers', async t => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer ALT_SECRET');
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks)); assert.equal(body.model,'other-model'); assert.equal(body.thinking,undefined);
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
  }).listen(0,'127.0.0.1');
  await once(server,'listening'); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const c=loadConfig(env), p={ ...c.modelProfiles[1], baseUrl:`http://127.0.0.1:${server.address().port}/v1` };
  const result=await new Model(c).forProfile(p).complete([{ role:'user',content:'hello' }]); assert.equal(result.text,'ok');
});
test('group profile history keeps group cleanup deadline and expensive model obeys shared budget before calling', async t => {
  const f=fixture(t); f.store.set('active_model','alt');
  await f.bot.ingest(event('群问题',{ message_type:'group',group_id:10000003,
    message:[{type:'at',data:{qq:'10000001'}},{type:'text',data:{text:'群问题'}}] }),f.send);
  assert.equal(f.calls[0].id,'alt'); assert.equal(f.store.history('group:10000003:10000002:model:alt').length,2);
  f.store.cleanupGroups(now+f.config.clearMs,f.config.clearMs);
  assert.equal(f.store.history('group:10000003:10000002:model:alt').length,0);
  const low=fixture(t,{DAILY_BUDGET_CNY:'0.001'}); low.store.set('active_model','alt');
  await low.bot.ingest(event('贵模型问题'),low.send);
  assert.equal(low.calls.length,0); assert.match(low.sent[0],/预算不足/);
});
