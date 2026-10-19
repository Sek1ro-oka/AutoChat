#!/usr/bin/env node
/**
 * DSH web 守护进程（3080）。
 *
 * 背景：桥接依赖本机 DSH web（默认 127.0.0.1:3080）。这个进程不开窗口、退出很安静，
 * 一旦挂掉桥接就 `dshReady=false`，QQ 侧所有 agent 调用都失败。手工重启过很多次，
 * 所以改成常驻守护：端口没监听就拉起来，DSH 退出就等几秒再拉，日志写 logs/。
 *
 * 启动方式（无窗口）：
 *   powershell -NoProfile -WindowStyle Hidden -Command "Start-Process node -ArgumentList '<repo>\scripts\dsh-web-supervisor.mjs' -WindowStyle Hidden"
 * 或直接 `启动全部.cmd`（它用 %~dp0 推仓库根，本文件里没有硬编码盘符）。
 *
 * 单实例：state/dsh-web-supervisor.pid 记录 pid，已在跑就直接退出。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PORT = 3080;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'dsh-web-supervisor.log');
const OUT_FILE = path.join(LOG_DIR, 'dsh-web.out');
const PID_FILE = path.join(ROOT, 'state', 'dsh-web-supervisor.pid');

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── 单实例 ────────────────────────────────────────────────────────────────
const existing = readPid(PID_FILE);
if (existing && existing !== process.pid && alive(existing)) {
  log(`another supervisor is running (pid=${existing}), exit`);
  process.exit(0);
}
fs.writeFileSync(PID_FILE, String(process.pid));

// ── 定位 dsh ──────────────────────────────────────────────────────────────
// dsh.cmd 只是薄壳：设置 ELECTRON_RUN_AS_NODE=1 等环境变量后调用 Electron 的
// desktop-cli.js。**不要**用 cmd /c ""带空格路径\dsh.cmd" args" 去起它：cmd 的引号
// 规则会把路径截断，日志里只剩「找不到指定的路径」并且 exit 1。这里直接解析壳里的
// exe/cli 路径自己拼参数；解析失败再退回 `cmd /c dsh ...`（靠 PATH）。
function resolveDshShim() {
  if (process.env.DSH_CMD && fs.existsSync(process.env.DSH_CMD)) return process.env.DSH_CMD;
  try {
    const found = execFileSync('where', ['dsh'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const cmd = found.find((p) => /\.cmd$/i.test(p)) ?? found[0];
    if (cmd && fs.existsSync(cmd)) return cmd;
  } catch {}
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'DSH Desktop', 'host-commands', 'desktop', 'generations');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return ''; }
  let best = '';
  let bestTime = 0;
  for (const dir of dirs) {
    const candidate = path.join(base, dir, 'bin', 'dsh.cmd');
    try {
      const stat = fs.statSync(candidate);
      if (stat.mtimeMs > bestTime) { best = candidate; bestTime = stat.mtimeMs; }
    } catch {}
  }
  return best;
}

const DSH_SHIM = resolveDshShim();

/** 从 dsh.cmd 里抽出 Electron exe 与 desktop-cli.js 的绝对路径。 */
function parseShim(shim) {
  try {
    const text = fs.readFileSync(shim, 'utf8');
    const exe = text.match(/"([^"]*DSH Desktop\.exe)"/i)?.[1] ?? '';
    const cli = text.match(/"([^"]*desktop-cli\.js)"/i)?.[1] ?? '';
    const home = text.match(/set\s+"DSH_HOME=([^"]*)"/i)?.[1] ?? '';
    if (exe && cli && fs.existsSync(exe) && fs.existsSync(cli)) return { exe, cli, home };
  } catch {}
  return null;
}

const DSH_DIRECT = DSH_SHIM ? parseShim(DSH_SHIM) : null;

