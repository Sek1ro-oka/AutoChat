// First-reply quiet-window regressions. Real bridge handlers, fixture peers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run, cfg = {}, key = 'group:456') {
  const h = await bridgeHarness({ config: { socialV2: {
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
    proactive: { enabled: false }, sticker: { enabled: false },
    ...cfg,
  } } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'content-type': 'application/json' },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key, ...body }));
  });
  // GET routes carry their options in the query string, not the body.
  const get = (route, query = '') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}?key=${encodeURIComponent(key)}${query}`,
      method: 'GET',
      headers: { 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end();
  });
  // `flags.atSelf` / `flags.quoteTargetIsSelf` mark the message as aimed at us; the
  // fast-lane tests depend on it, the older slow-lane tests leave both off.
  const append = (text, flags = {}) => h.appendSocialV2Message(key, 'fixture-person', text, text, flags.quoteTargetIsSelf === true, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', [], flags.atSelf === true);
  try { await run({ h, key, st, request, get, append }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('first reply does not wait out timeout when the snapshot message is already quiet', () => fixture(async ({ h, key, st, request, append }) => {
  append('a complete first message');
  st.lastIncomingAt = Date.now() - 10000; // batching and model reading already consumed the quiet window
  await h.sendWakePromptV2(key, 'question');
  const started = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.ok(Date.now() - started < 600, `already-quiet message waited ${result.data.waitedMs}ms`);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.timeout, false);
  assert.equal(result.data.arrived, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal('preSleepWaitRemainingMs' in result.data, false, 'first reply must not be presented as an unfinished sleep countdown');
}));

test('reply waits only for the remaining quiet time after model reading', () => fixture(async ({ h, key, st, request, append }) => {
  append('complete message');
  await h.sendWakePromptV2(key, 'question');
  st.lastIncomingAt = Date.now() - 600;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 800 });
  assert.equal(result.data.quiet, true);
  assert.ok(result.data.waitedMs >= 100 && result.data.waitedMs < 600, `remaining wait was ${result.data.waitedMs}ms`);
}));

test('a message between snapshot and wait is returned without duplicate snapshot content', () => fixture(async ({ h, key, st, request, append }) => {
  append('in snapshot');
  await h.sendWakePromptV2(key, 'question');
  append('arrived while model was thinking');
  st.lastIncomingAt = Date.now() - 1000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100, minNewMessages: 20 });
  assert.equal(result.data.arrived, true);
  assert.equal(result.data.quiet, true);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(st.unread.length, 2, 'visibility never acknowledges messages');
}));

test('each supplement restarts quiet from its actual arrival, and appears exactly once', () => fixture(async ({ st, request, append }) => {
  append('first');
  await request('unread');
  st.lastIncomingAt = Date.now();
  const timers = [setTimeout(() => append('second'), 120), setTimeout(() => append('third'), 240)];
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1500, quietMs: 300 });
    assert.equal(result.data.quiet, true);
    assert.ok(result.data.waitedMs >= 500 && result.data.waitedMs < 1200);
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [2, 3]);
    assert.equal(result.data.readThroughSeq, 3);
  } finally { timers.forEach(clearTimeout); }
}, { wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100, fastQuietMs: 100 } }));

test('reply timeout is a hard budget and cannot grant sleep observation, even with a long requested budget', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.wake.preSleepWaitMs = 200;
  append('first');
  await request('unread');
  const timer = setTimeout(() => append('supplement near deadline'), 220);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 300, quietMs: 600 });
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.equal(result.data.speakerLikelyDone, false);
    assert.ok(result.data.waitedMs >= 300 && result.data.waitedMs < 900);
    assert.equal(result.data.preSleepWaitObserved, false);
    assert.equal(result.data.preSleepWaitSatisfied, false);
    assert.equal(st.preSleepWaitObservedAt, 0);
    assert.equal(st.preSleepWaitSatisfiedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('ordinary and omitted purpose keep waiting for future messages', () => fixture(async ({ st, request, append }) => {
  append('already known');
  await request('unread');
  st.lastIncomingAt = Date.now() - 10000;
  for (const purpose of [undefined, 'messages']) {
    const result = await request('wait', { purpose, timeoutMs: 600, quietMs: 100 });
    assert.ok(result.data.waitedMs >= 600);
    assert.equal(result.data.timeout, true);
    assert.equal(result.data.quiet, false);
    assert.deepEqual(result.data.newMessages, []);
  }
}));

test('reply mode rejects a session permission change during its remaining quiet window', () => fixture(async ({ h, st, request, append }) => {
  append('still fresh');
  const timer = setTimeout(() => h.setMode('chat'), 100);
  try {
    const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 300 });
    assert.equal(result.status, 403);
    assert.equal(st.modelSeenSeqs.size, 0);
    assert.equal(st.preSleepWaitObservedAt, 0);
  } finally { clearTimeout(timer); }
}));

test('reply mode cannot expose historical messages when both history tools are disabled', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = false;
  append('hidden historical message');
  st.lastIncomingAt = Date.now() - 10000;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1000, quietMs: 100 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
}));

test('invalid purpose is rejected without authorizing history or observation', () => fixture(async ({ st, request, append }) => {
  append('pending message');
  for (const purpose of ['quiet', '', null, 1]) {
    const result = await request('wait', { purpose, timeoutMs: 1000, quietMs: 100 });
    assert.equal(result.status, 400);
  }
  assert.equal(st.modelSeenSeqs.size, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.unread.length, 1);
}));

test('each reply-wait buffer obeys its own tool switch, never the other one', () => fixture(async ({ h, st, request, get, append }) => {
  h.cfg.socialV2.context.recentLimit = 5;
  h.cfg.socialV2.context.unreadLimit = 30;
  for (let i = 1; i <= 3; i++) append(`m${i}`);
  const read = await get('unread', '&limit=30');
  assert.equal(read.data.readThroughSeq, 3);

  // getRecent off. Only getUnread may feed the reply path. A message that arrived
  // after the model's last read is exactly what this purpose exists to surface, but
  // the buffer the closed switch governs must stay out of it.
  h.cfg.socialV2.tools.getRecent = false;
  append('arrived after the last read');
  st.lastIncomingAt = Date.now() - 10000;
  const r1 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r1.data.newMessages.map((m) => m.seq), [4], 'the enabled getUnread still reports the arrival');
  assert.equal(r1.data.readThroughSeq, 4);
  assert.equal(JSON.stringify(st.unread.map((m) => m.seq)), '[1,2,3,4]', `a reply wait never consumes unread; got ${JSON.stringify(st.unread.map((m) => m.seq))}`);

  // getUnread off: the enabled getRecent still carries arrivals, and the unread
  // buffer must not be the one answering.
  h.cfg.socialV2.tools.getRecent = true;
  h.cfg.socialV2.tools.getUnread = false;
  append('while getUnread is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r2 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r2.data.newMessages.map((m) => m.seq), [5]);

  // Both switches off: nothing may be exposed or authorised, whatever is buffered.
  h.cfg.socialV2.tools.getRecent = false;
  append('while everything is closed');
  st.lastIncomingAt = Date.now() - 10000;
  const r3 = await request('wait', { purpose: 'reply', timeoutMs: 1200, quietMs: 100 });
  assert.deepEqual(r3.data.newMessages, []);
  assert.equal(r3.data.readThroughSeq, 5, 'a message nobody was allowed to see may not advance the watermark');
}));

// ── Fast lane (2026-10-22): 私聊 / 被 @ / 被引用 不再吃慢车道的合批与静默下限 ──
// 慢车道那 8 秒合批 + 8 秒静默是给「群里顺便聊两句」用的；对方直接问我们时
// 它只会变成 16 秒沉默，所以这两组用例把两条车道的 floor 分别钉住。
const FAST_LANE_WAIT = { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 6000, fastQuietMs: 400 };

test('a group message aimed at us uses the fast quiet floor, not the 6s group floor', () => fixture(async ({ h, st, request, append }) => {
  append('@小鲸鱼 你在吗', { atSelf: true });
  st.lastIncomingAt = Date.now() - 100;
  const started = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 4000 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 200);
  assert.equal(result.data.quiet, true, `fast lane should report quiet; got ${JSON.stringify(result.data)}`);
  assert.ok(elapsed < 1600, `@-message waited ${elapsed}ms for a 400ms fast floor`);
  assert.equal(result.data.quietMs, 400, 'the fast floor must be the one applied, not the 6s group floor');
}, { wait: FAST_LANE_WAIT }));

test('with the default scope every group takes the fast lane, not just @-mentions', () => fixture(async ({ h, key, st, request, append }) => {
  assert.equal(h.fastLaneScopeV2(), 'all', 'the default must cover every conversation');
  append('今天天气不错');
  st.lastIncomingAt = Date.now() - 100;
  const started = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 4000 });
  assert.equal(result.status, 200);
  assert.equal(result.data.quietMs, 400, 'plain group chatter must use fastQuietMs, not the 6s group floor');
  assert.equal(result.data.quiet, true);
  assert.ok(Date.now() - started < 1600, 'plain group chatter must not sit out the slow floor');
  assert.equal(h.fastWakeV2(key, st, 'anyMessage'), true, 'every wake is a fast wake by default');
}, { wait: FAST_LANE_WAIT }));

test('with the default scope an ordinary group wake also skips the batching window', () => fixture(async ({ h, key, st }) => {
  h.scheduleWakeV2(key, 'anyMessage');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(h.calls.prompts.length, 1, 'every group must hear back inside the fast batch window');
  clearTimeout(st.pendingWakeTimer);
}, { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000, batchWindowMs: 8000, fastBatchWindowMs: 300 } }));

test('an ordinary group message keeps the slow quiet floor when the scope is narrowed to addressed', () => fixture(async ({ st, request, append }) => {
  append('今天天气不错');
  st.lastIncomingAt = Date.now();
  const result = await request('wait', { purpose: 'reply', timeoutMs: 1000 });
  assert.equal(result.status, 200);
  assert.equal(result.data.timeout, true, 'slow lane must still wait out its 6s floor rather than answer instantly');
  assert.equal(result.data.quiet, false);
  assert.ok(result.data.waitedMs >= 900, `slow lane returned after ${result.data.waitedMs}ms`);
  assert.equal(st.fastLaneLoggedAt, undefined, 'slow lane must not take the fast path');
}, { wait: FAST_LANE_WAIT, wake: { fastLaneScope: 'addressed' } }));

test('lane selection: private, @, quote and high-priority wakes are fast; idle group chatter is not', () => fixture(async ({ h, st }) => {
  h.cfg.socialV2.wake.fastLaneScope = 'addressed';
  const atSelf = (time) => ({ atSelf: true, quoteTargetIsSelf: false, time });
  assert.equal(h.isFastLaneKeyV2('private:789'), true);
  assert.equal(h.isFastLaneKeyV2('group:456'), false);
  assert.equal(h.fastLaneActiveV2('private:789', { unread: [] }), true, 'private chats are always fast');
  assert.equal(h.fastLaneActiveV2('group:456', { unread: [] }), false, 'idle group chatter keeps the slow lane');

  st.unread = [{ seq: 1, text: '@小鲸鱼', atSelf: true, time: Date.now() }];
  assert.equal(h.fastLaneActiveV2('group:456', st), true, 'a fresh @ is a direct address');
  st.unread = [{ seq: 2, text: 'reply', atSelf: false, quoteTargetIsSelf: true, time: Date.now() }];
  assert.equal(h.fastLaneActiveV2('group:456', st), true, 'a quote aimed at us is a direct address');
  st.unread = [{ seq: 3, text: 'old @', atSelf: true, time: Date.now() - 5 * 60 * 1000 }];
  assert.equal(h.fastLaneActiveV2('group:456', st), false, 'a five-minute-old @ must not keep the group fast');
  st.unread = [{ seq: 4, text: 'plain', atSelf: false, quoteTargetIsSelf: false, time: Date.now() }];
  assert.equal(h.fastLaneActiveV2('group:456', st), false);

  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'atMention'), true, 'atMention outranks any batching');
  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'private'), true);
  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'anyMessage'), false, 'stray group chatter still batches');
  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'keyword:在吗'), false);

  // 默认（scope=all）下每个会话都是快车道：没有「普通群聊」这回事了。
  h.cfg.socialV2.wake.fastLaneScope = 'all';
  assert.equal(h.fastLaneActiveV2('group:456', { unread: [] }), true, 'the default covers every conversation');
  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'anyMessage'), true);
  assert.equal(h.fastWakeV2('group:456', { unread: [] }, 'keyword:在吗'), true);
}));

test('a fast-lane wake prompt tells the model to send first, a slow-lane one still counts the quiet window', () => fixture(async ({ h, key, st, append }) => {
  append('@小鲸鱼 在吗', { atSelf: true });
  const fast = h.buildWakePromptV2(key, 'atMention');
  assert.match(fast, /快车道/);
  assert.match(fast, /不要再调 qq_wait_for_messages/);
  assert.doesNotMatch(fast, /还差约/, 'the fast lane must not hand the model a countdown it no longer needs');

  h.cfg.socialV2.wake.fastLaneScope = 'addressed';
  st.unread = [];
  append('今天有点热');
  const slow = h.buildWakePromptV2(key, 'anyMessage');
  assert.match(slow, /还差约/, 'the slow lane keeps the quiet countdown');
  assert.doesNotMatch(slow, /快车道/);
}));

test('the wake prompt teaches the diary tools, and drops the block when they are off', () => fixture(async ({ h, key }) => {
  const on = h.buildWakePromptV2(key, 'question');
  assert.match(on, /【日记】/, 'the model only ever wrote diaries, never read them: the prompt has to say how');
  assert.match(on, /qq_diary_list/);
  assert.match(on, /qq_diary_read/);

  h.cfg.socialV2.tools.diary = false;
  const off = h.buildWakePromptV2(key, 'question');
  assert.doesNotMatch(off, /【日记】/, 'a disabled diary must not be advertised');
}));

test('a message asking about the past gets a diary recall cue, plain chatter does not', () => fixture(async ({ h, key, append }) => {
  append('你还记得上次说要一起去看的那部片子吗');
  const past = h.buildWakePromptV2(key, 'question');
  assert.match(past, /【回忆线索】/);
  assert.match(past, /qq_diary_list/);

  h.appendSocialV2Message(key, 'fixture-person', '今天午饭吃啥', '今天午饭吃啥', false, false, `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, [], '789', []);
  const now = h.buildWakePromptV2(key, 'question');
  assert.doesNotMatch(now, /【回忆线索】/);
}));

