import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, budgetDay } from '../src/store.js';
import { QZone, codeOf, hourAllowed, parseDecision } from '../src/qzone.js';

// 2027-01-15 16:00 Beijing: a weekday, inside the default 9-23 window, so a test
// that fails on the window says so explicitly instead of by accident.
const CLOCK = 1800000000000;
const POST = '今天的风很舒服，适合出门走走。';
const MATERIAL = '今天食堂的番茄炒蛋很好吃';

const makeConfig = overrides => ({
  botId: '10000', adminId: '9999', groupId: '20000', groupIds: ['20000'],
  qzoneEnabled: true, qzoneDryRun: false, qzoneUgcRight: 4,
  qzoneMaxPerDay: 1, qzoneMinGapHours: 6, qzoneHours: '9-23',
  qzoneBatchMin: 3, qzoneMaterialTtlHours: 6, qzoneModelOutputTokens: 300,
  budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, blockTerms: [], systemPrompt: '内置人设',
  ...overrides,
});

// One in-memory store, one frozen clock, one fake model, one recording transport.
// `transport` may throw or return a payload; the default is a healthy NapCat.
const harness = ({ overrides = {}, reply = JSON.stringify({ worthy: true, text: POST }), transport = null } = {}) => {
  const store = new Store();
  const clock = { value: CLOCK };
  const model = {
    calls: [],
    async complete(messages) {
      this.calls.push(messages);
      return { text: reply, usage: { prompt_tokens: 500, completion_tokens: 30 } };
    },
  };
  const sent = [];
  const logs = [];
  const qzone = new QZone({
    config: makeConfig(overrides), store, model,
    log: (event, detail) => logs.push({ event, detail }),
    now: () => clock.value,
  });
  const call = async (action, params) => {
    sent.push({ action, params });
    if (transport) return transport(action, params);
    return action === 'send_qzone_msg' ? { tid: `t1_${sent.length}` } : {};
  };
  const seed = (count, { at = CLOCK - 60000, text = MATERIAL, userId = '30001', start = 0 } = {}) => {
    for (let index = 0; index < count; index += 1) {
      const tail = start + index;
      store.noteMessage({ groupId: '20000', messageId: `m${tail}`, userId, at: at + index, text: `${text}${tail}` });
    }
  };
  const event = (message, overrides2 = {}) => ({
    post_type: 'message', message_type: 'group', self_id: '10000', group_id: '20000',
    user_id: '30001', message_id: 'e1', time: CLOCK / 1000, message, ...overrides2,
  });
  return { store, clock, model, sent, logs, qzone, call, seed, event };
};

// --- the switch -------------------------------------------------------------

test('with the switch off, no model is called and no action is sent', async () => {
  const h = harness({ overrides: { qzoneEnabled: false } });
  h.seed(5);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 0);
  assert.equal(h.sent.length, 0);
  // Material is not even collected while off.
  assert.equal(h.qzone.observe(h.event([{ type: 'text', data: { text: '这条不会被记下来' } }])), false);
  assert.equal(h.store.recentMessages('20000').length, 5);
  h.store.close();
});

test('with the switch off, the daily cap is never even consulted', async () => {
  const h = harness({ overrides: { qzoneEnabled: false, qzoneMaxPerDay: 1 } });
  h.seed(3);
  await h.qzone.tick(h.call);
  assert.equal(h.logs.length, 0);
  h.store.close();
});

// --- dry run ----------------------------------------------------------------

test('dry run spends one model call and stores a draft instead of publishing', async () => {
  const h = harness({ overrides: { qzoneDryRun: true } });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), true);
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.sent.length, 0);
  const rows = h.store.listQzonePosts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'drafted');
  assert.equal(rows[0].text, POST);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_drafted'));
  h.store.close();
});

// --- publishing -------------------------------------------------------------

test('a worthy batch is published once, recorded, and reported to the admin', async () => {
  const h = harness();
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), true);
  const sends = h.sent.filter(entry => entry.action === 'send_qzone_msg');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.content, POST);
  assert.equal(sends[0].params.ugc_right, 4);
  const rows = h.store.listQzonePosts();
  assert.equal(rows[0].status, 'sent');
  assert.match(rows[0].tid, /^t1_/);
  const notify = h.sent.filter(entry => entry.action === 'send_private_msg');
  assert.equal(notify.length, 1);
  assert.equal(notify[0].params.user_id, '9999');
  assert.ok(notify[0].params.message.includes(POST));
  h.store.close();
});

