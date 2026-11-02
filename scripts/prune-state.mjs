#!/usr/bin/env node
// state/ 历史垃圾清理：设备截图、work/tmp 临时产物、token 账本归档。
//
// 为什么要它（2026-11-02 复盘）：`state/device/` 攒了 38 张截图共 110 MB，
// `state/token-usage.jsonl` 12,775 行 3.5 MB 且账本自己到 20,000 行就会丢最旧的行，
// 之前没有任何清理入口，只能手删。这个脚本把三件事收敛到一个可预演的命令里。
//
// 用法：
//   node scripts/prune-state.mjs --dry-run          # 只打印计划，不动任何文件（推荐先跑一次）
//   node scripts/prune-state.mjs                    # 真跑：删 7 天前的设备截图
//   node scripts/prune-state.mjs --device-days 3    # 改阈值（0 = 不碰设备截图）
//   node scripts/prune-state.mjs --tmp-days 14      # 顺带清 work/tmp 里 14 天前的文件（默认 0 = 不动）
//   node scripts/prune-state.mjs --archive-usage    # 把账本里「上月及更早」的行归档到 state/archive/
//   node scripts/prune-state.mjs --json             # 机器可读输出（测试用）
//
// 安全约定：
// - **只看文件自己身上的时间**：优先用文件名里的 `shot-<epoch ms>.png`，没有才退回 mtime；
//   不碰「比阈值新」的任何东西，也不做递归删除（只清指定目录的下一层）。
// - `--archive-usage` 会重写账本，**要求桥接已停**（读 `state/bridge.lock` 探活）；
//   桥接还在跑就必须显式 `--force`，否则宁愿什么都不做——账本是花钱的账，不能赌并发写。
// - `--dry-run` 一定不下手；真跑的每一行都先在 stdout 列出被删/被归档的路径。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_STATE_DIR = path.join(root, 'state');
export const DEFAULT_TMP_DIR = path.join(root, 'work', 'tmp');
export const DEFAULT_DEVICE_DIR = 'device'; // state/device
export const DEFAULT_DEVICE_DAYS = 7; // 7 天 = 一周的调试痕迹，够回看
export const DEFAULT_TMP_DAYS = 0; // 0 = 不动 work/tmp（那里常有正在验收的产物）
export const DEFAULT_KEEP_MONTHS = 2; // 账本保留「当月 + 上月」
export const IMAGE_EXTS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);
const DAY_MS = 24 * 60 * 60 * 1000;
const SHOT_NAME_RE = /^shot-(\d{10,16})\.(png|jpe?g|webp)$/i;

/** `shot-1792588125334.png` → 1792588125334；认不出就 null。 */
export function shotTimestamp(name) {
  const m = SHOT_NAME_RE.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * 挑出过期的文件。
 * @param {Array<{name:string,path:string,size:number,mtimeMs:number}>} entries
 * @param {{now:number, days:number, exts?:string[], useNameTs?:boolean}} opts
 * @returns {Array<{name:string,path:string,size:number,ageDays:number,tsSource:string}>}
 */
export function selectExpiredFiles(entries, { now, days, exts = null, useNameTs = false }) {
  if (!(days > 0)) return [];
  const cutoff = now - days * DAY_MS;
  const allowed = exts ? new Set(exts.map((e) => e.toLowerCase())) : null;
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry.mtimeMs !== 'number') continue;
    if (allowed && !allowed.has(path.extname(entry.name || '').toLowerCase())) continue;
    const fromName = useNameTs ? shotTimestamp(entry.name || '') : null;
    const ts = fromName ?? entry.mtimeMs;
    const tsSource = fromName === null ? 'mtime' : 'name';
    if (!(ts < cutoff)) continue; // 严格早于阈值；阈值线上的一律留下
    out.push({
      name: entry.name,
      path: entry.path,
      size: entry.size || 0,
      ageDays: Math.floor((now - ts) / DAY_MS),
      tsSource,
    });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/** 目录的下一层（不递归），拿不到就返回空数组。 */
export function listFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ name, path: full, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** 本地时区的 `YYYY-MM`（账本的时间戳是 epoch ms，按运行机器的时区归月）。 */
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 需要保留的月份集合（含当月，往前数 keepMonths 个月）。 */
export function monthsToKeep(now, keepMonths = DEFAULT_KEEP_MONTHS) {
  const count = Number.isFinite(keepMonths) && keepMonths >= 1 ? Math.floor(keepMonths) : 1;
  const keep = new Set();
  const d = new Date(now);
  for (let i = 0; i < count; i++) {
    keep.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setDate(1); // 先落到 1 号，否则 31 号回退会跳过整月
    d.setMonth(d.getMonth() - 1);
  }
  return keep;
}

/**
 * 把账本行按「保留 / 归档」切开。
 * 解析不了的、没有 `t` 的行一律**留在原文件**——宁可留着看不懂的行，也不本地删账。
 * @param {string[]} lines
 * @param {{now:number, keepMonths?:number}} opts
 */
export function splitUsageLines(lines, { now, keepMonths = DEFAULT_KEEP_MONTHS }) {
  const keepKeys = monthsToKeep(now, keepMonths);
  const keep = [];
  const invalid = [];
  const buckets = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      invalid.push(line);
      keep.push(line);
      continue;
    }
    const ts = typeof rec?.t === 'number' && Number.isFinite(rec.t) ? rec.t : null;
    if (ts === null) {
      invalid.push(line);
      keep.push(line);
      continue;
    }
    const mk = monthKey(ts);
    if (keepKeys.has(mk)) {
      keep.push(line);
      continue;
    }
    if (!buckets.has(mk)) buckets.set(mk, []);
    buckets.get(mk).push(line);
  }
  const archive = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, list]) => ({ month, lines: list }));
  return { keep, archive, invalid: invalid.length, total: lines.filter((l) => l.trim()).length };
}