test('an oversized session is retired before the next wake, a small one is left alone', () => fixture(async ({ h, key }) => {
  h.cfg.socialV2.context.maxSessionTokens = 1000;
  h.state.sessions[key] = 'session-fat';
  h.sessionCtxTokens.set('session-fat', 390000);
  const rotated = h.maybeRotateOversizedSessionV2(key);
  assert.equal(rotated.rotated, true);
  assert.equal(rotated.contextTokens, 390000);
  assert.equal(h.state.sessions[key], undefined, 'the stale mapping must go so ensureSession builds a clean session');
  assert.equal(h.sessionCtxTokens.has('session-fat'), false);

  h.state.sessions[key] = 'session-thin';
  h.sessionCtxTokens.set('session-thin', 900);
  assert.equal(h.maybeRotateOversizedSessionV2(key).rotated, false);
  assert.equal(h.state.sessions[key], 'session-thin', 'a session below the ceiling keeps its history');

  h.cfg.socialV2.context.maxSessionTokens = 0;
  assert.equal(h.maybeRotateOversizedSessionV2(key).reason, 'disabled');
}));

test('provider usage is what drives the rotation decision', () => fixture(async ({ h, key }) => {
  h.cfg.socialV2.context.maxSessionTokens = 100000;
  h.state.sessions[key] = 'session-usage';
  h.recordSessionUsage('session-usage', { type: 'assistant/message', data: { usage: { cache_hit_tokens: 90000, cache_miss_tokens: 12000 } } });
  assert.equal(h.sessionCtxTokens.get('session-usage'), 102000, 'cached + uncached input is the real context size');
  assert.equal(h.maybeRotateOversizedSessionV2(key).rotated, true);
}));

