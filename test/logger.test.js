import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../src/logger.js';

test('logger removes only old daily files and rejects arbitrary content', t => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-log-test-'));
  t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
  writeFileSync(join(dir, '2000-01-01.jsonl'), 'old');
  writeFileSync(join(dir, 'keep.txt'), 'unrelated');
  const log = createLogger(dir);
  log('private content or secret');
  log('service_started');
  assert.ok(!readdirSync(dir).includes('2000-01-01.jsonl'));
  assert.ok(readdirSync(dir).includes('keep.txt'));
  const current = readdirSync(dir).find(name => name.endsWith('.jsonl'));
  const lines = readFileSync(join(dir, current), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); assert.equal(JSON.parse(lines[0]).event, 'service_started');
});

test('a structured detail rides along, and free text still cannot', t => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-log-detail-'));
  t.after(() => { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); });
  const log = createLogger(dir);
  // The event-name guard is unchanged (D-08 is a later batch): whatever the
  // second argument holds, an invalid name is still dropped whole.
  log('permissions_failed!', { label: 'data', reason: 'denied' });
  // Strings, numbers, arrays and null are ignored on purpose: that is the shape a
  // caller reaches for while trying to log a chat message, and this logger is the
  // only thing standing between that and a file the console reads (security §3.3).
  log('permissions_failed', '群友的原话：这波 666');
  log('permissions_failed', ['群友的原话']);
  log('permissions_failed', null);
  log('service_started', { label: 'data', reason: 'icacls: access denied' });
  const current = readdirSync(dir).find(name => name.endsWith('.jsonl'));
  const records = readFileSync(join(dir, current), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.event),
    ['permissions_failed', 'permissions_failed', 'permissions_failed', 'service_started']);
  for (const record of records) {
    assert.deepEqual(Object.keys(record), record.detail === undefined ? ['time', 'event'] : ['time', 'event', 'detail']);
  }
  assert.deepEqual(records[0].detail, undefined, 'an array is not a detail');
  assert.deepEqual(records[1].detail, undefined, 'a string is not a detail');
  assert.deepEqual(records[2].detail, undefined, 'null is not a detail');
  assert.deepEqual(records[3].detail, { label: 'data', reason: 'icacls: access denied' });
  assert.equal(readFileSync(join(dir, current), 'utf8').includes('群友的原话'), false,
    'no free text reaches the file by any route');
});
