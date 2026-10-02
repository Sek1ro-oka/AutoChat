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