const WAKE_CFG = { preSleepWaitEnabled: true, preSleepWaitMs: 300000, batchWindowMs: 8000, fastBatchWindowMs: 300 };

test('a wake aimed at us skips the 8s batching window and reaches DSH at once', () => fixture(async ({ h, key }) => {
  h.scheduleWakeV2(key, 'atMention');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(h.calls.prompts.length, 1, 'an @ must be delivered inside 1.2s, not after the 8s batch window');
}, { wake: WAKE_CFG }));

test('an ordinary group wake still waits out the batching window when the scope is narrowed to addressed', () => fixture(async ({ h, key, st }) => {
  h.scheduleWakeV2(key, 'anyMessage');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(h.calls.prompts.length, 0, 'stray group chatter must keep batching so the bot does not butt in');
  clearTimeout(st.pendingWakeTimer);
}, { wake: { ...WAKE_CFG, fastLaneScope: 'addressed' } }));

// A cross group shares identity and memory, and any member session may speak for the
// others (T-018). The 2026-10-22 incident was the bot calling that "crossed wires":
// the sibling session asked the question, so the group session had no memory of it.
// The fixes are provenance on the stored message (`via`) plus an explicit line in the
// wake prompt; both are asserted here.
const CROSS_CFG = { cross: { enabled: true, groups: { 'group:456': 1, 'private:789': 1 } } };

