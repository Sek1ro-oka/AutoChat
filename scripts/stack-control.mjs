#!/usr/bin/env node
/**
 * 一键启停 AutoChat 的三个服务：SnowLuma（3000/3001）、DSH web（3080）、桥接（3100）。
 *
 * 为什么有这个东西：`schtasks` 里那 5 个周期任务（Bridge / SnowLuma 的 supervisor 和
 * 三个 keeper）用 InteractiveToken 直接起 node.exe，每 2–5 分钟就弹一个真实的
 * Windows Terminal 窗口，2026-11-15 已全部禁用。禁用之后没人再负责「把服务拉起来」，
 * 于是启动/重启改成本脚本：缺什么起什么、全部无窗口后台运行、输出照旧写 logs/。
 *
 * 用法（`启动全部.cmd` 和 `restart.bat` 只是它的双击入口）：
 *   node scripts/stack-control.mjs start     # 缺什么起什么（幂等，可重复跑）
 *   node scripts/stack-control.mjs restart   # SnowLuma + 桥接 全停再起（DSH 不动）
 *   node scripts/stack-control.mjs stop      # 停 SnowLuma + 桥接（DSH 不动）
 *   node scripts/stack-control.mjs status    # 只查端口 / QQ 登录 / 桥接连接，不动手
 *
 * 退出码：0 = 三个端口都在且 OneBot 可用；1 = 有服务没起来或 QQ 不在线；2 = 用法错误。
 *
 * 两条硬约束（沿用 .cmd 那边的规则）：
 *   · SnowLuma 的安装目录只从 config.json 的 snowluma.homeDir 读，本文件不写死任何盘符；
 *   · 只调用 SnowLuma 自己的 launcher.bat，不代装、不分发它的代码。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_DIR = path.join(ROOT, 'state');
const LAUNCHER_LOG = path.join(LOG_DIR, 'launcher.log');

const PORTS = { snowluma: 3001, dsh: 3080, bridge: 3100 };

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const CONFIG = readConfig();
const SNOWLUMA_DIR = String(CONFIG?.snowluma?.homeDir ?? '').trim();
const ONEBOT_HTTP = String(CONFIG?.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const ONEBOT_TOKEN = String(CONFIG?.snowluma?.accessToken ?? '').trim();

// ── 输出 / 日志 ────────────────────────────────────────────────────────────
// 屏幕给正在看窗口的人，launcher.log 给事后排查的人：同一行两边都写。
function record(line) {
  try {
    fs.appendFileSync(LAUNCHER_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function say(line = '') {
  console.log(line);
  record(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 端口 ──────────────────────────────────────────────────────────────────
function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** 等端口打开；返回用时（ms），超时返回 -1。 */
async function waitPort(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await portOpen(port)) return Date.now() - started;
    await sleep(400);
  }
  return -1;
}

async function waitPortClosed(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portOpen(port))) return true;
    await sleep(300);
  }
  return false;
}