/** 追加归档：已存在的内容按行去重，反复跑也不会写重复行。 */
export function appendArchive(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = new Set();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    existing = new Set(text.split('\n').filter(Boolean));
  }
  const add = lines.filter((l) => !existing.has(l));
  if (add.length) fs.appendFileSync(file, add.join('\n') + '\n', 'utf8');
  return add.length;
}

/** 原子替换（写临时文件再 rename），避免中途崩掉留下半个账本。 */
export function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 桥接是否还在跑（state/bridge.lock 里是 pid）。 */
export function bridgePid(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, 'bridge.lock'), 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // 只探活，不发信号
    return pid;
  } catch {
    return null;
  }
}

export function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function parseArgs(argv) {
  const opts = {
    stateDir: DEFAULT_STATE_DIR,
    tmpDir: DEFAULT_TMP_DIR,
    deviceDays: DEFAULT_DEVICE_DAYS,
    tmpDays: DEFAULT_TMP_DAYS,
    keepMonths: DEFAULT_KEEP_MONTHS,
    archiveUsage: false,
    device: true,
    dryRun: false,
    json: false,
    force: false,
    now: Date.now(),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '--force': opts.force = true; break;
      case '--archive-usage': opts.archiveUsage = true; break;
      case '--no-device': opts.device = false; break;
      case '--device-days': opts.deviceDays = Number(next()); break;
      case '--tmp-days': opts.tmpDays = Number(next()); break;
      case '--keep-months': opts.keepMonths = Number(next()); break;
      case '--state-dir': opts.stateDir = path.resolve(String(next())); break;
      case '--tmp-dir': opts.tmpDir = path.resolve(String(next())); break;
      case '--now': opts.now = Number(next()); break; // 测试用：把「现在」钉住
      case '-h': case '--help': opts.help = true; break;
      default:
        throw new Error(`未知参数：${arg}（--help 看用法）`);
    }
  }
  for (const key of ['deviceDays', 'tmpDays', 'keepMonths', 'now']) {
    if (!Number.isFinite(opts[key])) throw new Error(`参数 ${key} 必须是数字`);
  }
  return opts;
}