test('a standalone session gets no cross-group lecture', () => fixture(async ({ h, key, st }) => {
  assert.equal(h.buildCrossGroupLineV2(key, st), '', 'session without a shared group must not be told about one');
}));

test('a shared group is explained as by-design, and the prompt says how to tell messages apart', () => fixture(async ({ h, key, st }) => {
  const line = h.buildCrossGroupLineV2(key, st);
  assert.match(line, /【互通组】/);
  assert.match(line, /不是串线/);
  assert.match(line, /via/);
  assert.match(h.buildWakePromptV2(key, 'question'), /【互通组】/, 'the wake prompt must carry the explanation');
}, CROSS_CFG));

test('a message the sibling session sent on our behalf keeps its origin, and the prompt counts it', () => fixture(async ({ h, key, st }) => {
  h.recordSentMessagesV2(key, ['我就考它一道重复数'], 'private:789');
  const last = st.recentMessages[st.recentMessages.length - 1];
  assert.equal(last.isSelf, true);
  assert.equal(last.via, 'private:789', 'the stored message must remember which session spoke');
  assert.ok(last.viaLabel, 'a human label travels with via');

  const prompt = h.buildWakePromptV2(key, 'question');
  assert.match(prompt, /已经替你在这里发过 1 条/);
}, CROSS_CFG));

