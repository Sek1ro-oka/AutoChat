// state/ 清理脚本（scripts/prune-state.mjs）的回归测试。
//
// 覆盖点（每条都对应一个「手滑就丢数据」的位置）：
// 1. 阈值线：**严格早于**阈值才删，正好在线上的留下；
// 2. 设备截图优先认文件名里的 `shot-<epoch ms>`，mtime 被改写也不会误留；
// 3. 只看图片扩展名，目录里混进来的别的文件不碰；
// 4. `--device-days 0` / `--tmp-days 0` 是「不动」，不是「全清」；
// 5. `--dry-run` 一个文件都不删、账本一行都不动；
// 6. 账本按自然月归档：保留当月 + 上月，更早的进 `state/archive/`；
// 7. 解析不了的行留在原文件（宁可留着看不懂的，也不本地删账）；
// 8. 归档重复跑不会写重复行（按行去重）；
// 9. 桥接在跑（`state/bridge.lock` 的 pid 活着）时拒绝重写账本，除非 `--force`；
// 10. 真跑之后原账本只剩该留的行，归档文件内容与预期逐行相等。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  appendArchive,
  listFiles,
  monthKey,
  monthsToKeep,
  selectExpiredFiles,
  shotTimestamp,
  splitUsageLines,
} from './prune-state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'prune-state.mjs');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 2, 6, 0, 0); // 2026-11-02T06:00Z
let failed = 0;

function assert(cond, label) {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.error(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : `\n      实际 ${JSON.stringify(actual)}\n      期望 ${JSON.stringify(expected)}`}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-state-test-'));
const stateDir = path.join(tmpRoot, 'state');
const deviceDir = path.join(stateDir, 'device');
const tmpDir = path.join(tmpRoot, 'work', 'tmp');
const archiveDir = path.join(stateDir, 'archive');
fs.mkdirSync(deviceDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

function touch(dir, name, { mtimeMs, content = 'x' }) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, content, 'utf8');
  const t = new Date(mtimeMs);
  fs.utimesSync(full, t, t);
  return full;
}
function fileNames(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ── 纯函数：时间与月份 ────────────────────────────────────────────────
console.log('纯函数');
eq(shotTimestamp('shot-1792588125334.png'), 1792588125334, 'shot 文件名取时间戳');
eq(shotTimestamp('shot-1.png'), null, '位数不够不认');
eq(shotTimestamp('screenshot.png'), null, '别的名字不认');
eq(monthKey(Date.UTC(2026, 10, 2)), '2026-11', 'monthKey 本地时区归月');
eq([...monthsToKeep(NOW, 2)].sort(), ['2026-10', '2026-11'], '保留当月 + 上月');
eq([...monthsToKeep(Date.UTC(2026, 0, 15), 3)].sort(), ['2025-11', '2025-12', '2026-01'], '跨年回退正确');
eq([...monthsToKeep(Date.UTC(2026, 2, 31), 2)].sort(), ['2026-02', '2026-03'], '31 号回退不跳月');

// ── 纯函数：阈值与筛选 ────────────────────────────────────────────────
console.log('selectExpiredFiles');
const entries = [
  { name: 'old.png', path: '/x/old.png', size: 10, mtimeMs: NOW - 10 * DAY },
  { name: 'edge.png', path: '/x/edge.png', size: 20, mtimeMs: NOW - 7 * DAY },
  { name: 'new.png', path: '/x/new.png', size: 30, mtimeMs: NOW - DAY },
  { name: 'note.txt', path: '/x/note.txt', size: 40, mtimeMs: NOW - 30 * DAY },
];
const picked = selectExpiredFiles(entries, { now: NOW, days: 7, exts: ['.png'] });
eq(picked.map((f) => f.name), ['old.png'], '只删严格过期的图片，阈值线与新文件留下');
eq(picked[0].tsSource, 'mtime', '没有文件名时间戳时退回 mtime');
eq(selectExpiredFiles(entries, { now: NOW, days: 0, exts: ['.png'] }), [], 'days=0 表示不动');
const nameTsEntry = [
  { name: 'shot-1792588125334.png', path: '/x/a.png', size: 1, mtimeMs: NOW },
];
eq(
  selectExpiredFiles(nameTsEntry, { now: NOW, days: 7, exts: ['.png'], useNameTs: true }).map((f) => f.tsSource),
  ['name'],
  '文件名时间戳优先于 mtime',
);
eq(
  selectExpiredFiles(nameTsEntry, { now: NOW, days: 7, exts: ['.png'], useNameTs: false }),
  [],
  '关掉 useNameTs 就只看 mtime',
);

// ── 纯函数：账本切分 ──────────────────────────────────────────────────
console.log('splitUsageLines');
const sep = JSON.stringify({ t: Date.UTC(2026, 8, 20, 3), key: 'private:1', b: {} }); // 2026-09
const oct = JSON.stringify({ t: Date.UTC(2026, 9, 20, 3), key: 'private:1', b: {} }); // 2026-10
const nov = JSON.stringify({ t: Date.UTC(2026, 10, 2, 3), key: 'private:1', b: {} }); // 2026-11
const junk = 'not json at all';
const noTs = JSON.stringify({ k: 'base' });
const split = splitUsageLines([sep, oct, nov, junk, noTs, ''], { now: NOW, keepMonths: 2 });
eq(split.keep, [oct, nov, junk, noTs], '当月与上月留着，无法解析/无时间戳的也留着');
eq(split.archive.map((b) => [b.month, b.lines.length]), [['2026-09', 1]], '只归档「上月之前」的月份');
eq(split.invalid, 2, '统计无法解析的行数');

// ── 端到端：--dry-run 不动手 ──────────────────────────────────────────
console.log('CLI --dry-run');
touch(deviceDir, 'shot-' + (NOW - 20 * DAY) + '.png', { mtimeMs: NOW, content: 'aaa' });
touch(deviceDir, 'shot-' + (NOW - 2 * DAY) + '.png', { mtimeMs: NOW, content: 'bb' });
const ledger = path.join(stateDir, 'token-usage.jsonl');
fs.writeFileSync(ledger, [sep, oct, nov, junk].join('\n') + '\n', 'utf8');
const before = fileNames(deviceDir);

const dry = spawnSync(process.execPath, [
  script, '--dry-run', '--json',
  '--state-dir', stateDir, '--device-days', '7', '--archive-usage', '--now', String(NOW),
], { encoding: 'utf8' });
const dryReport = JSON.parse(dry.stdout);
eq(dry.status, 0, '--dry-run 退出码 0');
eq(dryReport.dryRun, true, '报告标记 dryRun');
eq(dryReport.device.files.map((f) => f.ageDays), [20], '只列出 20 天前那张');
eq(fileNames(deviceDir), before, 'dry-run 没删任何截图');
eq(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean), [sep, oct, nov, junk], 'dry-run 没动账本');
eq(fs.existsSync(archiveDir), false, 'dry-run 没建归档目录');