function portOwners(ports) {
  const filter = ports.join(',');
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in ${filter} } |`,
    'ForEach-Object { "$($_.LocalPort)|$($_.OwningProcess)" }',
  ].join(' ');
  const out = execOut(script);
  const owners = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [portText, pidText] = line.trim().split('|');
    const port = Number.parseInt(portText, 10);
    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(port) && Number.isInteger(pid) && pid > 0) owners.set(port, pid);
  }
  return owners;
}

// ── 进程表 ────────────────────────────────────────────────────────────────
// 只要 node.exe / cmd.exe 两种：三个服务都是 node，外层守护都是 cmd /c *.bat。
// 命令行用「第一个 | 第二个 | 其余」切，避免把命令行里的 | 也当分隔符。
const PS_PROCESSES = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='cmd.exe'\" |",
  'ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }',
].join(' ');

function execOut(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function processes() {
  return execOut(PS_PROCESSES)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const first = line.indexOf('|');
      const second = line.indexOf('|', first + 1);
      if (first < 0 || second < 0) return null;
      const pid = Number.parseInt(line.slice(0, first), 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, name: line.slice(first + 1, second), cmd: line.slice(second + 1) };
    })
    .filter(Boolean);
}

// launcher.bat 跑的是 `node ./index.mjs`；bridge 跑的是 `node src/bridge.js`。
// 排除 mcp-* 与 node_modules：桥接会给每个 MCP 子进程带上仓库路径，别把工具进程误杀。
const isSnowLumaNode = (p) => p.name === 'node.exe' && /index\.mjs/i.test(p.cmd);
const isSnowLumaGuard = (p) => p.name === 'cmd.exe' && /launcher\.bat/i.test(p.cmd);
const isBridgeNode = (p) =>
  p.name === 'node.exe' && /bridge\.js/i.test(p.cmd) && !/mcp-|node_modules/i.test(p.cmd);
const isBridgeGuard = (p) => p.name === 'cmd.exe' && /start\.bat/i.test(p.cmd) && !/restart\.bat/i.test(p.cmd);
const isDshSupervisor = (p) => p.name === 'node.exe' && /dsh-web-supervisor\.mjs/i.test(p.cmd);

function killPids(targets, label) {
  for (const proc of targets) {
    try {
      process.kill(proc.pid, 'SIGKILL');
      say(`  ${label} PID ${proc.pid} 已结束`);
    } catch (error) {
      say(`  ${label} PID ${proc.pid} 结束失败：${error?.message ?? error}`);
    }
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────
// node 用 detached + windowsHide：不弹窗口，而且本窗口关掉之后子进程不会被一起收走
// （这正是 2026-11-05 DSH 被「连进程树一起杀掉」的那个坑）。node 自己不会申请控制台，
// 所以这条路上永远不会出现窗口。
function spawnNode(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

const HIDDEN_VBS = path.join(ROOT, 'scripts', 'run-hidden.vbs');

// .bat 走 wscript + run-hidden.vbs，而不是 node 直接 spawn('cmd.exe', ...)：
// detached 的子进程本来没有控制台，cmd.exe 会自己 AllocConsole 再开一个**可见**的窗口
// （2026-11-15 实测：`cmd /d /c launcher.bat` 直接以 Windows Terminal 标签页的形式
// 出现在桌面上，标题就是 `node  ./index.mjs`，正是用户抱怨的那种弹窗）。
// WshShell.Run 用 SW_HIDE 建控制台，.bat 里的 node 继承这个隐藏控制台 → 全程无窗口。
// 重定向交给 run-hidden.vbs 自己拼（`>> "log" 2>&1`）：把带内层引号的整串当参数传，
// WScript 解析不了 Node 加的 \" 转义，结果什么都不启动且不报错。
function spawnHidden(commandLine, cwd, logFile) {
  const args = ['//nologo', '//B', HIDDEN_VBS, commandLine];
  if (cwd) args.push(cwd);
  if (logFile) args.push(logFile);
  // wscript 只负责「用隐藏控制台把 .bat 拉起来」，大约 100ms 就退出；这里等它退出再继续。
  // 不等的话，父进程先结束时会把还没 fork 出 cmd 的 wscript 一起带走（实测：什么都不启动，
  // 日志里也没有任何痕迹），等它退出还能拿到真正的失败原因。
  return new Promise((resolve) => {
    const child = spawn('wscript.exe', args, {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    const finish = (result) => {
      child.unref();
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), 5000);
    child.on('error', (error) => {
      clearTimeout(timer);
      record(`  启动「${commandLine}」失败：${error?.message ?? error}`);
      finish('error');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) record(`  启动「${commandLine}」时 wscript 退出码 ${code}`);
      finish(code ?? 'exit');
    });
  });
}



async function stopSnowLuma() {
  const nodes = processes().filter(isSnowLumaNode);
  const guards = processes().filter(isSnowLumaGuard);
  if (!nodes.length && !guards.length) return;
  killPids(nodes, 'SnowLuma');
  killPids(guards, 'SnowLuma 启动窗口');
  await waitPortClosed(PORTS.snowluma, 15000);
}

async function stopBridge() {
  const guards = processes().filter(isBridgeGuard);
  const nodes = processes().filter(isBridgeNode);
  if (!guards.length && !nodes.length) return;
  // 先杀守护窗口：反过来的话 :loop 会在 5 秒后把刚杀掉的 node 又拉起来。
  killPids(guards, '桥接守护窗口');
  killPids(nodes, '桥接');
  await waitPortClosed(PORTS.bridge, 15000);
  // 只剩过期锁时才删：桥接自己也会处理过期锁，这里只是少一次 exit 2。
  if (!processes().filter(isBridgeNode).length) {
    try {
      fs.rmSync(path.join(STATE_DIR, 'bridge.lock'), { force: true });
    } catch {}
  }
}

async function ensureSnowLuma(recover) {
  if (await portOpen(PORTS.snowluma)) return { state: 'running' };
  const nodes = processes().filter(isSnowLumaNode);
  if (nodes.length) {
    const ms = await waitPort(PORTS.snowluma, 60000);
    if (ms >= 0) return { state: 'booting', ms };
    if (!recover) return { state: 'hung', pids: nodes.map((p) => p.pid) };
    say(`  SnowLuma 进程在（PID ${nodes.map((p) => p.pid).join(', ')}）但 60 秒没开 3001，按卡死处理，重拉`);
    await stopSnowLuma();
  }
  const launcher = SNOWLUMA_DIR ? path.join(SNOWLUMA_DIR, 'launcher.bat') : '';
  if (!launcher || !fs.existsSync(launcher)) {
    return { state: 'nodir', detail: launcher || 'config.json 的 snowluma.homeDir 为空' };
  }
  await spawnHidden('cmd /d /c launcher.bat', SNOWLUMA_DIR, path.join(LOG_DIR, 'snowluma.out'));
  const ms = await waitPort(PORTS.snowluma, 90000);
  if (ms < 0) return { state: 'failed' };
  return { state: nodes.length ? 'recovered' : 'started', ms };
}

async function ensureDsh() {
  const supervisors = processes().filter(isDshSupervisor);
  if (await portOpen(PORTS.dsh)) return { state: 'running', supervisor: supervisors.length > 0 };
  if (!supervisors.length) {
    spawnNode([path.join(ROOT, 'scripts', 'dsh-web-supervisor.mjs')], ROOT);
  }
  const ms = await waitPort(PORTS.dsh, 120000);
  if (ms < 0) return { state: 'failed' };
  return { state: supervisors.length ? 'booting' : 'started', ms };
}

async function ensureBridge(recover) {
  if (await portOpen(PORTS.bridge)) return { state: 'running' };
  const nodes = processes().filter(isBridgeNode);
  if (nodes.length || processes().filter(isBridgeGuard).length) {
    const ms = await waitPort(PORTS.bridge, 60000);
    if (ms >= 0) return { state: 'booting', ms };
    if (!recover) return { state: 'hung', pids: nodes.map((p) => p.pid) };
    say('  桥接进程在但 60 秒没开 3100，按卡死处理，重拉');
    await stopBridge();
  }
  await spawnHidden('cmd /c start.bat', ROOT, path.join(LOG_DIR, 'bridge.out'));
  const ms = await waitPort(PORTS.bridge, 60000);
  if (ms < 0) return { state: 'failed' };
  return { state: nodes.length ? 'recovered' : 'started', ms };
}

// ── 体检 ──────────────────────────────────────────────────────────────────
/**
 * 只读的小 JSON 请求。刻意不用 fetch：undici 的连接池会在 process.exit() 那一刻还挂在
 * 事件循环上，Windows 上会撞 libuv 断言
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 * （退出码 0xC0000409）。agent:false + Connection: close 让每个请求用完就关，脚本能干净退出。
 */
function httpJson(url, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = http.request(
      url,
      { method: 'GET', agent: false, headers: { Connection: 'close', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ ok: res.statusCode === 200, status: res.statusCode, text, body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', (error) => resolve({ ok: false, status: 0, text: '', detail: error?.message ?? String(error) }));
    req.end();
  });
}

const CONSOLE_TOKEN = (() => {
  try {
    return fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
})();

async function oneBotLogin() {
  const res = await httpJson(
    `${ONEBOT_HTTP}/get_login_info`,
    ONEBOT_TOKEN ? { Authorization: `Bearer ${ONEBOT_TOKEN}` } : {},
  );
  if (!res.ok) return { ok: false, detail: res.detail ?? `HTTP ${res.status}（${ONEBOT_HTTP}）` };
  const body = res.body;
  if (body?.status !== 'ok' || body?.retcode !== 0) return { ok: false, detail: res.text.slice(0, 200) };
  return { ok: true, userId: body.data?.user_id, nickname: body.data?.nickname ?? '' };
}

const BRIDGE_HTTP = `http://127.0.0.1:${PORTS.bridge}`;