test('a self-sent message carries no origin tag, so normal sends look unchanged', () => fixture(async ({ h, key, st }) => {
  h.recordSentMessagesV2(key, ['自己说的']);
  const last = st.recentMessages[st.recentMessages.length - 1];
  assert.equal(last.via, undefined);
  assert.equal(last.viaLabel, undefined);
}, CROSS_CFG));
// B/C（2026-10-22）：用户不想为了「别再说串线」把两个会话并成一个窗口（会串行、
// 会把私聊内容灌进群上下文）。改成共享账本：唤醒提示词直接带上同组最近的对话，
// 会话退役重建后还自动放大窗口补一次课。

test('the ledger hands us what the sibling chat said, so neither window has to guess', () => fixture(async ({ h, key, st }) => {
  h.appendSocialV2Message('private:789', '无一', '群里的题我替你答了', '群里的题我替你答了', false, false, 'm-ledger-1', [], '789', []);
  const line = h.buildCrossLedgerLineV2(key, st);
  assert.match(line, /【组内近况】/);
  assert.match(line, /替你答了/, 'the sibling message text must be readable here');
  assert.match(line, /无一/);
  assert.match(h.buildWakePromptV2(key, 'question'), /【组内近况】/, 'the wake prompt must carry it');
}, CROSS_CFG));

