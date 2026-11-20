#!/usr/bin/env node
/**
 * 把「这个 bot 的数据」打成一个迁移包，换电脑时整包搬过去就能接着用。
 *
 *   node scripts/migrate-export.mjs                 # 导出到 work\migrate\migrate-<时间>\（不含日志）
 *   node scripts/migrate-export.mjs --with-logs     # 连 logs/、*.jsonl 一起带（排错时才需要）
 *   node scripts/migrate-export.mjs --with-snowluma # 连 E:\SnowLuma 整个目录一起带（省一次扫码登录）
 *   node scripts/migrate-export.mjs --zip           # 打完再压成 .zip（Compress-Archive）
 *   node scripts/migrate-export.mjs --out D:\搬移   # 指定输出目录（不要放进 git 仓库里）
 *   node scripts/migrate-export.mjs --dry-run       # 只列清单，不复制
 *
 * 搬什么、不搬什么（换机器时最容易搞错的就是这条线）：
 *
 *   搬  config.json          机器相关的 key、白名单、token、各个绝对路径都在这里
 *   搬  state/               这个 bot 的「记忆」：会话映射、群聊状态、黑话表、日记、收藏表情、
 *                            人格绑定、心情值、控制台令牌……全在这里，删了就等于失忆
 *   搬  audio/               语音库（send_voice 只认这里的文件）
 *   搬  files/               files/ 托管目录（file_send 发的就是这些）
 *   搬  roles/               人格卡（虽然也进了 git，但本地可能改过没提交，一起带上更稳）
 *   搬  SnowLuma 目录（可选） 自带的 node 运行时 + QQ 登录态 + OneBot 端口/token 配置
 *
 *   不搬  node_modules/      新机器 `npm install` 重装（postinstall 会修补 @snowluma/sdk）
 *   不搬  .git/              新机器 `git clone` 即可；这是代码，不是数据
 *   不搬  *_supervisor.pid / *.spawn / bridge.lock   进程残留，搬过去只会让新机器以为有人在跑
 *   不搬  work/               开发过程的临时文件与交接文档，跟 bot 运行无关
 *
 * 包里会多出两个文件：
 *   MANIFEST.json  每个文件的 sha256 + 来源机器 + git 版本 + 「配置里需要改的绝对路径」清单
 *   RESTORE.md     还原步骤（对着做就行；详细说明见 docs/guides/MIGRATION.md）
 *
 * 注意：config.json 里有 OneBot accessToken、控制台令牌和真实 QQ 号/群号，
 *      state/ 里有聊天内容和日记 —— 迁移包是**私密文件**，别传群、别提交到仓库。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 参数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
function valueOf(flag, fallback) {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) throw new Error(`${flag} 后面要跟一个值`);
  return next;
}

const DRY = has('--dry-run');
const WITH_LOGS = has('--with-logs');
const WITH_SNOWLUMA = has('--with-snowluma');
const ZIP = has('--zip');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const OUT = path.resolve(valueOf('--out', path.join(ROOT, 'work', 'migrate', `migrate-${stamp}`)));

// ── 要带走的目录 ───────────────────────────────────────────────────────────
// state/ 里的日志类文件默认不带：它们按秒增长，搬过去既占地方又会误导新机器的排错。
const STATE_SKIP_DIRS = ['tmp', 'outbox', 'asr-test'];
const STATE_SKIP_FILE = [
  /\.(pid|spawn|lock)$/i, // 进程残留
  /^(bridge|snowluma|dsh-web)-supervisor\./i, // 守护进程自己的状态
  /^backup-before-/, // 手工备份快照
  /^tmp-filetest\./, // 测试残留
];
const LOGISH = [/\.log$/i, /\.log\.\d+$/i, /\.jsonl$/i, /\.jsonl\.\d+$/i];

const INCLUDE_DIRS = [
  { name: 'state', why: 'bot 的记忆：会话/群聊/黑话/日记/表情/人格绑定/令牌' },
  { name: 'audio', why: '语音库（qq_send_voice 的数据源）' },
  { name: 'files', why: 'files/ 托管目录（qq 发文件的数据源）' },
  { name: 'roles', why: '人格卡（本地可能改过没提交）' },
  { name: 'logs', why: '历史日志（默认不带，--with-logs 才带）', optional: true }
];

function shouldSkipStateEntry(rel) {
  const base = path.basename(rel);
  if (STATE_SKIP_DIRS.includes(base)) return true;
  if (STATE_SKIP_FILE.some((re) => re.test(base))) return true;
  if (!WITH_LOGS && LOGISH.some((re) => re.test(base))) return true;
  return false;
}

// ── 小工具 ────────────────────────────────────────────────────────────────
function say(line = '') {
  console.log(line);
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function portOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    return '';
  }
}

/** 递归收集一个目录下要带走的文件（相对该目录的 posix 路径）。 */
function collect(dir, skip) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip && skip(childRel)) continue;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out;
}