// ── 端到端：真跑 ──────────────────────────────────────────────────────
console.log('CLI 真跑');
const real = spawnSync(process.execPath, [
  script, '--json',
  '--state-dir', stateDir, '--device-days', '7',
  '--tmp-dir', tmpDir, '--tmp-days', '3',
  '--archive-usage', '--now', String(NOW),
], { encoding: 'utf8' });
eq(real.status, 0, '真跑退出码 0');
const report = JSON.parse(real.stdout);
eq(report.device.files.map((f) => f.name), ['shot-' + (NOW - 20 * DAY) + '.png'], '删掉过期截图');
eq(fileNames(deviceDir).length, 1, '新截图还在');
eq(fs.existsSync(archiveDir), true, '建了 archive 目录');
const archived = fs.readFileSync(path.join(archiveDir, 'token-usage-2026-09.jsonl'), 'utf8').split('\n').filter(Boolean);
eq(archived, [sep], '9 月的行进归档文件');
eq(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean), [oct, nov, junk], '原账本只剩该留的行');

// ── 归档去重：再跑一次不写重复行 ──────────────────────────────────────
console.log('归档幂等');
eq(appendArchive(path.join(archiveDir, 'token-usage-2026-09.jsonl'), [sep]), 0, '已归档的行不重复写');
eq(appendArchive(path.join(archiveDir, 'token-usage-2026-09.jsonl'), [sep, oct]), 1, '只写真正新增的行');

// ── bridge.lock 活着时拒绝改账本 ──────────────────────────────────────
console.log('bridge.lock 拦截');
fs.writeFileSync(ledger, [sep, oct, nov].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(stateDir, 'bridge.lock'), String(process.pid), 'utf8'); // 自己一定是活的
const guarded = spawnSync(process.execPath, [
  script, '--json', '--state-dir', stateDir, '--no-device',
  '--archive-usage', '--now', String(NOW),
], { encoding: 'utf8' });
const guardedReport = JSON.parse(guarded.stdout);
eq(guarded.status, 0, '被拦截也不算失败退出');
eq(typeof guardedReport.usage.skipped, 'string', '回报了跳过原因');
eq(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean), [sep, oct, nov], '账本一行没变');
const forced = spawnSync(process.execPath, [
  script, '--json', '--state-dir', stateDir, '--no-device',
  '--archive-usage', '--force', '--now', String(NOW),
], { encoding: 'utf8' });
eq(JSON.parse(forced.stdout).usage.archivedLines, 1, '--force 时照样归档 9 月那 1 行');
eq(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean), [oct, nov], 'force 之后账本只剩当月与上月');

// ── listFiles 只拿下一层、不递归 ──────────────────────────────────────
console.log('listFiles');
fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
touch(path.join(tmpDir, 'sub'), 'deep.txt', { mtimeMs: NOW - 30 * DAY });
touch(tmpDir, 'top.txt', { mtimeMs: NOW - 30 * DAY });
eq(listFiles(tmpDir).map((f) => f.name).sort(), ['top.txt'], '不递归进子目录');

// ── 收尾 ──────────────────────────────────────────────────────────────
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

if (failed) {
  console.error(`\n❌ prune-state 测试失败：${failed} 条`);
  process.exit(1);
}
console.log('\n🎉 prune-state 清理脚本测试通过');
