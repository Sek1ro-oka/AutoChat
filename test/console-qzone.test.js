// 空间说说页的两条接口（I-09）：读「最近说说 + 今日计数」，以及删掉已经发出去的那一条。
// 这一组用例钉住的是一句承诺：只有协议端真的删成功了，本地记录才会变成「已删除」；
// 失败时要把真实原因带回给页面，绝不能报假成功。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createConsole } from '../src/console/server.js';
import { deleteQzonePost } from '../src/console/api.js';
import { TOKEN, auth, jsonPost } from './support/console-harness.js';

// A console wired to a fake protocol side: every call is recorded so a test can
// prove that a refused delete never touched the wire.
function qzoneFixture(t, { config = {}, reply } = {}) {
  const store = new Store();
  t.after(() => store.close());
  const calls = [];
  const transport = {
    ready: true,
    retry: 0,
    call: async (action, params) => {
      calls.push({ action, params });
      if (reply) return reply(action, params);
      return { tid: 't1_sent' };
    },
  };
  const settings = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    qzoneEnabled: true, qzoneDryRun: false, qzoneUgcRight: 4, qzoneMaxPerDay: 3,
    qzoneMinGapHours: 6, qzoneHours: '9-23', qzoneBatchMin: 8, qzoneMaterialTtlHours: 6,
    ...config,
  };
  const server = createConsole({ config: settings, store, transport, log: () => {}, port: 0 });
  return { store, server, calls };
}

async function serve(t, options) {
  const fx = qzoneFixture(t, options);
  await fx.server.start();
  t.after(() => fx.server.stop());
  fx.base = `http://127.0.0.1:${fx.server.address().port}`;
  return fx;
}

const seed = (store, at) => {
  store.noteQzonePost({ id: 'q1', at, text: '今天读到一句很喜欢的话，抄在这里留个念。', status: 'sent', tid: 't1_9' });
  store.noteQzonePost({ id: 'q2', at: at + 1000, text: '这是一条只在干跑里存在的草稿。', status: 'drafted', reason: 'dry_run' });
  store.noteQzonePost({ id: 'q3', at: at + 2000, text: '123456789 加我聊', status: 'blocked', reason: 'number' });
  store.noteQzonePost({ id: 'q4', at: at + 3000, text: '协议端没有回 tid 的那条', status: 'failed', reason: 'no_tid' });
};

test('the posts route reports today counts and never echoes refused text', async t => {
  const { store, base } = await serve(t);
  const at = Date.now();
  seed(store, at);
  const response = await fetch(`${base}/api/qzone/posts`, { headers: auth });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.enabled, true);
  assert.equal(data.dryRun, false);
  assert.equal(data.maxPerDay, 3);
  assert.equal(data.minGapHours, 6);
  assert.equal(data.hours, '9-23');
  assert.equal(data.lastSentAt, at);
  // Only drafted and sent rows consume the daily cap — a refused attempt never
  // reached the model's account of "today", because it was never sendable.
  assert.equal(data.today.sent, 1);
  assert.equal(data.today.drafted, 1);
  assert.equal(data.today.used, 2);
  assert.equal(data.today.limit, 3);
  assert.equal(data.today.remaining, 1);
  const byId = Object.fromEntries(data.posts.map(post => [post.id, post]));
  assert.equal(data.posts.length, 4);
  assert.equal(data.posts[0].id, 'q4', 'newest first');
  assert.equal(byId.q3.text, '', 'a blocked row must not carry its text');
  assert.equal(byId.q3.reason, 'number');
  assert.equal(byId.q4.text, '', 'a failed row must not carry its text');
  assert.equal(byId.q1.text, '今天读到一句很喜欢的话，抄在这里留个念。');
  assert.equal(byId.q1.removable, true);
  assert.equal(byId.q2.removable, false, 'a draft was never sent, so nothing to delete');
  assert.equal(byId.q4.removable, false);
});

test('deleting without a tid is refused before the protocol side is touched', async t => {
  const { store, base, calls } = await serve(t);
  const at = Date.now();
  store.noteQzonePost({ id: 'd1', at, text: '干跑草稿', status: 'drafted', reason: 'dry_run' });
  store.noteQzonePost({ id: 'g1', at: at + 10, text: '拦截正文', status: 'blocked', reason: 'link' });
  store.noteQzonePost({ id: 'x1', at: at + 20, text: '已经删过', status: 'deleted', tid: 't1_1' });
  const cases = [['d1', 409, 'QZONE_POST_NO_TID'], ['g1', 409, 'QZONE_POST_NO_TID'],
    ['x1', 409, 'QZONE_POST_ALREADY_DELETED'], ['nope', 404, 'QZONE_POST_NOT_FOUND'], ['', 404, 'QZONE_POST_NOT_FOUND']];
  for (const [id, status, error] of cases) {
    const response = await jsonPost(base, '/api/qzone/delete', { id });
    assert.equal(response.status, status, `delete ${id || '(empty)'}`);
    assert.equal((await response.json()).error, error);
  }
  assert.equal(calls.length, 0, 'a refused delete must not call delete_qzone_msg');
  assert.deepEqual(store.listQzonePosts().map(row => row.status).sort(), ['blocked', 'deleted', 'drafted']);
});