/**
 * 问一次桥接自己的 /api/status：这是「端口开着」和「真的连上网关」的区别所在。
 * 早先是去 state/bridge.log 里找最后一条「SnowLuma 已连接」，但那个文件到了 2000 行会
 * 轮转成 bridge.log.1（src/bridge.js 的 createCappedLogger），轮转恰好把启动那几行
 * ——包括「已连接」——搬进 .1，于是刚重启完反而查不到，报告里误报「可能仍在重连」。
 * /api/status 里 snowluma.connected 是桥接自己维护的实时状态，比日志可靠。
 */
async function bridgeStatus() {
  const res = await httpJson(
    `${BRIDGE_HTTP}/api/status`,
    CONSOLE_TOKEN ? { 'x-console-token': CONSOLE_TOKEN } : {},
    4000,
  );
  if (res.ok) return { ok: true, body: res.body };
  if (res.status === 401) {
    return {
      ok: false,
      detail: CONSOLE_TOKEN
        ? 'HTTP 401（state/console-token 与桥接里的令牌不一致，桥接重启后可能已换新）'
        : 'HTTP 401（state/console-token 不存在，拿不到控制台视图）',
    };
  }
  return { ok: false, detail: res.detail ?? `HTTP ${res.status}（${BRIDGE_HTTP}/api/status）` };
}

