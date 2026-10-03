import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Bot } from '../src/bot.js';
import { Store, budgetDay } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { Model } from '../src/model.js';
import { imageUrl, imageData, loadImages, MAX_IMAGE_BYTES } from '../src/vision.js';
const now = 1800000000000;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = { type: 'image', data: { file: 'qq.png', url: 'https://gchat.qpic.cn/a' } };
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'test', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03', VISION_ENABLED: 'true' };
function event(text = '', overrides = {}) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: 1, time: now / 1000, message: [{ type: 'text', data: { text } }, image], ...overrides };
}
function fixture(t, overrides = {}, loaderError = false) {
  const c = loadConfig({ ...env, ...overrides }), store = new Store(), calls = [], sent = [], loads = [];
  t.after(() => store.close());
  const bot = new Bot(c, store, { complete: async (messages, options) => {
    calls.push({ messages, options }); return { text: '图片是蓝色圆形', usage: { prompt_tokens: 800, completion_tokens: 30 } };
  } }, { now: () => now, imageLoader: async segments => {
    loads.push(segments); if (loaderError) throw new Error('PRIVATE_URL'); return [imageData(png)];
  } });
  return { c, store, bot, calls, sent, loads, send: async (action, params) => sent.push(params.message[0].data.text) };
}
test('QQ CDN restriction, MIME detection and bounded streaming downloads', async () => {
  for (const url of ['file:///C:/private.png', 'https://127.0.0.1/a', 'http://gchat.qpic.cn/a',
    'https://gchat.qpic.cn.evil.test/a', 'https://user:secret@gchat.qpic.cn/a']) assert.throws(() => imageUrl(url));
  assert.throws(() => imageData(Buffer.from('not an image')));
  const calls = [];
  const result = await loadImages([image], () => assert.fail(), async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual'); return new Response(png);
  });
  assert.equal(result[0], imageData(png)); assert.equal(calls.length, 1);
  await assert.rejects(loadImages([image], () => {}, async () => new Response(null,
    { status: 302, headers: { location: 'https://127.0.0.1/private' } })));
  await assert.rejects(loadImages([image], () => {}, async () => new Response(png,
    { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } })));
  await assert.rejects(loadImages([image], () => {}, async () => new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1))));
  const fallback = await loadImages([{ type: 'image', data: { file: 'qq.png' } }], async (action, params) => {
    assert.equal(action, 'get_image'); assert.equal(params.file, 'qq.png'); return { url: image.data.url, file: 'C:/do-not-read' };
  }, async () => new Response(png)); assert.equal(fallback.length, 1);
  await assert.rejects(loadImages([{ data: { file: 'C:/private.png' } }], () => assert.fail()));
});
test('vision model sends current user image blocks without mutating text history', async t => {
  const messages = [{ role: 'system', content: '角色' }, { role: 'user', content: '识图' }];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.deepEqual(body.messages[1].content, [{ type: 'text', text: '识图' },
      { type: 'image_url', image_url: { url: imageData(png), detail: 'original' } }]);
    assert.equal(body.messages[0].content, '角色');
    res.end(JSON.stringify({ choices: [{ message: { content: '识别成功' } }], usage: { prompt_tokens: 800, completion_tokens: 10 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  await new Model({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test', model: 'deepseek-flash',
    maxOutput: 128, timeoutMs: 1000 }).complete(messages, { images: [imageData(png)] });
  assert.equal(messages[1].content, '识图');
});
test('image-only private and mentioned group work; persisted history has no image bytes or CDN URL', async t => {
  const f = fixture(t); await f.bot.ingest(event(), f.send);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.images.length, 1);
  const history = JSON.stringify(f.store.history('private:10000002'));
  assert.ok(!history.includes('base64')); assert.ok(!history.includes('qpic.cn'));
  assert.match(history, /图片/);
  assert.equal(f.store.balance(budgetDay(now), f.c.budgetMicro).used, 1840);
  await f.bot.ingest(event('', { message_type: 'group', group_id: 10000003, message_id: 2,
    message: [{ type: 'at', data: { qq: '10000001' } }, image] }), f.send);
  assert.equal(f.calls.length, 2);
  await f.bot.ingest(event('', { message_id: 3, message_type: 'group', group_id: 10000003 }), f.send);
  await f.bot.ingest(event('', { user_id: 10000004, message_id: 4 }), f.send);
  assert.equal(f.loads.length, 2);
});
test('blocked captions, paused service, disabled vision, budget, too many images and search never download images', async t => {
  for (const variant of ['blocked', 'paused', 'off', 'budget', 'count', 'search']) {
    const f = fixture(t, { BLOCK_TERMS: '禁词', ...(variant === 'off' ? { VISION_ENABLED: 'false' } : {}),
      ...(variant === 'budget' ? { DAILY_BUDGET_CNY: '0.000001' } : {}) });
    if (variant === 'paused') f.store.set('enabled', '0');
    await f.bot.ingest(event(variant === 'blocked' ? '禁词' : variant === 'search' ? '/搜索 信息' : '',
      variant === 'count' ? { message: [image, image, image, image] } : {}), f.send);
    assert.equal(f.loads.length, 0, variant); assert.equal(f.calls.length, 0, variant);
    assert.equal(f.store.history('private:10000002').length, 0);
  }
});
test('download failures incur no model cost or history; later text turns do not resend images', async t => {
  const failed = fixture(t, {}, true); await failed.bot.ingest(event(), failed.send);
  assert.equal(failed.calls.length, 0); assert.match(failed.sent[0], /图片读取失败/);
  assert.equal(failed.store.balance(budgetDay(now), failed.c.budgetMicro).held, 0);
  const f = fixture(t); await f.bot.ingest(event(), f.send);
  await f.bot.ingest(event('是什么颜色？', { message_id: 2, message: [{ type: 'text', data: { text: '是什么颜色？' } }] }), f.send);
  assert.deepEqual(f.calls[1].options, {}); assert.ok(!JSON.stringify(f.calls[1].messages).includes('base64'));
});