test('cross.ledgerPerKey = 0 turns the shared ledger off', () => fixture(async ({ h, key, st }) => {
  h.appendSocialV2Message('private:789', '无一', '随便说一句', '随便说一句', false, false, 'm-ledger-2', [], '789', []);
  assert.equal(h.buildCrossLedgerLineV2(key, st), '');
  assert.doesNotMatch(h.buildWakePromptV2(key, 'question'), /【组内近况】/);
}, { cross: { enabled: true, groups: { 'group:456': 1, 'private:789': 1 }, ledgerPerKey: 0 } }));

test('a rebuilt session gets a catch-up block with wider limits', () => fixture(async ({ h, key, st }) => {
  for (let i = 0; i < 12; i += 1) {
    const text = `第 ${i} 条：聊的是第 ${i} 个话题`;
    h.appendSocialV2Message('private:789', '无一', text, text, false, false, `m-cap-${i}`, [], '789', []);
  }
  // 会话因太长被退役 —— 这一步会让窗口失忆，所以下一次唤醒要补课。
  h.cfg.socialV2.context.maxSessionTokens = 1000;
  h.state.sessions[key] = 'session-fat';
  h.sessionCtxTokens.set('session-fat', 390000);
  assert.equal(h.maybeRotateOversizedSessionV2(key).rotated, true);
  assert.ok(st.resumeAfterRotationAt > 0, 'retiring a session must leave a resume marker');

  const line = h.buildCrossLedgerLineV2(key, st);
  assert.match(line, /【组内近况·接续】/);
  assert.match(line, /第 11 条/, 'the boosted window must reach further back than the steady-state one');
}, CROSS_CFG));
test('the fast lane caps a model-supplied quietMs instead of letting it rebuild the 12s wait', () => fixture(async ({ h, st, request }) => {
  // 实测：模型习惯性传 quietMs=12000（旧慢车道口径），以前会把 800ms 的快车道直接打回 12s。
  st.lastIncomingAt = Date.now() - 100;
  const result = await request('wait', { purpose: 'reply', timeoutMs: 4000, quietMs: 12000 });
  assert.equal(result.status, 200);
  assert.equal(result.data.quietMs, 400, 'the fast floor must clamp a bigger request, not the other way round');
  assert.ok(result.data.waitedMs < 1600);
}, { wait: FAST_LANE_WAIT }));
// 回复即已读（2026-10-22）：模型常回完话忘了 mark_read，旧消息下一轮又被当新消息塞一遍。
// 口径与 mark-read 一致：只推进到「展示过」的水位，没给模型看过的一条都不动。
test('a reply acknowledges the unread it was shown, and only that', () => fixture(async ({ h, key, st, request, append }) => {
  append('看过的那条');
  await request('unread');                 // 展示给模型 → 水位可到 1
  append('还没展示的那条');                 // 未展示 → 不能跟着被吞掉
  assert.equal(st.unread.length, 2);

  h.recordSentMessagesV2(key, ['回一句']);
  assert.equal(st.lastReadThroughSeq, 1, 'only the shown message may be acknowledged');
  assert.equal(JSON.stringify(st.unread.map((m) => m.seq)), '[2]', 'the unseen message must stay unread (vm-realm arrays cannot deepEqual host arrays)');
}));

test('a reply without a prior look does not acknowledge anything', () => fixture(async ({ h, key, st, append }) => {
  append('没看过');
  h.recordSentMessagesV2(key, ['主动说一句']);
  assert.equal(st.lastReadThroughSeq, 0);
  assert.equal(st.unread.length, 1, 'sending is not a licence to skip unread messages');
}));