// ── 端口探测 ──────────────────────────────────────────────────────────────
function portOpen(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MCP 区块自愈 ──────────────────────────────────────────────────────────
// DSH 有时会把 profile 里「qq-bridge MCP BEGIN/END」之间的条目整段抹掉（条目被挪进
// 它自己的 "disabled shadow entries" 段并置 disabled: true）。结果 QQ 侧 agent 一个
// MCP 工具都没有，所有调用都报 unknown tool，表现在用户眼里就是「bot 不回话」。
// 这里每 60s 检查一次：区块空了就重新写入，然后杀掉 DSH 让它带着新配置重启。
const PATCH_FILE = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
const MCP_BEGIN = '# === qq-bridge MCP BEGIN ===';
const MCP_END = '# === qq-bridge MCP END ===';

function mcpBlockEntryCount() {
  try {
    const text = fs.readFileSync(PATCH_FILE, 'utf8');
    const begin = text.indexOf(MCP_BEGIN);
    if (begin < 0) return -1;
    const end = text.indexOf(MCP_END, begin);
    if (end < 0) return -1;
    return (text.slice(begin, end).match(/^\s*- id: mcp-/gm) ?? []).length;
  } catch {
    return -1;
  }
}

let lastRepairAt = 0;
function repairMcpBlock(reason) {
  if (Date.now() - lastRepairAt < 120000) return false;
  lastRepairAt = Date.now();
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web'], { cwd: ROOT, encoding: 'utf8' });
    const tail = out.trim().split(/\r?\n/).slice(-2).join(' | ');
    log(`MCP block repaired (${reason}): ${tail}`);
    return true;
  } catch (error) {
    log(`MCP block repair failed (${reason}): ${error?.message ?? error}`);
    return false;
  }
}

function killDshWeb(reason) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-NetTCPConnection -State Listen -LocalPort ' + PORT + ' -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess'],
    { encoding: 'utf8' }).trim();
    const pid = Number.parseInt(out, 10);
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGKILL');
      log(`killed DSH web pid=${pid} (${reason})`);
    }
  } catch (error) {
    log(`kill DSH web failed: ${error?.message ?? error}`);
  }
}

async function ensureRunningOnce() {
  if (await portOpen(PORT)) return;
  // 起 DSH 之前先确认 MCP 区块没被抹掉，否则起起来也没有工具
  if (mcpBlockEntryCount() <= 0) repairMcpBlock('before start');
  const fd = fs.openSync(OUT_FILE, 'a');
  let child;
  if (DSH_DIRECT) {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_DEFAULT_PROFILE: 'desktop',
      ...(DSH_DIRECT.home ? { DSH_HOME: DSH_DIRECT.home } : {}),
    };
    child = spawn(DSH_DIRECT.exe, ['--expose-internals', DSH_DIRECT.cli, '--profile', 'web', '--port', String(PORT), '--no-open'], {
      cwd: ROOT, env, stdio: ['ignore', fd, fd], windowsHide: true,
    });
    log(`DSH web down -> spawned pid=${child.pid} (direct: ${DSH_DIRECT.exe})`);
  } else if (DSH_SHIM) {
    child = spawn('cmd.exe', ['/c', 'dsh --profile web --port ' + PORT + ' --no-open'], {
      cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
    });
    log(`DSH web down -> spawned pid=${child.pid} (via PATH dsh, shim=${DSH_SHIM})`);
  } else {
    log('dsh not found; cannot start DSH web (set DSH_CMD env)');
    try { fs.closeSync(fd); } catch {}
    await sleep(30000);
    return;
  }
  // 等端口起来（最多 90s），期间 dsh 若退出就不再等
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });
  for (let i = 0; i < 90; i += 1) {
    if (await portOpen(PORT)) { log(`DSH web is up on ${PORT} (pid=${child.pid})`); break; }
    if (exited) { log(`DSH web exited before listening (code=${exitCode})`); break; }
    await sleep(1000);
  }
  // 之后靠端口轮询判断存活；dsh 退出时这一段会自然结束下一轮重启
  while (!exited) await sleep(3000);
  try { fs.closeSync(fd); } catch {}
  log(`DSH web exited (code=${exitCode}); restarting in 5s`);
  await sleep(5000);
}

log(`supervisor started (pid=${process.pid})`);

// 每 60s 体检一次 MCP 区块：DSH 运行期间被抹掉也能拉回来（补写后重启 DSH 让它加载）
setInterval(() => {
  const count = mcpBlockEntryCount();
  if (count > 0) return;
  log(`MCP block empty (entries=${count}) -> repairing`);
  if (!repairMcpBlock('watcher')) return;
  killDshWeb('MCP reload');
}, 60000).unref();


for (;;) {
  try {
    await ensureRunningOnce();
    await sleep(3000);
  } catch (error) {
    log(`supervisor loop error: ${error?.message ?? error}`);
    await sleep(5000);
  }
}