/** config.json 里所有盘符开头的值 —— 换机器时这些必须人工核对。 */
function collectAbsolutePaths(node, prefix = '', acc = []) {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) value.forEach((item, i) => collectAbsolutePaths(item, `${next}[${i}]`, acc));
      else if (value && typeof value === 'object') collectAbsolutePaths(value, next, acc);
      else if (typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)) acc.push({ key: next, value });
    }
  }
  return acc;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
const plan = []; // { source, rel, bytes, kind }
const warnings = [];

say(`== 导出迁移包 → ${OUT} ==`);
if (DRY) say('   （--dry-run：只列清单，不写文件）');

const configPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('找不到 config.json —— 先照 README 复制 config.example.json 并填好再导出。');
  process.exit(1);
}

if (await portOpen(3100)) {
  warnings.push('桥接（3100）正在运行：state/ 里可能有文件正被写入。想更稳妥就先 `node scripts/stack-control.mjs stop` 再导出。');
}

// 单文件：config.json
plan.push({ source: configPath, rel: 'config.json', bytes: fs.statSync(configPath).size, kind: 'file' });

// 目录
for (const dir of INCLUDE_DIRS) {
  const abs = path.join(ROOT, dir.name);
  if (!fs.existsSync(abs)) continue;
  if (dir.name === 'logs' && !WITH_LOGS) continue;
  const skip = dir.name === 'state' ? shouldSkipStateEntry : null;
  for (const rel of collect(abs, skip)) {
    const file = path.join(abs, rel.split('/').join(path.sep));
    plan.push({ source: file, rel: `${dir.name}/${rel}`, bytes: fs.statSync(file).size, kind: 'group', why: dir.why });
  }
}

// SnowLuma（可选）：它自带 node 运行时，整个目录就是它的全部状态
const SNOWLUMA_DIR = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return String(cfg?.snowluma?.homeDir ?? '').trim();
  } catch {
    return '';
  }
})();
if (WITH_SNOWLUMA) {
  if (!SNOWLUMA_DIR || !fs.existsSync(SNOWLUMA_DIR)) {
    warnings.push(`--with-snowluma 给了，但配置里的 snowluma.homeDir 是「${SNOWLUMA_DIR || '空'}」，跳过。`);
  } else {
    for (const rel of collect(SNOWLUMA_DIR, (r) => /(^|\/)logs\//i.test(r) && !WITH_LOGS)) {
      const file = path.join(SNOWLUMA_DIR, rel.split('/').join(path.sep));
      plan.push({ source: file, rel: `snowluma/${rel}`, bytes: fs.statSync(file).size, kind: 'group', why: 'SnowLuma：node 运行时 + QQ 登录态 + OneBot 配置' });
    }
  }
}

const totalBytes = plan.reduce((sum, item) => sum + item.bytes, 0);
say(`   文件 ${plan.length} 个，合计 ${human(totalBytes)}`);

// 按来源分组报一下，方便肉眼确认
const groups = new Map();
for (const item of plan) {
  const key = item.kind === 'file' ? 'config.json' : item.rel.split('/')[0];
  const g = groups.get(key) ?? { files: 0, bytes: 0 };
  g.files += 1;
  g.bytes += item.bytes;
  groups.set(key, g);
}
for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  say(`   ${key.padEnd(12)} ${String(g.files).padStart(5)} 个  ${human(g.bytes)}`);
}
for (const warning of warnings) say(`   ⚠️ ${warning}`);

if (DRY) {
  say('\n清单如上。去掉 --dry-run 就会真的复制。');
  process.exit(0);
}

// ── 复制 ──────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const manifestFiles = [];
let copied = 0;
for (const item of plan) {
  const dest = path.join(OUT, item.rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(item.source, dest);
  manifestFiles.push({ path: item.rel, bytes: item.bytes, sha256: sha256(dest) });
  copied += 1;
  if (copied % 40 === 0) process.stdout.write(`\r   已复制 ${copied}/${plan.length} …`);
}
process.stdout.write(`\r   已复制 ${copied}/${plan.length} 个文件      \n`);

// ── MANIFEST ──────────────────────────────────────────────────────────────
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  warnings.push(`config.json 解析失败（${error.message}），「需要改的绝对路径」这一节会不准。`);
}

