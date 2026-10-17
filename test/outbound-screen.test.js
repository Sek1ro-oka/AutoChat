import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_SENTENCE, screenOutbound } from '../src/outbound-screen.js';
import { OneBot } from '../src/onebot.js';

const text = value => [{ type: 'text', data: { text: value } }];
const group = value => ({ group_id: 20000, message: text(value) });
const privateChat = value => ({ user_id: 30001, message: text(value) });
const body = screened => screened.params.message[0].data.text;

// --- scope -------------------------------------------------------------------

test('only the three send actions are inspected', () => {
  const params = group('看 C:\\Users\\me\\x.txt');
  for (const action of ['get_group_list', 'send_like', 'set_group_ban']) {
    assert.deepEqual(screenOutbound(action, params), { params, verdict: 'pass', reason: null }, action);
  }
  assert.equal(screenOutbound('send_group_msg', null).verdict, 'pass', 'no params, nothing to inspect');
  assert.equal(screenOutbound('send_group_msg', {}).verdict, 'pass', 'no message, nothing to inspect');
  assert.equal(screenOutbound('send_group_msg', { message: 42 }).verdict, 'pass', 'an unknown shape is left alone');
});

test('non-text segments are never rewritten', () => {
  const message = [
    { type: 'image', data: { file: 'C:\\Users\\me\\x.png' } },
    { type: 'at', data: { qq: '10000' } },
    { type: 'face', data: { id: '14' } },
  ];
  const params = { group_id: 20000, message };
  const screened = screenOutbound('send_group_msg', params);
  assert.equal(screened.verdict, 'pass');
  assert.deepEqual(screened.params.message, message, 'not a single segment object was rebuilt');
});

test('a mixed message rewrites only the text segment', () => {
  const image = { type: 'image', data: { file: 'C:\\Users\\me\\x.png' } };
  const params = { group_id: 20000, message: [{ type: 'at', data: { qq: '1' } }, ...text('截图 C:\\Users\\me\\x.png 在这'), image] };
  const screened = screenOutbound('send_group_msg', params);
  assert.equal(screened.verdict, 'mask');
  assert.equal(screened.params.message[0], params.message[0], 'the @ is untouched');
  assert.equal(screened.params.message[2], image, 'the image is untouched');
  assert.ok(!screened.params.message[1].data.text.includes('Users'));
});

// --- L1: masking, groups only ------------------------------------------------

test('a private chat is never masked', () => {
  const screened = screenOutbound('send_private_msg', privateChat('文件在 C:\\Users\\me\\x.txt，自己拿'));
  assert.equal(screened.verdict, 'pass');
  assert.equal(body(screened), '文件在 C:\\Users\\me\\x.txt，自己拿', 'verbatim, byte for byte');
  assert.equal(screened.reason, null);
});

test('a group masks local paths, URLs and long digit runs, keeping the ends', () => {
  const cases = [
    ['C:\\Users\\me\\x.txt', 'C:\\U….txt', 'windows_path'],
    ['\\\\nas\\share\\a.log', '\\\\na….log', 'unc_path'],
    ['https://example.com/a/b?q=1', 'http…?q=1', 'url'],
    ['1234567890123456', '1234…3456', 'long_digits'],
  ];
  for (const [original, expected, reason] of cases) {
    const screened = screenOutbound('send_group_msg', group(`前后 ${original} 前后`));
    assert.equal(screened.verdict, 'mask', original);
    assert.equal(screened.reason, reason, original);
    assert.equal(body(screened), `前后 ${expected} 前后`, original);
  }
});

test('QQ numbers and millisecond timestamps stay readable', () => {
  for (const value of ['12345', '12345678901', '1700000000000']) {
    const screened = screenOutbound('send_group_msg', group(`这个 ${value} 是多久`));
    assert.equal(screened.verdict, 'pass', value);
    assert.equal(body(screened), `这个 ${value} 是多久`, value);
  }
});

test('masking copies the params instead of mutating the caller\'s', () => {
  const params = group('看 C:\\Users\\me\\x.txt');
  const before = JSON.stringify(params);
  screenOutbound('send_group_msg', params);
  assert.equal(JSON.stringify(params), before, 'the caller still owns its object');
});

// --- L2: blocking ------------------------------------------------------------

test('the five provider-prefixed shapes are replaced by a fixed sentence', () => {
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    `AIza${'abcdefghij'.repeat(3)}abcde`,
    'ghp_012345678901234567890123456789012345',
    `github_pat_${'a'.repeat(82)}`,
    'xoxb-1234567890-1234567890123-abcdef',
  ];
  for (const secret of secrets) {
    const screened = screenOutbound('send_group_msg', group(`配置里是 ${secret} 别外传`));
    assert.equal(screened.verdict, 'block', secret);
    assert.equal(body(screened), BLOCKED_SENTENCE, 'the whole segment goes, not just the match');
    assert.ok(!body(screened).includes(secret));
  }
});