test('the post text is never written to a log line', async () => {
  const h = harness();
  h.seed(3);
  await h.qzone.tick(h.call);
  assert.ok(!JSON.stringify(h.logs).includes(POST));
  const sentLog = h.logs.find(entry => entry.event === 'qzone_sent');
  assert.deepEqual(Object.keys(sentLog.detail).sort(), ['len', 'ugc_right']);
  h.store.close();
});

test('an outbound-gate hit is dropped, recorded, and logged with enum plus length only', async () => {
  const text = '我今天看到1234567这个数字很开心';
  const h = harness({ reply: JSON.stringify({ worthy: true, text }) });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.sent.filter(entry => entry.action === 'send_qzone_msg').length, 0);
  const blocked = h.logs.find(entry => entry.event === 'qzone_blocked');
  assert.deepEqual(blocked.detail, { reason: 'number', len: Array.from(text).length });
  assert.ok(!JSON.stringify(h.logs).includes(text));
  assert.equal(h.store.listQzonePosts()[0].status, 'blocked');
  h.store.close();
});

// --- material ---------------------------------------------------------------

test('a QQ number, a link and an @ never reach the prompt', async () => {
  const h = harness();
  h.seed(3);
  h.store.noteMessage({ groupId: '20000', messageId: 'bad1', userId: '30002', at: CLOCK - 50000, text: '我的手机号是13800001111' });
  h.store.noteMessage({ groupId: '20000', messageId: 'bad2', userId: '30003', at: CLOCK - 40000, text: '你们看 https://example.com/t 这个' });
  h.store.noteMessage({ groupId: '20000', messageId: 'bad3', userId: '30004', at: CLOCK - 30000, text: '@小明 你觉得呢' });
  await h.qzone.tick(h.call);
  const prompt = h.model.calls[0].map(item => item.content).join('\n');
  assert.ok(!prompt.includes('13800001111'));
  assert.ok(!prompt.includes('example.com'));
  assert.ok(!prompt.includes('@小明'));
  h.store.close();
});

test('members are relabelled: the prompt carries no QQ number and no group id', async () => {
  const h = harness();
  h.seed(3, { userId: '30001' });
  h.seed(3, { userId: '30002', at: CLOCK - 30000, start: 10 });
  await h.qzone.tick(h.call);
  const prompt = h.model.calls[0].map(item => item.content).join('\n');
  assert.ok(!prompt.includes('30001'));
  assert.ok(!prompt.includes('30002'));
  assert.ok(!prompt.includes('20000'));
  assert.ok(prompt.includes('群友1：'));
  h.store.close();
});

test('private messages never enter the material pool', async () => {
  const h = harness();
  const observed = h.qzone.observe(h.event([{ type: 'text', data: { text: '这是私聊里说的话' } }], { message_type: 'private' }));
  assert.equal(observed, false);
  assert.equal(h.store.recentMessages('30001').length, 0);
  h.store.close();
});

test('observe keeps whitelisted group messages and ignores other groups', async () => {
  const h = harness();
  const text = '今天食堂的番茄炒蛋很好吃';
  assert.equal(h.qzone.observe(h.event([{ type: 'text', data: { text } }])), true);
  assert.equal(h.qzone.observe(h.event([{ type: 'text', data: { text } }], { group_id: '40000' })), false);
  const rows = h.store.recentMessages('20000');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, text);
  h.store.close();
});

test('below the batch threshold nothing is evaluated and the material is kept', async () => {
  const h = harness();
  h.seed(2);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 0);
  assert.equal(Number(h.store.setting('qzone:cursor', '0')), 0);
  h.store.close();
});

// --- frequency gates --------------------------------------------------------

test('the daily cap stops evaluation instead of publishing less', async () => {
  const h = harness({ overrides: { qzoneMaxPerDay: 1, qzoneMinGapHours: 1 } });
  h.seed(3, { at: CLOCK - 60000 });
  assert.equal(await h.qzone.tick(h.call), true);
  h.seed(3, { at: CLOCK - 1000, start: 10 });
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.sent.filter(entry => entry.action === 'send_qzone_msg').length, 1);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_daily_cap'));
  h.store.close();
});

test('the minimum gap holds a second post back even under the daily cap', async () => {
  const h = harness({ overrides: { qzoneMaxPerDay: 3, qzoneMinGapHours: 6 } });
  h.seed(3, { at: CLOCK - 60000 });
  assert.equal(await h.qzone.tick(h.call), true);
  h.clock.value = CLOCK + 3600000;
  h.seed(3, { at: CLOCK + 3000000, start: 10 });
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 1);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_min_gap'));
  h.store.close();
});

