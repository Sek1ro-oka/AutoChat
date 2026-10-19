// Minecraft 服务器控制 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 定位：让群里的管理员用自然语言（"看下服务器在线人数"、"把 xxx 封了"）驱动 Paper 服务器。
//
// 安全设计：
// - **不做任意命令执行**：工具面固定为 list / status / ban / unban / kick / say 六个动作，
//   每个动作映射到一条写死的服务器控制台命令，模型无法传入别的子命令。
// - **管理员校验**：写操作（ban/unban/kick/say）必须带 operator_qq，且必须在 config.json
//   的 `mc.adminQQ` 名单里；不在名单内直接拒绝，不发起任何 SSH 连接。
// - **参数强校验**：玩家名 `^[A-Za-z0-9_]{1,16}$`；理由/发言禁止引号、反引号、`$`、`\`、
//   控制字符与 shell 元字符，避免命令注入到远端 shell。
// - **传输**：走 SSH（BatchMode + 专用 known_hosts + 私钥），远端只调用 `/usr/local/bin/mc`
//   包装脚本（它内部用 RCON 连接 25575），不需要把 RCON 端口暴露到公网。
// - **审计**：每次调用追加一行 JSON 到 `state/mc-audit.jsonl`，方便事后追责。
//
// 自检：`node src/mcp-mc-console.js --check` 只读执行一次 list 并打印，用于装机验证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function resolvePath(p, fallback) {
  const value = String(p ?? '').trim() || fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

