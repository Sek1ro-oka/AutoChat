import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { Bot } from '../src/bot.js';
import { Model } from '../src/model.js';
import { OneBot } from '../src/onebot.js';

const config = { botId: '10000001', privateUser: '10000002', adminId: '10000002', groupId: '10000003',
  budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, maxOutput: 128, contextTokens: 16000,
  clearMs: 72 * 3600000, systemPrompt: 'test', blockTerms: [], model: 'deepseek-flash',
  onebotToken: 'local-test-token', apiKey: 'local-test-key', timeoutMs: 1000, actionTimeoutMs: 200 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Test wait timed out'); await sleep(10); }
}
function message(id = 1) {
  return { post_type: 'message', message_type: 'private', self_id: 10000001, user_id: 10000002,
    message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: 'hello' } }] };
}

test('local mock NapCat → model → reply; auth, echo, dedup and reconnect', async t => {
  let modelCalls = 0;
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-key');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.thinking.type, 'disabled');
    modelCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'mock answer' } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  }).listen(0, '127.0.0.1');
  await once(http, 'listening');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const replies = []; let current;
  server.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-token');
    current = socket;
    socket.on('message', raw => {
      const request = JSON.parse(raw);
      if (request.action === 'get_login_info') {
        socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { user_id: 10000001 } }));
      } else {
        replies.push(request);
        socket.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data: { message_id: 50 } }));
      }
    });
  });
  const c = { ...config, wsUrl: `ws://127.0.0.1:${server.address().port}`,
    baseUrl: `http://127.0.0.1:${http.address().port}` };
  const store = new Store(), bot = new Bot(c, store, new Model(c));
  const transport = new OneBot(c, { onEvent: (...args) => bot.ingest(...args) });
  t.after(async () => {
    transport.stop(); for (const socket of server.clients) socket.terminate();
    await bot.tail; store.close(); await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => http.close(resolve));
  });
  transport.start(); await until(() => transport.ready);
  current.send(JSON.stringify(message())); current.send(JSON.stringify(message()));
  await until(() => replies.length === 1); await bot.tail;
  assert.equal(modelCalls, 1); assert.equal(replies[0].action, 'send_private_msg');
  assert.equal(replies[0].params.message[0].data.text, 'mock answer');
  const oldGeneration = transport.generation;
  current.close(); await until(() => transport.generation > oldGeneration && transport.ready);
  await assert.rejects(transport.call('send_private_msg', {}, oldGeneration), /NOT_CONNECTED/);
  current.send(JSON.stringify(message())); await sleep(50);
  assert.equal(modelCalls, 1);
  // Local commands remain independent of model availability.
  current.send(JSON.stringify({ ...message(2), message: [{ type: 'text', data: { text: '/帮助' } }] }));
  await until(() => replies.length === 2); assert.equal(modelCalls, 1);
});

test('pending OneBot actions reject on disconnect; mismatched login stops transport', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening'); let current, mismatch = false;
  server.on('connection', socket => {
    current = socket;
    socket.on('message', raw => {
      const request = JSON.parse(raw);
      if (request.action === 'get_login_info') socket.send(JSON.stringify({ echo: request.echo,
        status: 'ok', retcode: 0, data: { user_id: mismatch ? 999 : 10000001 } }));
    });
  });
  const transport = new OneBot({ ...config, wsUrl: `ws://127.0.0.1:${server.address().port}` });
  t.after(async () => { transport.stop(); for (const s of server.clients) s.terminate(); await new Promise(r => server.close(r)); });
  transport.start(); await until(() => transport.ready);
  const pending = transport.call('send_private_msg', {});
  current.close(); await assert.rejects(pending, /DISCONNECTED/);
  mismatch = true;
  await until(() => transport.stopped); assert.equal(transport.ready, false);
});

test('model HTTP failure, invalid answer and timeout never leak response body', async t => {
  let mode = 'error';
  const server = createServer((req, res) => {
    if (mode === 'timeout') return;
    if (mode === 'error') { res.writeHead(401); res.end('secret upstream body'); }
    else { res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } })); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const model = new Model({ ...config, timeoutMs: 50, baseUrl: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(model.complete([{ role: 'user', content: 'hello' }]), /^Error: MODEL_HTTP_401$/);
  mode = 'invalid'; assert.equal((await model.complete([])).text, null);
  mode = 'timeout'; await assert.rejects(model.complete([]));
});
