// Failure forensics for the logger itself (I-03 · Phase A). Two questions: what
// does a failure leave behind when the logger is the thing that broke, and what
// must never be left behind at all — the body of a chat message, or the name of
// an event that was rejected for being illegible.
//
// The rejected name is the subtle one. `invalid_event_name` is a *trace* that an
// illegible name was seen, not a copy of it: an ASCII single word would satisfy
// any character whitelist and still be a group member's message, so the detail
// carries the type of the name and nothing else — no text, no length, no digest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, errorDetail } from '../src/logger.js';

const withTemp = body => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-log-forensics-'));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// A fresh logger writes exactly one file. Reading it as raw text matters as much
// as parsing it: a leak could sit outside the fields the assertions look at.
const jsonl = dir => {
  const name = readdirSync(dir).filter(file => file.endsWith('.jsonl')).at(-1);
  return { name, text: readFileSync(join(dir, name), 'utf8') };
};
const records = dir => jsonl(dir).text.trim().split('\n').map(line => JSON.parse(line));

test('a rejected event name leaves one trace and never the name itself', () => withTemp(dir => {
  const log = createLogger(dir);
  log('Slang_Import_V2', { a: 1 });
  log('Another_Bad Name');
  const lines = records(dir);
  // One occurrence is enough to locate the defect, and a counter would itself be
  // a channel for caller text.
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'invalid_event_name');
  assert.deepEqual(lines[0].detail, { kind: 'string' }, 'nothing but the type of the rejected name');
  const { text } = jsonl(dir);
  assert.equal(text.includes('Slang_Import_V2'), false, 'the rejected name reached the log file');
  assert.equal(text.includes('Another_Bad Name'), false);
}));

// The most important regression of this batch: a chat message must not become
// log content by being passed where an event name belongs.
test('a chat message used as an event name reaches no log file by any route', () => withTemp(dir => {
  const log = createLogger(dir);
  log('这是一条聊天正文，含空格与标点');
  log('666');
  log('Hello_world');
  const lines = records(dir);
  assert.equal(lines.length, 1, 'still only the first rejection is traced');
  assert.equal(lines[0].event, 'invalid_event_name');
  assert.deepEqual(Object.keys(lines[0].detail), ['kind'], 'no head, no length, no digest of the text');
  const { text } = jsonl(dir);
  for (const body of ['这是一条聊天正文，含空格与标点', '666', 'Hello_world']) {
    assert.equal(text.includes(body), false, `a chat body reached the log: ${body}`);
  }
}));

test('errorDetail keeps a short name and one bounded line of message', () => {
  const long = errorDetail(new Error('x'.repeat(1000)));
  assert.equal(long.name, 'Error');
  assert.equal(long.message.length, 300, 'a 1000-character message is cut to the cap');
  // A stack holds absolute paths and source excerpts, and the error object itself
  // can hold arbitrary fields. Neither may ride along.
  assert.deepEqual(Object.keys(long), ['name', 'message']);
  const noisy = errorDetail(Object.assign(new Error('第一行\n第二行\t缩进'), { stack: 'STACK_SECRET', extra: 'FIELD_SECRET' }));
  assert.equal(noisy.message, '第一行 第二行 缩进', 'newlines are folded so one record stays one line');
  assert.equal(JSON.stringify(noisy).includes('SECRET'), false);
  const renamed = new TypeError('bad');
  Object.assign(renamed, { name: 'B'.repeat(200) });
  assert.equal(errorDetail(renamed).name.length, 60, 'even the name is bounded');
  // §6 of the task forbids `String(error)`, so a thrown non-Error has no message
  // to report. The result still has to be a plain object the whitelist accepts.
  for (const thrown of ['boom', undefined, null, 42]) {
    const detail = errorDetail(thrown);
    assert.deepEqual(detail, { name: 'Error', message: '' });
    assert.equal(Array.isArray(detail), false);
  }
});

test('a bounded errorDetail survives the detail whitelist into the jsonl', () => withTemp(dir => {
  const log = createLogger(dir);
  log('turn_failed', errorDetail(new Error('x'.repeat(1000))));
  const [record] = records(dir);
  assert.deepEqual(Object.keys(record), ['time', 'event', 'detail']);
  assert.equal(record.event, 'turn_failed');
  assert.equal(record.detail.name, 'Error');
  assert.equal(record.detail.message.length, 300, 'the detail was silently dropped instead of written');
}));

// A file is named after the UTC day, and every line inside it is stamped with
// that same day. The billing day is a *different* calendar (China time, see
// src/store.js) and must never be derived from this name.
test('every line carries the day of the file it lives in', () => withTemp(dir => {
  const log = createLogger(dir);
  log('service_started');
  log('invalid_event_name', { kind: 'string' });
  const { name, text } = jsonl(dir);
  assert.equal(name, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert.equal(text.trim().split('\n').length, 2);
  for (const record of records(dir)) assert.equal(record.time.slice(0, 10), name.slice(0, 10));
}));

// Rotation and writing are the logger's own failure modes: one used to be
// swallowed outright, the other reported without a reason. Neither may throw,
// because that would turn an unrelated bug into a crash.
test('a rotation or a write that fails is reported and never thrown', t => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-log-broken-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = createLogger(dir);
  const seen = [];
  const original = console.error;
  console.error = (...args) => { seen.push(args); };
  t.after(() => { console.error = original; });
  // A directory that vanished under the process is the everyday Windows case
  // (held open, moved, or a detached drive) and fails both calls at once.
  rmSync(dir, { recursive: true, force: true });
  assert.doesNotThrow(() => log('service_started'));
  assert.doesNotThrow(() => log('service_started'));
  // Two calls, but one rotation attempt: a failed rotation still records the day
  // so the next line does not retry it until tomorrow.
  assert.deepEqual(seen.map(args => args[0]), ['log_rotate_failed', 'log_write_failed', 'log_write_failed']);
  assert.equal(seen[1][1].name, 'Error');
  assert.match(seen[1][1].message, /ENOENT/);
});