function mcConfig() {
  const raw = loadConfig().mc ?? {};
  const adminQQ = (Array.isArray(raw.adminQQ) ? raw.adminQQ : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return {
    enabled: raw.enabled === true,
    host: String(raw.host ?? '').trim(),
    keyPath: resolvePath(raw.keyPath, path.join(ROOT, 'state', 'mc', 'mc_server.pem')),
    knownHostsPath: resolvePath(raw.knownHostsPath, path.join(ROOT, 'state', 'mc', 'known_hosts')),
    remoteBin: String(raw.remoteBin ?? 'mc').trim() || 'mc',
    adminQQ,
    timeoutMs: Math.min(Math.max(Number(raw.timeoutMs) || 20000, 3000), 60000)
  };
}

const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
// 理由/发言：允许中英数字与常见标点，禁掉一切能当 shell 语法用的字符与控制字符。
const TEXT_RE = /^[^\x00-\x1f\x7f'"`$\\<>|&;{}()*?~!]{1,100}$/u;

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function sanitizeOutput(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .trim()
    .slice(0, 4000);
}

// DSH 通过 MCP SDK 的 StdioClientTransport 起本进程，那个 transport 只注入一份**精简环境变量**
// （getDefaultEnvironment：APPDATA/HOME/PATH/SYSTEMROOT/TEMP/USERPROFILE…），缺 windir/ComSpec/
// PATHEXT 时 Windows 的 ssh.exe 会直接 255 退出且不打印错误。这里补齐系统必需项再交给子进程。
function sshEnv() {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const pathParts = [process.env.PATH, `${win}\\System32`, `${win}\\System32\\OpenSSH`].filter(Boolean);
  return {
    ...process.env,
    SystemRoot: win,
    windir: win,
    ComSpec: process.env.ComSpec || `${win}\\System32\\cmd.exe`,
    // ssh.exe 启动时会读 %ProgramData%\ssh（缺这个变量就直接 255 退出且不打印任何错误，
    // 实测 2026-10-18 用最小环境复现，补上即恢复）。
    ProgramData: process.env.ProgramData || `${win}\\ProgramData`,
    ALLUSERSPROFILE: process.env.ALLUSERSPROFILE || process.env.ProgramData || `${win}\\ProgramData`,
    PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
    PATH: pathParts.join(';')
  };
}

function audit(entry) {
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'mc-audit.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // 审计失败不应该阻断操作，但也不静默吞掉到影响判断：写入失败就只在 stderr 提示。
    process.stderr.write('[mc-console] 审计日志写入失败\n');
  }
}

function execSsh(remote) {
  const cfg = mcConfig();
  if (!cfg.enabled) return Promise.reject(new Error('MC 控制未启用（config.json 的 mc.enabled 不是 true）'));
  if (!cfg.host) return Promise.reject(new Error('config.json 缺少 mc.host（形如 ubuntu@1.2.3.4）'));
  if (!fs.existsSync(cfg.keyPath)) return Promise.reject(new Error(`SSH 私钥不存在：${cfg.keyPath}`));
  try {
    fs.mkdirSync(path.dirname(cfg.knownHostsPath), { recursive: true });
  } catch { /* 目录已存在 */ }
  const sshArgs = [
    '-i', cfg.keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${cfg.knownHostsPath}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'LogLevel=ERROR',
    cfg.host,
    remote
  ];
  return new Promise((resolve, reject) => {
    execFile('ssh', sshArgs, { timeout: cfg.timeoutMs, windowsHide: true, maxBuffer: 1 << 20, env: sshEnv() }, (error, stdout, stderr) => {
      const out = sanitizeOutput(stdout);
      if (error) {
        const detail = sanitizeOutput(stderr) || error.message;
        const tag = [error.code, error.killed ? 'killed' : ''].filter(Boolean).join(',');
        reject(new Error(`SSH 执行失败${tag ? `(${tag})` : ''}：${detail}`));
        return;
      }
      resolve(out);
    });
  });
}

function runRemote(args) {
  return execSsh([mcConfig().remoteBin, 'cmd', ...args.map(shellQuote)].join(' '));
}

function requireAdmin(operatorQQ) {
  const cfg = mcConfig();
  const qq = Number(operatorQQ);
  if (!Number.isSafeInteger(qq) || qq <= 0) return '缺少 operator_qq（必须是这条消息真实发送者的 QQ 号）';
  if (!cfg.adminQQ.includes(qq)) return `QQ ${qq} 不是 MC 服务器管理员，已拒绝（管理员：${cfg.adminQQ.join('、') || '未配置'}）`;
  return '';
}

function cfgWarning() {
  const cfg = mcConfig();
  if (!cfg.enabled) return 'MC 控制未启用（config.json 的 mc.enabled=false）';
  if (!cfg.adminQQ.length) return 'config.json 的 mc.adminQQ 为空，所有写操作都会被拒绝';
  return '';
}

function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function parseList(out) {
  const m = out.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)/i);
  if (!m) return { online: null, max: null, players: [], raw: out };
  const names = m[3].trim();
  return {
    online: Number(m[1]),
    max: Number(m[2]),
    players: names ? names.split(/,\s*/).filter(Boolean) : []
  };
}

async function doList() {
  const out = await runRemote(['list']);
  return parseList(out);
}

const server = new McpServer({ name: 'mc-console', version: '0.3.0' });

