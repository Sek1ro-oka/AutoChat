// T-031a：`/api/logs` 的每条记录多一个脱敏后的 `detail`。这些用例只碰 `readLogs`，
// 不起服务器、不读真实日志目录 —— 每个用例自建临时目录，结束时整个删掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogs } from '../src/console/logs.js';

// 写一个当日文件（内容是逐行 JSON，尾巴可以留半行），返回目录。
function fixture(t, lines) {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-logs-detail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, '2026-10-08.jsonl'), lines.join('\n') + '\n');
  return dir;
}
const json = record => JSON.stringify(record);

test('a clean detail rides along next to time and event, keys sorted', t => {
  const dir = fixture(t, [
    json({ time: '2026-10-08T01:00:00.000Z', event: 'service_started' }),
    json({ time: '2026-10-08T01:00:01.000Z', event: 'permissions_failed',
      detail: { reason: 'icacls: access denied', label: 'data', attempts: 3, dry: true } }),
  ]);
  const [newest, oldest] = readLogs(dir);
  // 字段顺序不变：time、event，然后才是 detail。
  assert.deepEqual(Object.keys(newest), ['time', 'event', 'detail']);
  assert.deepEqual(newest, { time: '2026-10-08T01:00:01.000Z', event: 'permissions_failed',
    detail: { attempts: 3, dry: true, label: 'data', reason: 'icacls: access denied' } });
  // 原本没有 detail 的记录现在也带这个字段，值是 null —— 表里那一列不会时有时无。
  assert.deepEqual(oldest, { time: '2026-10-08T01:00:00.000Z', event: 'service_started', detail: null });
});

test('only identifier keys and scalar values survive, and eight is the cap', t => {
  const many = {}; for (let n = 1; n <= 10; n += 1) many[`k${String(n).padStart(2, '0')}`] = n;
  const dir = fixture(t, [
    json({ time: '2026-10-08T01:00:00.000Z', event: 'x',
      detail: { nested: { a: 1 }, list: [1, 2], nil: null, Bad: 'v', 'has space': 'v' } }),
    json({ time: '2026-10-08T01:00:01.000Z', event: 'x', detail: many }),
    json({ time: '2026-10-08T01:00:02.000Z', event: 'x', detail: ['an array is not a detail'] }),
    json({ time: '2026-10-08T01:00:03.000Z', event: 'x', detail: 'a string is not a detail' }),
    json({ time: '2026-10-08T01:00:04.000Z', event: 'x', detail: 42 }),
  ]);
  // 从文件尾往前读，所以这里拿到的是新 -> 旧。
  const [number, string, array, capped, scalars] = readLogs(dir);
  assert.equal(scalars.detail, null, '对象 / 数组 / null 值整项丢弃，坏键名也丢，洗完不剩一个键');
  assert.deepEqual(Object.keys(capped.detail), ['k01', 'k02', 'k03', 'k04', 'k05', 'k06', 'k07', 'k08'],
    '按 key 升序，第 9 项起丢弃');
  assert.equal(capped.detail.k08, 8);
  for (const record of [array, string, number]) assert.equal(record.detail, null, '非普通对象一律 null');
});

test('secret-shaped strings are replaced and long strings are cut at 120', t => {
  const dir = fixture(t, [json({ time: '2026-10-08T01:00:00.000Z', event: 'config_reload', detail: {
    api_key: 'sk-abcdefghijklmnop',
    auth: 'Bearer abc.def.ghi',
    url: 'https://h/?token=deadbeef&page=1',
    reason: 'key=zzz failed',
    plain: 'token counts are fine',
    note: 'x'.repeat(200),
    spaced: '  两边空白  ',
  } })]);
  const [record] = readLogs(dir);
  assert.equal(record.detail.api_key, '[已隐去]');
  assert.equal(record.detail.auth, '[已隐去]');
  assert.equal(record.detail.url, 'https://h/?[已隐去]&page=1');
  assert.equal(record.detail.reason, '[已隐去] failed');
  assert.equal(record.detail.plain, 'token counts are fine', '没有 `=` 的普通词不算密钥');
  assert.equal(record.detail.note.length, 121, '120 个字符 + 一个省略号');
  assert.ok(record.detail.note.endsWith('…'));
  assert.equal(record.detail.spaced, '两边空白', '首尾空白去掉');
});

test('garbage records degrade to a null detail and bad lines are skipped, never thrown', t => {
  const dir = fixture(t, [
    'not json at all',
    '',
    json({ time: '', event: 'service_started', detail: { label: 'data' } }),
    'null', '[]', '"a string"', '42',
    json({ time: '2026-10-08T01:00:04.000Z', event: 42 }),
    json({ time: 42, event: 'config_reload', detail: {} }),
    json({ time: '2026-10-08T01:00:03.000Z', event: 'permissions_failed', detail: { reason: 'ok', x: {} } }),
    '{"time":"2026-10-08T01:00:02.000Z","event":"half',
  ]);
  assert.doesNotThrow(() => readLogs(dir));
  const records = readLogs(dir);
  // 非字符串 event 的记录整条跳过；能读出 event 的都还在，从文件尾往前读（最新在前）。
  assert.deepEqual(records.map(record => record.event), ['permissions_failed', 'config_reload', 'service_started']);
  assert.deepEqual(records[0].detail, { reason: 'ok' }, '{} 值被丢掉，旁边的键保住');
  assert.equal(records[1].time, null, '非字符串 time 退化成 null，字段本身还在');
  assert.equal(records[1].detail, null, '空 detail 洗完什么都不剩');
  assert.deepEqual(records[2].detail, { label: 'data' });
  for (const record of records) assert.deepEqual(Object.keys(record), ['time', 'event', 'detail']);
  assert.deepEqual(readLogs(join(dir, 'missing')), [], '目录不存在时返回空数组');
});
