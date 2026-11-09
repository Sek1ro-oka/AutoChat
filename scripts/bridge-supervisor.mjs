#!/usr/bin/env node
/**
 * 桥接守护进程（探 3100，掉了就按仓库自己的 start.bat 拉起来）。
 *
 * 为什么需要它：
 *   2026-11-09 那次断连暴露出一个真空 —— start.bat 的 `:loop` 只能兜住「node 崩了」，
 *   兜不住「整个进程树没了」：关掉那个黑窗口、注销登录会话、或被人 taskkill /T，
 *   桥接就彻底停了，而计划任务里只有 DSH 和 SnowLuma 的守护，没有人会把它拉回来。
 *   网关那半边现在有 supervisor + keeper 两层，桥接这半边同样是裸奔。
 *
 * 干什么：每 60s 探一次 127.0.0.1:3100。
 *   · 端口在 → 什么都不做（桥接自己的 :loop 会处理 node 崩溃，不需要这里插手）；
 *   · 端口不在，但已经有桥接 node 进程 → 先等，不双开（双开会抢 state/ 与会话状态）；
 *   · 刚拉起过（state/bridge-supervisor.spawn 的时间 < 90s）→ 等它 bind 端口；
 *   · 都没有 → spawn `cmd /d /c start.bat`，输出落 logs/bridge.out。
 *   进程在、端口却 10 分钟没开 → 判定卡死：结束它再重拉。
 *
 * 边界：只调用仓库自己的 start.bat，不装任何东西、不改 config.json。
 * 想彻底停掉 bot：建一个 state/bridge-supervisor.pause 文件（本守护只记录、不重启），
 * 或停掉计划任务 "AutoChat Bridge supervisor"。删掉 pause 文件即恢复。
 *
 * 单实例：state/bridge-supervisor.pid，已在跑就直接退出。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PORT = 3100;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'bridge-supervisor.log');
const OUT_FILE = path.join(LOG_DIR, 'bridge.out');
const PID_FILE = path.join(ROOT, 'state', 'bridge-supervisor.pid');
const SPAWN_FILE = path.join(ROOT, 'state', 'bridge-supervisor.spawn');
const PAUSE_FILE = path.join(ROOT, 'state', 'bridge-supervisor.pause');

const HEALTHY_INTERVAL_MS = 60000; // 端口正常时的探活间隔（切掉整个进程树的情况，一分钟足够）
const BOOT_GRACE_MS = 90000; // 拉起后给多久 bind 端口（start.bat 里还会跑一次 ACL 加固）
const WEDGED_KILL_MS = 10 * 60 * 1000; // 进程在、端口不开多久算卡死
const PAUSE_LOG_MS = 10 * 60 * 1000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 单实例 ────────────────────────────────────────────────────────────────
const existing = readPid(PID_FILE);
if (existing && existing !== process.pid && alive(existing)) {
  log(`another supervisor is running (pid=${existing}), exit`);
  process.exit(0);
}
fs.writeFileSync(PID_FILE, String(process.pid));

function readSpawnAt() {
  try {
    const at = Number.parseInt(fs.readFileSync(SPAWN_FILE, 'utf8').trim(), 10);
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch { return 0; }
}

function writeSpawnAt() {
  try { fs.writeFileSync(SPAWN_FILE, String(Date.now())); } catch {}
}

// ── 端口探测 ──────────────────────────────────────────────────────────────
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ── 找桥接的 node 进程 ─────────────────────────────────────────────────────
// start.bat 跑的是 `node src/bridge.js`；命令行里带上分隔符匹配，避免误伤别的 bridge.js。
const PS_LIST = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
  "Where-Object { $_.CommandLine -and ($_.CommandLine -match 'src[\\\\/]bridge[.]js') } |",
  "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToFileTimeUtc())\" }",
].join(' ');

function bridgeProcs() {
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
  } catch (error) {
    log(`枚举桥接进程失败：${error?.message ?? error}`);
    return [];
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [pidText, createdText] = line.split('|');
    return { pid: Number.parseInt(pidText, 10), createdAt: Number.parseInt(createdText, 10) || 0 };
  }).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

function describe(procs) {
  return procs.map((p) => String(p.pid)).join(', ');
}

let failures = 0;

async function startBridge() {
  writeSpawnAt();
  const fd = fs.openSync(OUT_FILE, 'a');
  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/c', 'start.bat'], {
      cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
    });
  } catch (error) {
    log(`拉起桥接失败：${error?.message ?? error}`);
    try { fs.closeSync(fd); } catch {}
    failures += 1;
    await sleep(60000);
    return;
  }
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.on('error', (error) => { log(`桥接子进程错误：${error?.message ?? error}`); });
  log(`端口 ${PORT} 未监听 → 已拉起桥接（pid=${child.pid}，cwd=${ROOT}）`);

  let up = false;
  for (let i = 0; i < Math.ceil(BOOT_GRACE_MS / 1000); i += 1) {
    if (await portOpen(PORT)) {
      up = true;
      log(`桥接已在 ${PORT} 监听（用时 ${i + 1}s，pid=${child.pid}）`);
      break;
    }
    if (exitInfo) break;
    await sleep(1000);
  }
  try { fs.closeSync(fd); } catch {}
  if (up) { failures = 0; return; }
  failures += 1;
  if (exitInfo) {
    log(`start.bat 退出（code=${exitInfo.code}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ''}），看 logs/bridge.out`);
  } else {
    log(`${BOOT_GRACE_MS / 1000}s 内没等到 ${PORT}：进程还在就不再重复拉起，不在就下一轮重试`);
  }
  if (failures >= 3) {
    log(`连续 ${failures} 次没起来，先歇 5 分钟再试`);
    await sleep(300000);
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let downSince = 0;
let lastPauseLog = 0;
let lastWaitLog = 0;

log(`supervisor started (pid=${process.pid})`);

for (;;) {
  try {
    if (fs.existsSync(PAUSE_FILE)) {
      if (Date.now() - lastPauseLog > PAUSE_LOG_MS) {
        log('检测到 state/bridge-supervisor.pause：不重启桥接（删掉该文件即恢复守护）');
        lastPauseLog = Date.now();
      }
      await sleep(60000);
      continue;
    }

    if (await portOpen(PORT)) {
      if (downSince) {
        log(`桥接恢复监听 ${PORT}（中断约 ${Math.round((Date.now() - downSince) / 1000)}s）`);
        downSince = 0;
      }
      await sleep(HEALTHY_INTERVAL_MS);
      continue;
    }

    if (!downSince) {
      downSince = Date.now();
      log(`检测到 ${PORT} 未监听，开始处理`);
    }

    if (Date.now() - readSpawnAt() < BOOT_GRACE_MS) {
      await sleep(5000);
      continue;
    }

    const procs = bridgeProcs();
    if (procs.length) {
      const downMs = Date.now() - downSince;
      if (downMs > WEDGED_KILL_MS) {
        log(`桥接进程在（${describe(procs)}）但 ${PORT} 已 ${Math.round(downMs / 60000)} 分钟没监听 → 判定卡死，结束后重拉`);
        for (const proc of procs) {
          try { process.kill(proc.pid, 'SIGKILL'); log(`已结束卡死的桥接 pid=${proc.pid}`); } catch (error) { log(`结束卡死桥接 pid=${proc.pid} 失败：${error?.message ?? error}`); }
        }
        await sleep(3000);
        continue;
      }
      if (Date.now() - lastWaitLog > 60000) {
        lastWaitLog = Date.now();
        log(`端口 ${PORT} 没开，但桥接进程在（${describe(procs)}）→ 先等它，不双开`);
      }
      await sleep(10000);
      continue;
    }

    await startBridge();
  } catch (error) {
    log(`supervisor loop error: ${error?.message ?? error}`);
    await sleep(5000);
  }
}
