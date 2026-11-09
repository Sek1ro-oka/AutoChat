#!/usr/bin/env node
/**
 * SnowLuma 守护进程（探 3001，掉了就按 SnowLuma 自己的 launcher.bat 拉起来）。
 *
 * 为什么需要它：
 *   2026-11-09 14:26 系统低内存（System 事件日志 Resource-Exhaustion-Detector Id 2004）把
 *   SnowLuma 的 node 进程收走了。没人发现，桥接从 14:27 一路 `code=1006` 重连到 19:04
 *   （4h38m），群里/私聊的消息全部丢失（historySync 关着，没有历史回补）。
 *   DSH 那半边早有 supervisor + keeper 两层守护，SnowLuma 这半边一直是裸奔。
 *
 * 干什么：每 30s 探一次 127.0.0.1:3001（OneBot WS，网关起来必须先监听它）。没监听时：
 *   ① 已经有 SnowLuma 进程（node + index.mjs）→ 只等，绝不双开：双开等于 double-hook
 *      同一个 QQ，实测表现为 send_group_msg 永久挂起 15 秒超时；
 *   ② 刚拉起过（state/snowluma-supervisor.spawn 的时间 < 120s）→ 等它 bind 端口；
 *   ③ 都没有 → spawn 调 snowluma.homeDir 下的 launcher.bat（目录取自 config.json，
 *      本文件不硬编码盘符），stdout/stderr 落 logs/snowluma.out。
 *   另外每 5 分钟做一次单实例体检：真出现两个 SnowLuma，留最早的那个、结束后起的。
 *   如果进程一直在、端口却 20 分钟没开，判定卡死：结束它再重拉（宁可重拉，也别静默挂着）。
 *
 * 边界：不代装、不分发 SnowLuma 的任何代码 —— 只是在你**已经装好**的目录里调用它自己的
 * launcher.bat（和 `启动全部.cmd` 做的事一样，只是加上了「死了自动再来一次」）。
 *
 * 想彻底停掉 bot：建一个 state/snowluma-supervisor.pause 文件（本守护只记录、不重启），
 * 或停掉计划任务 "AutoChat SnowLuma supervisor"。删掉 pause 文件即恢复。
 *
 * 单实例：state/snowluma-supervisor.pid，已在跑就直接退出。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PORT = 3001;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'snowluma-supervisor.log');
const OUT_FILE = path.join(LOG_DIR, 'snowluma.out');
const PID_FILE = path.join(ROOT, 'state', 'snowluma-supervisor.pid');
const SPAWN_FILE = path.join(ROOT, 'state', 'snowluma-supervisor.spawn');
const PAUSE_FILE = path.join(ROOT, 'state', 'snowluma-supervisor.pause');

const HEALTHY_INTERVAL_MS = 15000; // 端口正常时的探活间隔（15s：实测被杀后 15s 内能拉回来）
const BOOT_GRACE_MS = 120000; // 拉起后给多久 bind 端口（期间不重复拉起）
const SINGLE_CHECK_MS = 5 * 60 * 1000; // 单实例体检间隔
const WEDGED_KILL_MS = 20 * 60 * 1000; // 进程在、端口不开多久算卡死
const PAUSE_LOG_MS = 10 * 60 * 1000; // pause 状态下多久提一次

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

// ── 时间戳（跨 supervisor 重启记住「最近一次是什么时候拉起的」）────────────────
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

// ── 找 SnowLuma 的 node 进程 ───────────────────────────────────────────────
// launcher.bat 跑的是 `node ./index.mjs`，所以命令行里一定有 index.mjs；不管是仓库自带的
// node.exe 还是 PATH 上的系统 node，这条都能命中。时间用 ToFileTimeUtc()，避免本地化格式。
const PS_LIST = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
  "Where-Object { $_.CommandLine -and ($_.CommandLine -match 'index[.]mjs') } |",
  "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToFileTimeUtc())|$($_.ExecutablePath)\" }",
].join(' ');

function snowlumaProcs() {
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
  } catch (error) {
    log(`枚举 SnowLuma 进程失败：${error?.message ?? error}`);
    return [];
  }
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const [pidText, createdText, exe] = line.split('|');
    return { pid: Number.parseInt(pidText, 10), createdAt: Number.parseInt(createdText, 10) || 0, exe: exe ?? '' };
  }).filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

function describe(procs) {
  return procs.map((p) => `${p.pid}${p.exe ? `(${p.exe})` : ''}`).join(', ');
}

function enforceSingle(procs) {
  const sorted = [...procs].sort((a, b) => a.createdAt - b.createdAt);
  const keep = sorted[0];
  const extra = sorted.slice(1);
  log(`发现 ${sorted.length} 个 SnowLuma 进程（${describe(sorted)}）→ 保留最早的 pid=${keep.pid}，结束 ${describe(extra)}`);
  for (const proc of extra) {
    try {
      process.kill(proc.pid, 'SIGKILL');
      log(`已结束重复的 SnowLuma pid=${proc.pid}`);
    } catch (error) {
      log(`结束重复 SnowLuma pid=${proc.pid} 失败：${error?.message ?? error}`);
    }
  }
}

// ── 拉起 ──────────────────────────────────────────────────────────────────
function resolveHome() {
  const fromEnv = String(process.env.SNOWLUMA_DIR ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return String(cfg?.snowluma?.homeDir ?? '').trim();
  } catch (error) {
    log(`读 config.json 失败：${error?.message ?? error}`);
    return '';
  }
}

let failures = 0;

async function startSnowLuma() {
  const dir = resolveHome();
  const launcher = dir ? path.join(dir, 'launcher.bat') : '';
  if (!launcher || !fs.existsSync(launcher)) {
    log(`找不到 SnowLuma 启动器：${launcher || '(config.json 的 snowluma.homeDir 为空)'}`);
    failures += 1;
    await sleep(failures >= 3 ? 300000 : 60000);
    return;
  }
  writeSpawnAt();
  const fd = fs.openSync(OUT_FILE, 'a');
  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/c', 'launcher.bat'], {
      cwd: dir, stdio: ['ignore', fd, fd], windowsHide: true,
    });
  } catch (error) {
    log(`拉起 SnowLuma 失败：${error?.message ?? error}`);
    try { fs.closeSync(fd); } catch {}
    failures += 1;
    await sleep(60000);
    return;
  }
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
  child.on('error', (error) => { log(`SnowLuma 子进程错误：${error?.message ?? error}`); });
  log(`端口 ${PORT} 未监听 → 已拉起 SnowLuma（pid=${child.pid}，cwd=${dir}）`);

  let up = false;
  for (let i = 0; i < Math.ceil(BOOT_GRACE_MS / 1000); i += 1) {
    if (await portOpen(PORT)) {
      up = true;
      log(`SnowLuma 已在 ${PORT} 监听（用时 ${i + 1}s，pid=${child.pid}）`);
      break;
    }
    if (exitInfo) break;
    await sleep(1000);
  }
  try { fs.closeSync(fd); } catch {}
  if (up) { failures = 0; return; }
  failures += 1;
  if (exitInfo) {
    log(`SnowLuma 启动器退出（code=${exitInfo.code}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ''}），看 logs/snowluma.out`);
  } else {
    log(`${BOOT_GRACE_MS / 1000}s 内没等到 ${PORT}：进程还在就不再重复拉起，不在就下一轮重试`);
  }
  if (failures >= 3) {
    log(`连续 ${failures} 次没起来，先歇 5 分钟再试（别把磁盘/CPU 打满）`);
    await sleep(300000);
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let downSince = 0;
let lastSingleCheck = 0;
let lastPauseLog = 0;
let lastWaitLog = 0;

log(`supervisor started (pid=${process.pid})`);

for (;;) {
  try {
    if (fs.existsSync(PAUSE_FILE)) {
      if (Date.now() - lastPauseLog > PAUSE_LOG_MS) {
        log('检测到 state/snowluma-supervisor.pause：不重启 SnowLuma（删掉该文件即恢复守护）');
        lastPauseLog = Date.now();
      }
      await sleep(60000);
      continue;
    }

    if (await portOpen(PORT)) {
      if (downSince) {
        log(`SnowLuma 恢复监听 ${PORT}（中断约 ${Math.round((Date.now() - downSince) / 1000)}s）`);
        downSince = 0;
      }
      if (Date.now() - lastSingleCheck > SINGLE_CHECK_MS) {
        lastSingleCheck = Date.now();
        const procs = snowlumaProcs();
        if (procs.length > 1) enforceSingle(procs);
      }
      await sleep(HEALTHY_INTERVAL_MS);
      continue;
    }

    // ── 端口没开 ──
    if (!downSince) {
      downSince = Date.now();
      log(`检测到 ${PORT} 未监听，开始处理`);
    }

    const sinceSpawn = Date.now() - readSpawnAt();
    if (sinceSpawn < BOOT_GRACE_MS) {
      await sleep(5000);
      continue;
    }

    const procs = snowlumaProcs();
    if (procs.length) {
      const downMs = Date.now() - downSince;
      if (downMs > WEDGED_KILL_MS) {
        log(`SnowLuma 进程在（${describe(procs)}）但 ${PORT} 已 ${Math.round(downMs / 60000)} 分钟没监听 → 判定卡死，结束后重拉`);
        for (const proc of procs) {
          try { process.kill(proc.pid, 'SIGKILL'); log(`已结束卡死的 SnowLuma pid=${proc.pid}`); } catch (error) { log(`结束卡死 SnowLuma pid=${proc.pid} 失败：${error?.message ?? error}`); }
        }
        await sleep(3000);
        continue;
      }
      if (Date.now() - lastWaitLog > 60000) {
        lastWaitLog = Date.now();
        log(`端口 ${PORT} 没开，但 SnowLuma 进程在（${describe(procs)}）→ 先等它，不双开`);
      }
      await sleep(10000);
      continue;
    }

    await startSnowLuma();
  } catch (error) {
    log(`supervisor loop error: ${error?.message ?? error}`);
    await sleep(5000);
  }
}