test('a block is not a silent drop', () => {
  const screened = screenOutbound('send_private_msg', privateChat('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(screened.verdict, 'block', 'private chat blocks too: the leak does not care where it goes');
  assert.equal(body(screened), BLOCKED_SENTENCE);
  assert.notEqual(body(screened), '', 'an empty message would look like a deliberate silence');
});

// --- the allowlists ----------------------------------------------------------

test('the counterexamples from the acceptance list are not secrets', () => {
  for (const line of ['token 过期了', 'api_id=123', '000000', 'token 过期了，api_id=123，验证码 000000']) {
    const screened = screenOutbound('send_group_msg', group(line));
    assert.equal(screened.verdict, 'pass', line);
    assert.equal(screened.reason, null, `${line} must not even be logged`);
    assert.equal(body(screened), line);
  }
});

test('the allowlists narrow only the generic rule', () => {
  const wordOnly = screenOutbound('send_group_msg', group('token = abcdefghij'));
  assert.equal(wordOnly.reason, null, 'a value that is only letters is a word, not a key');

  const knownKey = screenOutbound('send_group_msg', group('csrf_token = A1b2C3d4E5f6G7h8'));
  assert.equal(knownKey.reason, null, 'api_id / csrf_token and friends are names, not credentials');
});

// --- L3: the generic fallback ------------------------------------------------

test('a generic high-entropy value is reported and sent unchanged', () => {
  const line = 'password = "Zx9Qw3Lm7Np2Rt5V"';
  const screened = screenOutbound('send_group_msg', group(line));
  assert.equal(screened.verdict, 'pass', 'screening sees a shape, not a certainty');
  assert.equal(screened.reason, 'generic_secret');
  assert.equal(body(screened), line, 'so the line still goes out');
});

test('a low-entropy or short value is not even reported', () => {
  assert.equal(screenOutbound('send_group_msg', group('password = aaaaaaaaaaaaaaaa')).reason, null);
  assert.equal(screenOutbound('send_group_msg', group('password = abc')).reason, null);
});

// --- wired into the transport ------------------------------------------------

test('OneBot.call sends the screened params and logs what it did', async () => {
  const logs = [];
  const sent = [];
  const transport = new OneBot({ actionTimeoutMs: 20 }, { log: (event, detail) => logs.push({ event, detail }) });
  transport.generation = 1;
  transport.socket = { readyState: 1, send: (raw, done) => { sent.push(JSON.parse(raw)); done(); } };
  // The fake socket never answers the echo, so each call ends in its timeout;
  // that is fine — what matters is the frame that went out and the log line.
  const call = (action, params) => assert.rejects(transport.call(action, params), /ONEBOT_TIMEOUT/);

  await call('send_group_msg', group('看 C:\\Users\\me\\x.txt'));
  assert.equal(sent[0].params.message[0].data.text, '看 C:\\U….txt');

  await call('send_group_msg', group('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(sent[1].params.message[0].data.text, BLOCKED_SENTENCE);

  await call('send_group_msg', group('password = "Zx9Qw3Lm7Np2Rt5V"'));
  assert.equal(sent[2].params.message[0].data.text, 'password = "Zx9Qw3Lm7Np2Rt5V"', 'L3 sends as is');

  await call('send_private_msg', privateChat('C:\\Users\\me\\x.txt'));
  assert.equal(sent[3].params.message[0].data.text, 'C:\\Users\\me\\x.txt');

  assert.deepEqual(logs.map(item => item.event),
    ['social_outbound_masked', 'social_outbound_blocked', 'social_outbound_generic_secret']);
  assert.deepEqual(logs[0].detail, { action: 'send_group_msg', rule: 'windows_path' });
  assert.deepEqual(logs[1].detail, { action: 'send_group_msg', rule: 'aws_access_key_id' }, 'the rule, never the text');
  assert.ok(!JSON.stringify(logs).includes('Users'), 'the log carries no message body');
});

test('OneBot.call leaves a clean frame alone and logs nothing', async () => {
  const logs = [];
  const sent = [];
  const transport = new OneBot({ actionTimeoutMs: 20 }, { log: event => logs.push(event) });
  transport.generation = 1;
  transport.socket = { readyState: 1, send: (raw, done) => { sent.push(JSON.parse(raw)); done(); } };

  await assert.rejects(transport.call('send_group_msg', group('今天打本吗')), /ONEBOT_TIMEOUT/);
  assert.equal(sent[0].params.message[0].data.text, '今天打本吗');
  assert.deepEqual(logs, []);
});