/** 主流程（拆出来是为了单测能塞临时目录）。 */
export function runPrune(opts) {
  const report = {
    dryRun: opts.dryRun,
    now: opts.now,
    stateDir: opts.stateDir,
    device: { dir: null, days: opts.deviceDays, files: [], bytes: 0 },
    tmp: { dir: null, days: opts.tmpDays, files: [], bytes: 0 },
    usage: { file: null, archived: [], keptLines: 0, archivedLines: 0, invalid: 0, skipped: null, bytes: 0 },
  };

  // 1) 设备截图
  if (opts.device && opts.deviceDays > 0) {
    const dir = path.join(opts.stateDir, DEFAULT_DEVICE_DIR);
    report.device.dir = dir;
    const expired = selectExpiredFiles(listFiles(dir), {
      now: opts.now,
      days: opts.deviceDays,
      exts: IMAGE_EXTS,
      useNameTs: true,
    });
    for (const item of expired) {
      if (!opts.dryRun) {
        try {
          fs.unlinkSync(item.path);
        } catch (err) {
          report.device.error = `${item.name}: ${err.message}`;
          continue;
        }
      }
      report.device.files.push({ name: item.name, size: item.size, ageDays: item.ageDays });
      report.device.bytes += item.size;
    }
  }
  // 清完截图顺手删空目录？不删——目录本身是设备工具会用的位置。

  // 2) work/tmp
  if (opts.tmpDays > 0) {
    report.tmp.dir = opts.tmpDir;
    const expired = selectExpiredFiles(listFiles(opts.tmpDir), { now: opts.now, days: opts.tmpDays });
    for (const item of expired) {
      if (!opts.dryRun) {
        try {
          fs.unlinkSync(item.path);
        } catch (err) {
          report.tmp.error = `${item.name}: ${err.message}`;
          continue;
        }
      }
      report.tmp.files.push({ name: item.name, size: item.size, ageDays: item.ageDays });
      report.tmp.bytes += item.size;
    }
  }

  // 3) token 账本归档
  if (opts.archiveUsage) {
    const file = path.join(opts.stateDir, 'token-usage.jsonl');
    report.usage.file = file;
    const livePid = bridgePid(opts.stateDir);
    if (livePid && !opts.force) {
      report.usage.skipped = `桥接还在跑（pid ${livePid}），账本可能正在被追加；先停桥接，或加 --force 明确承担竞态`;
    } else if (!fs.existsSync(file)) {
      report.usage.skipped = '账本文件不存在';
    } else {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const { keep, archive, invalid } = splitUsageLines(lines, { now: opts.now, keepMonths: opts.keepMonths });
      report.usage.invalid = invalid;
      report.usage.keptLines = keep.length;
      for (const bucket of archive) {
        const target = path.join(opts.stateDir, 'archive', `token-usage-${bucket.month}.jsonl`);
        report.usage.archived.push({ month: bucket.month, lines: bucket.lines.length, file: target });
        report.usage.archivedLines += bucket.lines.length;
        report.usage.bytes += bucket.lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
        if (!opts.dryRun) appendArchive(target, bucket.lines);
      }
      if (!opts.dryRun && report.usage.archivedLines > 0) {
        writeFileAtomic(file, keep.join('\n') + '\n');
      }
    }
  }
  return report;
}

function printReport(report) {
  const mode = report.dryRun ? '（--dry-run，什么都没动）' : '（已执行）';
  console.log(`state/ 清理计划 ${mode}`);
  if (report.device.dir) {
    console.log(`\n[设备截图] ${report.device.dir}`);
    console.log(`  ${report.device.days} 天前的：${report.device.files.length} 个，共 ${formatBytes(report.device.bytes)}`);
    for (const f of report.device.files) console.log(`  - ${f.name}  ${formatBytes(f.size)}  ${f.ageDays} 天前`);
    if (report.device.error) console.log(`  ! ${report.device.error}`);
  }
  if (report.tmp.dir) {
    console.log(`\n[work/tmp] ${report.tmp.dir}`);
    console.log(`  ${report.tmp.days} 天前的：${report.tmp.files.length} 个，共 ${formatBytes(report.tmp.bytes)}`);
    for (const f of report.tmp.files) console.log(`  - ${f.name}  ${formatBytes(f.size)}  ${f.ageDays} 天前`);
  }
  if (report.usage.file) {
    console.log(`\n[token 账本] ${report.usage.file}`);
    if (report.usage.skipped) {
      console.log(`  跳过：${report.usage.skipped}`);
    } else {
      console.log(`  归档 ${report.usage.archivedLines} 行（${formatBytes(report.usage.bytes)}），保留 ${report.usage.keptLines} 行，无法解析的行 ${report.usage.invalid} 条仍留在原文件`);
      for (const a of report.usage.archived) console.log(`  → ${a.file}  ${a.lines} 行`);
    }
  }
  const total = report.device.bytes + report.tmp.bytes + report.usage.bytes;
  console.log(`\n合计回收 ${formatBytes(total)}。`);
  if (report.dryRun) console.log('确认无误后去掉 --dry-run 再跑一次。');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 24).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  const report = runPrune(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