test('nothing is evaluated outside the allowed hours', async () => {
  const h = harness({ overrides: { qzoneHours: '9-12' } });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 0);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_window'));
  h.store.close();
});

test('the hour window is inclusive at both ends', () => {
  assert.equal(hourAllowed(8, '9-23'), false);
  assert.equal(hourAllowed(9, '9-23'), true);
  assert.equal(hourAllowed(23, '9-23'), true);
  assert.equal(hourAllowed(12, '坏了'), false);
});

// --- failures ---------------------------------------------------------------

test('a rate limit stops the rest of the day without a retry', async () => {
  let attempts = 0;
  const h = harness({ transport: action => { if (action === 'send_qzone_msg') { attempts += 1; return { retcode: -10000 }; } return {}; } });
  h.seed(3, { at: CLOCK - 60000 });
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(attempts, 1);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_rate_limited'));
  assert.equal(h.store.listQzonePosts()[0].status, 'failed');
  assert.equal(h.store.setting(`qzone:blocked:${budgetDay(CLOCK)}`, '0'), '1');
  h.seed(3, { at: CLOCK + 1000, start: 10 });
  h.clock.value = CLOCK + 600000;
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(attempts, 1);
  assert.equal(h.model.calls.length, 1);
  h.store.close();
});

test('an unavailable action disables the feature for the rest of the process', async () => {
  const h = harness({ transport: () => { throw new Error('ONEBOT_ACTION_FAILED'); } });
  h.seed(3, { at: CLOCK - 60000 });
  assert.equal(await h.qzone.tick(h.call), false);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_unavailable'));
  assert.equal(h.store.listQzonePosts()[0].status, 'failed');
  h.seed(3, { at: CLOCK - 1000, start: 10 });
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 1);
  h.store.close();
});

test('a failed publish is attempted exactly once', async () => {
  let attempts = 0;
  const h = harness({ transport: () => { attempts += 1; throw new Error('ONEBOT_TIMEOUT'); } });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(attempts, 1);
  assert.equal(h.store.listQzonePosts()[0].status, 'failed');
  assert.ok(h.logs.some(entry => entry.event === 'qzone_send_failed'));
  h.store.close();
});

test('a missing tid is a failure, never a silent success', async () => {
  let attempts = 0;
  const h = harness({ transport: () => { attempts += 1; return {}; } });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(attempts, 1);
  assert.equal(h.store.listQzonePosts()[0].status, 'failed');
  assert.equal(h.store.listQzonePosts()[0].reason, 'no_tid');
  h.store.close();
});

// --- the model's answer -----------------------------------------------------

test('"not worthy" consumes the batch so the same material is not paid for twice', async () => {
  const h = harness({ reply: '{"worthy":false}' });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(Number(h.store.setting('qzone:cursor', '0')), CLOCK - 60000 + 2);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_skipped' && entry.detail.reason === 'unworthy'));
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.sent.length, 0);
  h.store.close();
});

test('an unparsable reply is reported, not treated as "not worthy"', async () => {
  const h = harness({ reply: '今天没什么好说的' });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_skipped' && entry.detail.reason === 'unparsed'));
  assert.equal(h.sent.length, 0);
  h.store.close();
});

test('a budget too small for one evaluation stops before the model call', async () => {
  const h = harness({ overrides: { budgetMicro: 1 } });
  h.seed(3);
  assert.equal(await h.qzone.tick(h.call), false);
  assert.equal(h.model.calls.length, 0);
  assert.ok(h.logs.some(entry => entry.event === 'qzone_budget_short'));
  h.store.close();
});

test('the decision parser finds the JSON object inside a chatty reply', () => {
  assert.deepEqual(parseDecision('好的：\n```json\n{"worthy":true,"text":"今天真好"}\n```'), { worthy: true, text: '今天真好' });
  assert.deepEqual(parseDecision('{"worthy":false}'), { worthy: false, text: '' });
  assert.equal(parseDecision('今天没什么好说的'), null);
  assert.equal(parseDecision('{"text":"没有 worthy 字段"}'), null);
});

test('the error code is read from a payload or from an error message', () => {
  assert.equal(codeOf({ retcode: -10000 }), -10000);
  assert.equal(codeOf({ data: { retcode: -3000 } }), -3000);
  assert.equal(codeOf(new Error('send_qzone_msg failed: -10006')), -10006);
  assert.equal(codeOf(new Error('ONEBOT_TIMEOUT')), null);
});