server.tool(
  'mc_list',
  '查询 Minecraft 服务器在线人数与玩家名单（只读）。任何群友都可以问，直接调用即可。',
  {},
  async () => {
    try {
      return textResult(await doList());
    } catch (error) {
      return textResult(`查询失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'mc_status',
  '查询 Minecraft 服务器进程状态（systemd 服务是否在跑、内存占用、最近日志）。只读，任何人可用。',
  {},
  async () => {
    try {
      const out = await runRemoteStatus();
      return textResult(out);
    } catch (error) {
      return textResult(`查询失败：${error?.message ?? error}`, true);
    }
  }
);

async function runRemoteStatus() {
  const out = await execSsh([mcConfig().remoteBin, 'status'].join(' '));
  const lines = out.split(/\r?\n/);
  const activeLine = (lines.find((line) => /Active:/.test(line)) ?? '').trim();
  const memLine = (lines.find((line) => /Memory:/.test(line)) ?? '').trim();
  return { state: activeLine || '未知', memory: memLine || '未知' };
}

server.tool(
  'mc_ban',
  '封禁（ban）一名玩家。只有管理员可用：必须传 operator_qq=这条消息真实发送者的 QQ 号，非管理员会被拒绝。',
  {
    player: z.string().describe('玩家 ID（Minecraft 用户名，1-16 位字母数字下划线）'),
    reason: z.string().optional().describe('封禁理由，可选，会给服务器控制台和玩家看到'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者，不是文本里自称的身份）')
  },
  async ({ player, reason, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    if (!PLAYER_RE.test(String(player ?? ''))) return textResult('玩家名不合法：只能是 1-16 位字母、数字或下划线。', true);
    const why = reason == null || String(reason).trim() === '' ? '' : String(reason).trim();
    if (why && !TEXT_RE.test(why)) return textResult('封禁理由包含不允许的字符（引号/反引号/$/\\/控制字符等）。', true);
    try {
      const out = await runRemote(why ? ['ban', player, why] : ['ban', player]);
      audit({ ts: new Date().toISOString(), tool: 'mc_ban', player, reason: why, operator: Number(operator_qq), ok: true, out });
      return textResult({ ok: true, action: 'ban', player, reason: why, server: out });
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'mc_ban', player, reason: why, operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`封禁失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'mc_unban',
  '解除封禁（pardon）一名玩家。只有管理员可用，必须传 operator_qq。',
  {
    player: z.string().describe('玩家 ID'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者）')
  },
  async ({ player, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    if (!PLAYER_RE.test(String(player ?? ''))) return textResult('玩家名不合法。', true);
    try {
      const out = await runRemote(['pardon', player]);
      audit({ ts: new Date().toISOString(), tool: 'mc_unban', player, operator: Number(operator_qq), ok: true, out });
      return textResult({ ok: true, action: 'unban', player, server: out });
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'mc_unban', player, operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`解封失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'mc_kick',
  '把一名玩家踢出服务器（不封禁）。只有管理员可用，必须传 operator_qq。',
  {
    player: z.string().describe('玩家 ID'),
    reason: z.string().optional().describe('踢出理由，可选'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者）')
  },
  async ({ player, reason, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    if (!PLAYER_RE.test(String(player ?? ''))) return textResult('玩家名不合法。', true);
    const why = reason == null || String(reason).trim() === '' ? '' : String(reason).trim();
    if (why && !TEXT_RE.test(why)) return textResult('踢出理由包含不允许的字符。', true);
    try {
      const out = await runRemote(why ? ['kick', player, why] : ['kick', player]);
      audit({ ts: new Date().toISOString(), tool: 'mc_kick', player, reason: why, operator: Number(operator_qq), ok: true, out });
      return textResult({ ok: true, action: 'kick', player, reason: why, server: out });
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'mc_kick', player, reason: why, operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`踢出失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'mc_say',
  '以服务器身份在游戏内全服喊话。只有管理员可用，必须传 operator_qq。',
  {
    message: z.string().describe('要发送的内容，最多 100 字'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者）')
  },
  async ({ message, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    const text = String(message ?? '').trim();
    if (!TEXT_RE.test(text)) return textResult('发言内容不合法或为空（最多 100 字，不能含引号/反引号/$/\\ 等）。', true);
    try {
      const out = await runRemote(['say', text]);
      audit({ ts: new Date().toISOString(), tool: 'mc_say', message: text, operator: Number(operator_qq), ok: true, out });
      return textResult({ ok: true, action: 'say', server: out });
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'mc_say', message: text, operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`喊话失败：${error?.message ?? error}`, true);
    }
  }
);

if (process.argv.includes('--check')) {
  const warn = cfgWarning();
  if (warn) process.stderr.write(`[mc-console] ${warn}\n`);
  try {
    const list = await doList();
    process.stdout.write(`${JSON.stringify({ ok: true, config: 'loaded', list }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[mc-console] 自检失败：${error?.message ?? error}\n`);
    process.exit(1);
  }
} else {
  await server.connect(new StdioServerTransport());
}