test('a successful delete calls the protocol first, then marks the row deleted', async t => {
  const { store, base, calls } = await serve(t);
  const at = Date.now();
  store.noteQzonePost({ id: 'q1', at, text: '发出去过的一条说说正文。', status: 'sent', tid: 't1_77' });
  const response = await jsonPost(base, '/api/qzone/delete', { id: 'q1' });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.deleted, true);
  assert.equal(data.id, 'q1');
  assert.deepEqual(calls, [{ action: 'delete_qzone_msg', params: { tid: 't1_77' } }]);
  assert.equal(data.posts[0].status, 'deleted');
  assert.equal(data.posts[0].removable, false);
  assert.equal(store.listQzonePosts()[0].status, 'deleted');
  const again = await jsonPost(base, '/api/qzone/delete', { id: 'q1' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'QZONE_POST_ALREADY_DELETED');
  assert.equal(calls.length, 1, 'the second click must not reach the protocol again');
});

test('a failed delete echoes the real reason and leaves the row untouched', async t => {
  const failures = [
    ['ONEBOT_ACTION_FAILED', 502, 'QZONE_DELETE_REJECTED'],
    ['ONEBOT_TIMEOUT', 504, 'QZONE_DELETE_TIMEOUT'],
    ['ONEBOT_NOT_CONNECTED', 503, 'QZONE_DELETE_UNAVAILABLE'],
    ['ONEBOT_DISCONNECTED', 503, 'QZONE_DELETE_UNAVAILABLE'],
    ['ONEBOT_SEND_FAILED', 503, 'QZONE_DELETE_UNAVAILABLE'],
    ['boom', 502, 'QZONE_DELETE_FAILED'],
  ];
  for (const [raw, status, error] of failures) {
    await t.test(raw, async sub => {
      const { store, base } = await serve(sub, { reply: async () => { throw new Error(raw); } });
      store.noteQzonePost({ id: 'q1', at: Date.now(), text: '发出去过的一条说说正文。', status: 'sent', tid: 't1_5' });
      const response = await jsonPost(base, '/api/qzone/delete', { id: 'q1' });
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.error, error);
      assert.equal(body.detail, raw, 'the page needs the protocol-side wording');
      assert.equal(body.deleted, undefined, 'a failure must never look like a success');
      assert.equal(store.listQzonePosts()[0].status, 'sent', 'the row stays published locally too');
    });
  }
  // A resolved frame with a non-zero retcode is also a failure: the adapter
  // reported the error inline instead of rejecting.
  await t.test('inline retcode', async sub => {
    const { store, base } = await serve(sub, { reply: async () => ({ retcode: -10006 }) });
    store.noteQzonePost({ id: 'q1', at: Date.now(), text: '发出去过的一条说说正文。', status: 'sent', tid: 't1_6' });
    const response = await jsonPost(base, '/api/qzone/delete', { id: 'q1' });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error, 'QZONE_DELETE_REJECTED');
    assert.equal(body.detail, 'retcode -10006');
    assert.equal(store.listQzonePosts()[0].status, 'sent');
  });
});

test('a console with no protocol transport refuses instead of pretending', async t => {
  const store = new Store();
  t.after(() => store.close());
  store.noteQzonePost({ id: 'q1', at: Date.now(), text: '发出去过的一条说说正文。', status: 'sent', tid: 't1_2' });
  await assert.rejects(() => deleteQzonePost({ config: {}, store, transport: {}, id: 'q1' }), error => {
    assert.equal(error.message, 'QZONE_DELETE_UNAVAILABLE');
    assert.equal(error.detail, 'no_transport');
    return true;
  });
  assert.equal(store.listQzonePosts()[0].status, 'sent');
});

test('both qzone routes need the token, and the write needs a loopback origin', async t => {
  const { store, base, calls } = await serve(t);
  store.noteQzonePost({ id: 'q1', at: Date.now(), text: '发出去过的一条说说正文。', status: 'sent', tid: 't1_3' });
  assert.equal((await fetch(`${base}/api/qzone/posts`)).status, 401);
  assert.equal((await jsonPost(base, '/api/qzone/delete', { id: 'q1' }, { 'x-console-token': '' })).status, 401);
  const foreign = await jsonPost(base, '/api/qzone/delete', { id: 'q1' }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');
  assert.equal(calls.length, 0);
  assert.equal(store.listQzonePosts()[0].status, 'sent');
});
