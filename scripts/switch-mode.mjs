#!/usr/bin/env node
/**
 * 切换桥接模式（chat / reserved / reserved2 / closed-agent / simulation）。
 *
 * 为什么需要这个脚本：DSH 0.2.0 里 `qq-mode` 命名空间的「生效值」来自插件 entry 的
 * config，`settings.update` 会把它持久化进 profile 的 cordis.patch.yml，但**运行中的
 * fiber 不会热更新**——桥接下一次轮询读到的还是旧值，于是刚切的模式几秒内被回滚
 * （见 state/mode.json 与 bridge 日志里的「桥接模式已切换为: chat」）。
 *
 * 所以这里做完整的一步：改 profile 里 `- id: qq-mode` 的 config.mode → 重启 DSH web
 * → 等 3080 起来 → 用桥接的 /api/status 读回真实模式。
 *
 * 用法：node scripts/switch-mode.mjs reserved2
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MODES = new Set(['chat', 'reserved', 'reserved2', 'closed-agent', 'simulation']);
const mode = process.argv[2];
if (!mode || !MODES.has(mode)) {
  console.error(`用法: node scripts/switch-mode.mjs <${[...MODES].join('|')}>`);
  process.exit(2);
}

const DSH_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'web');
const PATCH = path.join(DSH_PROFILE, 'cordis.patch.yml');
const BRIDGE_STATUS = 'http://127.0.0.1:3100/api/status';
const STATE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'state');

/** 在 patch 里把 `- id: qq-mode` 这一条 entry 的 config.mode 设成目标值。 */
function setEntryConfigMode(source, value) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^-\s*id:\s*qq-mode\s*$/.test(line));
  if (start < 0) throw new Error(`cordis.patch.yml 里找不到「- id: qq-mode」entry（${PATCH}）`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end);
  const cfgAt = block.findIndex((line) => /^(\s+)config:\s*$/.test(line));
  if (cfgAt < 0) {
    // 没有 config 段：按 entry 缩进补一个
    const indent = (block[0].match(/^\s*/) || [''])[0];
    block.push(`${indent}config:`, `${indent}  mode: ${value}`);
  } else {
    const modeAt = block.findIndex((line, i) => i > cfgAt && /^\s+mode:\s*\S+\s*$/.test(line));
    if (modeAt < 0) block.splice(cfgAt + 1, 0, `${(block[cfgAt].match(/^\s*/) || [''])[0]}  mode: ${value}`);
    else block[modeAt] = block[modeAt].replace(/mode:\s*\S+/, `mode: ${value}`);
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n');
}

function portOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function killDshWeb() {
  const { execFileSync } = await import('node:child_process');
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"], { encoding: 'utf8' }).trim();
  } catch {}
  const pid = Number.parseInt(out, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  for (let i = 0; i < 20; i += 1) {
    if (!(await portOpen(3080))) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await portOpen(3080));
}

async function startDshWeb() {
  const logFile = path.join(path.dirname(STATE_DIR), 'logs', 'dsh-web.out');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const child = spawn('cmd.exe', ['/c', 'dsh --profile web --port 3080 --no-open'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  for (let i = 0; i < 120; i += 1) {
    if (await portOpen(3080)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function bridgeMode() {
  const tokenFile = path.join(path.dirname(STATE_DIR), 'state', 'console-token');
  let token = '';
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch {}
  try {
    const res = await fetch(`${BRIDGE_STATUS}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    const body = await res.json();
    return body?.mode ?? '(unknown)';
  } catch {
    return '(桥接未运行)';
  }
}

const original = fs.readFileSync(PATCH, 'utf8');
const next = setEntryConfigMode(original, mode);
if (next !== original) {
  fs.writeFileSync(`${PATCH}.bak-mode-${Date.now()}`, original);
  fs.writeFileSync(PATCH, next);
  console.log(`已写入 profile 配置: ${PATCH} → mode: ${mode}`);
} else {
  console.log(`profile 配置已是 mode: ${mode}`);
}

const stopped = await killDshWeb();
console.log(stopped ? '已停止旧的 DSH web' : '未发现运行中的 DSH web（继续启动）');
const up = await startDshWeb();
if (!up) {
  console.error('DSH web 未能在 120s 内监听 3080，请手动运行 dsh --profile web --port 3080 --no-open');
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 4000));
console.log(`DSH web 已就绪，桥接当前模式: ${await bridgeMode()}`);
