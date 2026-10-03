import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Model } from '../src/model.js';
import { Bot } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { searchQuery, searchSources } from '../src/search.js';

const now = 1800000000000;
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03', WEB_SEARCH_ENABLED: 'true' };
function event(text, overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: 1, time: now / 1000, message: [{ type: 'text', data: { text } }], ...overrides };
}
function fixture(t, overrides = {}, result = {}) {
  const c = loadConfig({ ...env, ...overrides }), store = new Store(), calls = [], sent = [];
  t.after(() => store.close());
  const bot = new Bot(c, store, { complete: async (messages, options) => {
    calls.push({ messages, options });
    if (result.error) throw result.error;
    return { text: '检索回答', usage: { prompt_tokens: 100, completion_tokens: 10 }, searchVerified: true,
      sources: [{ title: '官方资料', url: 'https://example.com/doc' }], ...result };
  } }, { now: () => now });
  return { c, store, bot, calls, sent, send: async (action, params) => sent.push(params.message[0].data.text) };
}

test('search is explicit, source blocks are verified and URLs are deduplicated', () => {
  assert.equal(searchQuery('/搜索 天气'), '天气');
  assert.equal(searchQuery('帮我联网搜索 新消息'), '新消息');
  assert.equal(searchQuery('/搜索'), '');
  assert.equal(searchQuery('今天的新闻'), null);
  assert.deepEqual(searchSources([{ type: 'text', text: 'https://fake.test' }]), []);
  assert.equal(searchSources([{ type: 'web_search_tool_result', content: [
    { type: 'web_search_result', url: 'https://example.com', title: 'OK' },
    { type: 'web_search_result', url: 'https://example.com/' },
    { type: 'web_search_result', url: 'javascript:alert(1)' },
    { type: 'web_search_result', url: 'https://user:secret@example.com' },
  ] }]).length, 1);
});

test('model search HTTP sends query only, excludes history and persona, and counts cached tokens', async t => {
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/anthropic/v1/messages');
    assert.equal(req.headers['x-api-key'], 'test-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.deepEqual(body.messages, [{ role: 'user', content: '公开查询' }]);
    assert.ok(!JSON.stringify(body).includes('PRIVATE_HISTORY'));
    assert.ok(!JSON.stringify(body).includes('PRIVATE_PERSONA'));
    assert.equal(body.tools[0].max_uses, 1);
    res.end(JSON.stringify({ content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com', title: '资料' }] },
      { type: 'text', text: '有依据的答复' },
    ], usage: { input_tokens: 10, cache_creation_input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 5 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const model = new Model({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', model: 'deepseek-flash', maxOutput: 128, timeoutMs: 1000 });
  const result = await model.complete([{ role: 'system', content: 'PRIVATE_PERSONA' }, { role: 'user', content: 'PRIVATE_HISTORY' }], { search: true, query: '公开查询' });
  assert.equal(result.searchVerified, true);
  assert.deepEqual(result.usage, { prompt_tokens: 15, completion_tokens: 5 });
});

test('search command appends sources, charges budget and persists count across bot restarts', async t => {
  const f = fixture(t, { WEB_SEARCH_DAILY_LIMIT: '1' });
  await f.bot.ingest(event('/搜索 官方资料'), f.send);
  await f.bot.ingest(event('/搜索 官方资料'), f.send);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].options, { search: true, query: '官方资料' });
  assert.match(f.sent[0], /搜索来源/); assert.match(f.sent[0], /https:\/\/example.com\/doc/);
  assert.equal(f.store.balance(budgetDay(now), f.c.budgetMicro).used, 280);
  assert.equal(f.store.history('private:10000002').length, 2);
  const nextBot = new Bot(f.c, f.store, { complete: async () => { throw new Error('NOT_ALLOWED'); } }, { now: () => now });
  await nextBot.ingest(event('/搜索 其他问题', { message_id: 2 }), f.send);
  assert.match(f.sent[1], /次数已用完/);
});

test('blocked query, paused bot, disabled search, empty query and exhausted budget do not search', async t => {
  for (const variant of ['block', 'pause', 'off', 'empty', 'budget']) {
    const f = fixture(t, { BLOCK_TERMS: '禁词', ...(variant === 'off' ? { WEB_SEARCH_ENABLED: 'false' } : {}),
      ...(variant === 'budget' ? { DAILY_BUDGET_CNY: '0.000001' } : {}) });
    if (variant === 'pause') f.store.set('enabled', '0');
    await f.bot.ingest(event(variant === 'block' ? '/搜索 禁词' : variant === 'empty' ? '/搜索' : '/搜索 新闻'), f.send);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.history('private:10000002').length, 0);
  }
});

test('missing search evidence never passes a fabricated answer; failed requests retain reservations', async t => {
  const missing = fixture(t, {}, { text: '编造联网结果', searchVerified: false });
  await missing.bot.ingest(event('/搜索 新闻'), missing.send);
  assert.match(missing.sent[0], /没有获得可核查/); assert.ok(!missing.sent[0].includes('编造联网结果'));
  assert.equal(missing.store.history('private:10000002').length, 0);
  const failed = fixture(t, {}, { error: new Error('SECRET_RESPONSE') });
  await failed.bot.ingest(event('/搜索 新闻'), failed.send);
  assert.match(failed.sent[0], /搜索暂时不可用/); assert.ok(!failed.sent[0].includes('SECRET_RESPONSE'));
  assert.ok(failed.store.balance(budgetDay(now), failed.c.budgetMicro).held > 0);
});

test('plain conversation remains normal and unmentioned groups cannot bypass trigger rules with a search command', async t => {
  const f = fixture(t);
  await f.bot.ingest(event('普通问题'), f.send);
  assert.deepEqual(f.calls[0].options, {});
  assert.ok(!f.sent[0].includes('搜索来源'));
  await f.bot.ingest(event('/搜索 问题', { message_type: 'group', group_id: 10000003, message_id: 2 }), f.send);
  assert.equal(f.calls.length, 1);
});