const manifest = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: {
    root: ROOT,
    machine: os.hostname(),
    user: os.userInfo().username,
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    git: {
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      head: git('rev-parse', 'HEAD'),
      dirty: git('status', '--porcelain') !== ''
    },
    snowlumaHome: SNOWLUMA_DIR
  },
  options: { withLogs: WITH_LOGS, withSnowluma: WITH_SNOWLUMA },
  totals: { files: manifestFiles.length, bytes: manifestFiles.reduce((s, f) => s + f.bytes, 0) },
  // 换机器时必须人工改的项：这些是「这台机器」的绝对路径
  absolutePaths: collectAbsolutePaths(cfg),
  warnings,
  files: manifestFiles
};
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// ── RESTORE.md ────────────────────────────────────────────────────────────
const restore = `# 迁移还原清单

> 由 \`scripts/migrate-export.mjs\` 在 ${new Date().toLocaleString('zh-CN')} 生成。
> 来源：${os.hostname()} / ${os.userInfo().username} / node ${process.version}
> git：${manifest.source.git.branch} @ ${manifest.source.git.head.slice(0, 7)}${manifest.source.git.dirty ? '（工作区有未提交改动）' : ''}
> 完整说明见仓库里的 \`docs/guides/MIGRATION.md\`。

## 0. 先看清楚

- **这个包是私密的**：\`config.json\` 有 OneBot token、控制台令牌、真实 QQ 号/群号；\`state/\` 有聊天内容、日记、收藏表情。
  不要提交进 git，不要传群、不要放网盘公开链接。
- 新机器上不需要这个包里的 \`node_modules\`、\`.git\` —— 代码用 \`git clone\` 拿，依赖用 \`npm install\` 装。
- 包里的路径都是**旧机器**的。第 3 步会列出必须改的项。

## 1. 新机器装基础环境

1. **Node.js ≥ 22.13**（\`node -v\` 确认）
2. **DeepSeek Harness**（DSH）装好并能打开 \`http://127.0.0.1:3080\`；
   在 DSH 设置里配好模型服务商（这是另一套凭据，不随这个包迁移）
3. **SnowLuma**：${WITH_SNOWLUMA
  ? '包里带了完整目录（含 node 运行时和 QQ 登录态），解压到任意位置即可，**不要再装一份**'
  : '去 releases 下载解压；解压后启动一次、扫码登录 QQ，并在 WebUI 里开好 WebSocket(3001) + HTTP(3000)，记下 accessToken'}

## 2. 把代码拉下来

\`\`\`bat
git clone -b qq-bridge https://github.com/Sek1ro-oka/AutoChat.git
cd AutoChat
npm install
\`\`\`

## 3. 把数据放进去

把包里的这些**覆盖/放进仓库根目录**：

| 包内 | 放到 |
| --- | --- |
| \`config.json\` | 仓库根目录 |
| \`state/\` | 仓库根目录 |
| \`audio/\`、\`files/\`、\`roles/\` | 仓库根目录 |
${WITH_SNOWLUMA ? '| `snowluma/` | 解压到新机器任意目录（例如 `D:\\SnowLuma`） |\n' : ''}
然后**逐项核对 \`config.json\` 里这些绝对路径**（旧机器 → 新机器）：

${manifest.absolutePaths.length
  ? manifest.absolutePaths.map((p) => `- \`${p.key}\` = \`${p.value}\``).join('\n')
  : '- （config.json 里没有盘符开头的路径）'}

对照表：改哪些、可以不改哪些，见 \`docs/guides/MIGRATION.md\` 第 3 节。

## 4. 装 DSH 端并重启 DSH

\`\`\`bat
node scripts/setup-dsh.mjs
\`\`\`

装完**必须重启 DSH**（preset 与 MCP 只在启动时加载）。这台机器上 DSH 的 profile 里记着旧仓库路径，
所以 setup-dsh 必须在新机器上重跑一遍。

## 5. 起服务并验证

\`\`\`bat
node scripts/stack-control.mjs status   :: 先看现状
启动全部.cmd                             :: 缺什么起什么
node scripts/stack-control.mjs status   :: 再看一次，应当三端口 + QQ 账号 + 桥接连线全绿
\`\`\`

QQ 上给机器人发一条消息，看 \`logs\\bridge.log\` 有没有「已投递」。

## 6. 自启（可选）

见 \`docs/guides/MIGRATION.md\` 第 6 节。

## 7. 旧机器怎么处理

先确认新机器跑通（至少收发一轮消息），再考虑停掉旧机器上的桥接 —— 否则两边同时登录同一个 QQ 会互相踢。
`;

fs.writeFileSync(path.join(OUT, 'RESTORE.md'), restore, 'utf8');

// ── 可选：打包成 zip ──────────────────────────────────────────────────────
let zipPath = '';
if (ZIP) {
  zipPath = `${OUT}.zip`;
  say(`   压缩 → ${zipPath} …`);
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`
    ], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
  } catch (error) {
    warnings.push(`压缩失败（${error?.message ?? error}），但目录已经导出好了：${OUT}`);
    zipPath = '';
  }
}

// 更新 MANIFEST 里的警告（压缩失败的提示也要落盘）
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify({ ...manifest, warnings }, null, 2)}\n`, 'utf8');

// ── 收尾 ──────────────────────────────────────────────────────────────────
say('');
say(`✅ 导出完成：${OUT}`);
say(`   ${manifestFiles.length} 个文件，${human(manifest.totals.bytes)}${zipPath ? `；zip：${zipPath}` : ''}`);
say('   还原步骤：包里的 RESTORE.md（或 docs/guides/MIGRATION.md）');
if (warnings.length) {
  say('');
  for (const warning of warnings) say(`   ⚠️ ${warning}`);
}