/** 把 /api/status 里的 snowluma 快照翻译成一句人话。 */
function describeBridge(status) {
  const snap = status.body?.snowluma ?? {};
  const parts = [snap.connected ? 'SnowLuma 已连接' : 'SnowLuma 未连接'];
  if (snap.accountOnline === true) parts.push('账号在线');
  else if (snap.accountOnline === false) parts.push('账号离线');
  if (snap.good === false) parts.push('上游自报接收异常');
  if (snap.silent) parts.push(`${Math.round((snap.lastPacketAgoMs ?? 0) / 60000)} 分钟没有事件包`);
  if (status.body?.dshReady) parts.push('DSH 就绪');
  return parts.join('，');
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** 中文算两个宽，让三行端口报告左对齐。 */
function padLabel(text, width) {
  let used = 0;
  for (const ch of text) used += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return text + ' '.repeat(Math.max(0, width - used));
}

function describe(state, kind) {
  switch (state.state) {
    case 'running':
      return '已在运行';
    case 'started':
      return `已启动（${seconds(state.ms)} 后监听）`;
    case 'recovered':
      return `卡死后重拉（${seconds(state.ms)} 后监听）`;
    case 'booting':
      return `本来就在，等 ${seconds(state.ms)} 后监听`;
    case 'hung':
      return `进程在（PID ${state.pids.join(', ')}）但端口没开 —— 跑 restart 或 stop 再 start`;
    case 'nodir':
      return `没启动：${state.detail}`;
    case 'failed':
      return `没起来（看 ${kind === 'snowluma' ? 'logs/snowluma.out' : 'logs/bridge.out'}）`;
    default:
      return JSON.stringify(state);
  }
}

async function report() {
  const owners = portOwners([PORTS.snowluma, PORTS.dsh, PORTS.bridge]);
  const rows = [
    ['SnowLuma', PORTS.snowluma],
    ['DSH web', PORTS.dsh],
    ['桥接', PORTS.bridge],
  ];
  let allUp = true;
  for (const [name, port] of rows) {
    const open = await portOpen(port);
    if (!open) allUp = false;
    const pid = owners.get(port);
    say(`  ${padLabel(name, 9)} 127.0.0.1:${port}  ${open ? `✅ 监听中（PID ${pid ?? '?'}）` : '❌ 未监听'}`);
  }
  const login = await oneBotLogin();
  if (login.ok) {
    say(`  QQ 账号  ${login.userId}${login.nickname ? `（${login.nickname}）` : ''}  ✅ OneBot HTTP 正常`);
  } else {
    say(`  QQ 账号  ❌ ${login.detail}`);
  }
  const conn = allUp ? await bridgeStatus() : { ok: false, detail: '桥接没在跑' };
  if (conn.ok) {
    const snap = conn.body?.snowluma ?? {};
    const icon = snap.connected ? '✅' : '⚠️';
    say(`  桥接→网关  ${icon} ${describeBridge(conn)}`);
  } else {
    say(`  桥接→网关  ⚠️ ${conn.detail}`);
  }
  return allUp && login.ok && conn.ok && conn.body?.snowluma?.connected === true;
}

async function doStart() {
  say(`== 启动 AutoChat（${ROOT}） ==`);

  const snow = await ensureSnowLuma(true);
  say(`[1/3] SnowLuma  ${describe(snow, 'snowluma')}`);

  const dsh = await ensureDsh();
  say(`[2/3] DSH web   ${describe(dsh, 'dsh')}`);

  const bridge = await ensureBridge(true);
  say(`[3/3] 桥接      ${describe(bridge, 'bridge')}`);

  // 桥接起来之后还要跟网关握一次手：端口在 ≠ 连上了，最多等 20 秒。
  if (bridge.state !== 'failed') {
    for (let i = 0; i < 20; i += 1) {
      const snap = await bridgeStatus();
      if (snap.ok && snap.body?.snowluma?.connected === true) break;
      await sleep(1000);
    }
  }

  say('  ── 体检 ──');
  const ok = await report();
  say(ok ? '✅ 全部就绪，QQ 机器人应该已经在线。' : '⚠️ 有服务没起来：看 logs/launcher.log、logs/snowluma.out、logs/bridge.out、logs/dsh-web.out。');
  return ok;
}

async function doRestart() {
  say('== 重启 SnowLuma + 桥接（DSH web 不动） ==');
  if (await portOpen(PORTS.bridge)) say('  停桥接…');
  await stopBridge();
  if (await portOpen(PORTS.snowluma)) say('  停 SnowLuma…');
  await stopSnowLuma();
  say('  旧实例已清干净。');
  return doStart();
}

async function doStop() {
  say('== 停止 SnowLuma + 桥接（DSH web 不动） ==');
  await stopBridge();
  await stopSnowLuma();
  say('  已停止。要重新起来就跑 start（或双击 启动全部.cmd）。');
  return true;
}

const command = (process.argv[2] ?? 'start').toLowerCase();

try {
  let ok = false;
  if (command === 'start') ok = await doStart();
  else if (command === 'restart') ok = await doRestart();
  else if (command === 'stop') ok = await doStop();
  else if (command === 'status') {
    say(`== AutoChat 状态（${ROOT}） ==`);
    ok = await report();
  } else {
    console.error(`未知命令：${command}（可用：start / stop / restart / status）`);
    process.exit(2);
  }
  // 用 exitCode 而不是 process.exit()：后者会在句柄还没关完时强杀事件循环，
  // Windows 上偶发 libuv 断言（0xC0000409），退出码反而变得不可信。
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`[失败] ${error?.stack ?? error}`);
  record(`失败：${error?.message ?? error}`);
  process.exitCode = 1;
}
