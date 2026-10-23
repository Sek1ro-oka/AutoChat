// 三平台只读检索的**适配层**：把「搜一下 / 读一条」翻译成三个上游 CLI 的调用，
// 再把结果收敛成模型能直接读的一段纯文本。
//
// 三个平台的后端不一样，所以这里是三种适配，不是一个通用函数：
//   · B站    → `bili search/video --json`（用户机器上的 bili-cli，与 src/mcp-bili-safe.js 同源）
//   · 小黑盒 → 直接复用 `src/heybox-tools.js` 的 createHeyboxTools()：
//              它已经处理了「清代理变量」这个必须的坑（本机 NO_PROXY 里的 `[::1]` 会让
//              xiaoheihe-cli 里的 httpx 直接抛 Invalid port），还有验证码暂停与额度账本。
//   · 小红书 → `opencli xiaohongshu search/note -f json`。没有可复用的实现，所以自建，
//              但它依赖本机 Chrome 里已登录的会话：没登录/页面改版就会失败。
//
// 安全约束（本文件必须一直满足）：
// - **只读**：只会调 `search` 与 `note`/`video`/`post get` 这类读接口；本文件里不存在、
//   也不许出现任何写动作的子命令名（单测 scripts/test-reach-tools.mjs 会做源码断言）。
// - **不走 shell 拼串**：一律 spawn(可执行文件, argv 数组)。唯一的例外是 Windows 上
//   npm 装的 `opencli.cmd`：Node ≥20.12 直接 spawn `.cmd` 会 EINVAL，必须经 cmd.exe，
//   但仍然是「数组传参、不拼命令字符串」，见 spawnTarget()。
// - **超时 + 输出上限**：默认 120s、stdout 4MB，超了 kill 子进程并如实报 unavailable。
// - **不吞异常**：任何失败都返回 `{ ok:false, code, error }`，error 里带上游原文，
//   绝不用「空结果」冒充成功（小红书超时/改版时最容易犯这个错）。
//
// 可测试性：runCli / heybox / readConfig / now / exists 都能注入，
// scripts/test-reach-tools.mjs 全部用桩跑，不发真实请求。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createHeyboxTools, defaultReadConfig, defaultRunCli as defaultHeyboxRunCli } from './heybox-tools.js';
import {
  LIMIT_DEFAULT,
  PLATFORM_CHOICES,
  QUERY_MAX,
  READ_MAX_CHARS,
  cleanQuery,
  clampLimit,
  extractJson,
  failureOf,
  formatReadResult,
  formatSearchResult,
  formatXhsAsk,
  normalizePlatform,
  normalizeQuery,
  normalizeReachConfig,
  normalizeTarget,
  parseBiliSearch,
  parseBiliVideo,
  parseHeyboxPost,
  parseHeyboxSearch,
  parseXhsAsk,
  parseXhsNote,
  parseXhsSearch,
  searchShape,
  xhsSearchUnavailableByMessage
} from './reach-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** stdout 硬上限：再多就 kill（正常返回都在几十 KB 量级，这是「绝不被撑爆」的保险）。 */
const MAX_STDOUT = 4 * 1024 * 1024;

/**
 * 小黑盒搜索的「请求条数下限」。
 *
 * 实测：`xiaoheihe-cli search --limit 1/2` 会返回 **0 条**（ok:true、items 空），
 * `--limit 5` 给 2 条、`--limit 10` 给 6 条。也就是说这个小 CLI 的 limit 语义和
 * 「要几条」并不等价。我们按 ≥8 去要，再在本地截到调用方要的条数——
 * 否则模型按默认 limit 调用时永远看到「没有结果」，那是假象。
 */
const HEYBOX_REQUEST_FLOOR = 8;
const HEYBOX_REQUEST_MAX = 10; // heybox-tools 自己也会把上限夹到 10

/**
 * 小红书搜索的「请求条数」：dev-doc §3.2 的 n×2 或 ≥8（上限 20，避免一次要太多）。
 *
 * 为什么要多要：站内搜索经常只回一半就结束，按 count 精确要会让本地 slice 后只剩几条。
 * 本地仍然按调用方的 `limit` 截断，所以多要不影响对外条数。
 */
const XHS_REQUEST_FLOOR = 8;
const XHS_REQUEST_MAX = 20;
function xhsRequestCount(count) {
  return Math.min(Math.max(count * 2, XHS_REQUEST_FLOOR), XHS_REQUEST_MAX);
}

/** 走 cmd.exe 时不能出现的字符：它们会被 cmd 重新解释（`&`=命令分隔、`%`=变量展开、`!`=延迟展开…）。 */
const CMD_UNSAFE_RE = /["&|<>^%()!\r\n]/;

class ReachError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ReachError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/**
 * 这次失败该不该触发小红书「搜索 → AI 问答」降级。
 *
 * 只认**站点侧不可用**：runCli 抛错（超时/起不来）与 readCliJson/形状检查产生的
 * `code:'unavailable'` 都算；`bad_query` / `bad_target` 这类参数错误绝不降级
 * （用户输错了词，改调 ask 只会把错误放大一次）。
 */
function fallbackEligible(error) {
  if (error instanceof ReachError) return error.code === 'unavailable';
  return true;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 上游原始输出的一小段：报错时给人看「到底回了什么」，但别把几 MB 塞进上下文。 */
function excerpt(value, max = 200) {
  const text = textOf(value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// ── 二进制探测 ──────────────────────────────────────────────────────────────
function expandEnv(value) {
  return textOf(value).replace(/%([^%]+)%/g, (whole, key) => process.env[key] ?? whole);
}

function pathextList() {
  if (process.platform !== 'win32') return [''];
  const raw = textOf(process.env.PATHEXT) || '.COM;.EXE;.BAT;.CMD';
  // `.exe` 排最前（原生可执行，能完全避开 cmd.exe）；裸名字排**最后**——
  // npm 的 bin 目录里同时躺着 `opencli`（给 sh 用的无扩展名脚本）和 `opencli.cmd`，
  // 先命中前者会得到一个 CreateProcess 跑不起来的路径。
  const exts = raw.split(';').map((item) => item.trim().toLowerCase()).filter(Boolean);
  exts.sort((a, b) => (a === '.exe' ? -1 : b === '.exe' ? 1 : 0));
  return [...exts, ''];
}

/**
 * 在 PATH 里找一个可执行文件（不 spawn、不 shell）。
 *
 * 为什么不用 `where`/`which`：reach_status 要求「不发网络请求、尽快回答能不能用」，
 * 多起一个进程只为查路径不划算；而 fs.existsSync 扫目录在本地是毫秒级。
 */
function whichSync(name, exists = fs.existsSync) {
  const target = textOf(name).trim();
  if (target === '') return '';
  if (path.isAbsolute(target)) return exists(target) ? target : '';
  const dirs = textOf(process.env.PATH).split(path.delimiter).filter(Boolean);
  const hasExt = path.extname(target) !== '';
  for (const dir of dirs) {
    const names = hasExt ? [target] : pathextList().map((ext) => `${target}${ext}`);
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return '';
}

/**
 * 解析一个「可执行文件」配置值。
 *
 * 三种写法都要认，混在一起会出真事故（实测踩过一次）：
 *   · 空串         → 按裸命令名走 PATH（`whichSync`）
 *   · 裸命令名     → 走 PATH（`xiaoheihe-cli` 这种；**不能**当成仓库下的相对路径，
 *                    否则会解析出 `E:\AutoChat\xiaoheihe-cli` 然后报「找不到」）
 *   · 绝对/相对路径 → `%VAR%` 展开；相对路径按仓库根解析（与 mcp-bili-safe 的 bili.bin 同口径）
 */
function resolveBinValue(value, fallbackName, exists) {
  const raw = textOf(value).trim();
  const name = raw !== '' ? raw : textOf(fallbackName).trim();
  if (name === '') return '';
  const expanded = expandEnv(name);
  const looksLikePath = path.isAbsolute(expanded) || /[\\/]/.test(expanded);
  if (!looksLikePath) return whichSync(expanded, exists) || expanded;
  return path.isAbsolute(expanded) ? expanded : path.resolve(ROOT, expanded);
}

function defaultBiliBin(exists) {
  const home = textOf(process.env.USERPROFILE) || textOf(process.env.HOME);
  for (const candidate of [path.join(home, '.local', 'bin', 'bili.exe'), path.join(home, '.local', 'bin', 'bili')]) {
    if (home !== '' && exists(candidate)) return candidate;
  }
  return whichSync('bili', exists);
}

function defaultOpencliBin(exists) {
  const appData = textOf(process.env.APPDATA);
  // 顺序很重要：.exe 先探测（原生可执行，不需要 cmd.exe），再退到 npm 的 .cmd 包装。
  const candidates = [
    path.join(appData, 'npm', 'opencli.exe'),
    path.join(appData, 'npm', 'opencli.cmd'),
    path.join(appData, 'npm', 'opencli')
  ];
  for (const candidate of candidates) {
    if (appData !== '' && exists(candidate)) return candidate;
  }
  return whichSync('opencli', exists);
}

function resolveBins(cfg, readConfig, exists = fs.existsSync) {
  let heyboxCli = cfg.xiaoheiheBin;
  if (heyboxCli === '') {
    // 没配就跟随 heybox 段自己的 cliPath（默认 xiaoheihe-cli），两边不能各认一个。
    try {
      const heyboxCfg = readConfig()?.heybox ?? {};
      heyboxCli = textOf(heyboxCfg.cliPath).trim();
    } catch {
      heyboxCli = '';
    }
  }
  return {
    bili: cfg.biliBin !== '' ? resolveBinValue(cfg.biliBin, 'bili', exists) : defaultBiliBin(exists),
    opencli: cfg.opencliBin !== '' ? resolveBinValue(cfg.opencliBin, 'opencli', exists) : defaultOpencliBin(exists),
    heybox: resolveBinValue(heyboxCli, 'xiaoheihe-cli', exists)
  };
}

function binAvailable(bin, exists) {
  return textOf(bin) !== '' && exists(bin);
}

// ── 子进程 ──────────────────────────────────────────────────────────────────
/** 绝不透传给子进程的环境变量：密钥类与 DSH 自己的运行时变量。 */
const SECRET_ENV_RE = /(key|token|secret|password|cookie|pass|credential|signature|auth)/i;

/**
 * 明确放行的「名字里带 auth、但其实不是密钥」的变量。
 * `SSH_AUTH_SOCK` 只是 ssh-agent 的 socket 路径，不是凭据；直接按 /auth/i 过滤会误伤。
 */
const SAFE_ENV_EXCEPTIONS = Object.freeze(new Set(['SSH_AUTH_SOCK']));

/**
 * 子进程环境：**只挑需要的**，不再 `{...process.env}` 全量透传。
 *
 * 为什么必须过滤：这些 CLI 是我们 spawn 的第三方程序，`process.env` 里躺着
 * `DEEPSEEK_API_KEY`、`DSH_*`（宿主运行时）以及各种 `*_TOKEN` / `*_SECRET`。
 * 一个只会发 HTTP 的 Python 工具没有任何理由拿到它们——把环境当「默认透明」是最容易漏的一层。
 * 仍然保留 PATH / USERPROFILE / APPDATA / ComSpec 等运行必需项。
 */
export function childEnv(base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === '') continue;
    if (name.startsWith('DSH_')) continue;
    if (!SAFE_ENV_EXCEPTIONS.has(name) && SECRET_ENV_RE.test(name)) continue;
    env[name] = value;
  }
  // bili-cli / xiaoheihe-cli 都是 Python：Windows 控制台默认 GBK 会让它们打印中文 JSON 时崩。
  // PYTHONWARNINGS 压掉证书库那条无害告警（否则它每次都会污染 stderr）。
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  env.PYTHONWARNINGS = 'ignore';
  return env;
}

function isWindowsScript(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(textOf(bin));
}

// npm 生成的 `.cmd` 包装里真正执行的 JS 入口（按 bin 路径缓存，省得每次都读文件）。
const shimScriptCache = new Map();

/**
 * 从 npm 的 `.cmd` 包装里找出它真正要跑的 JS 入口。
 *
 * 为什么值得这么折腾（两个都是实测踩到的）：
 *   ① `opencli xiaohongshu note <带 xsec_token 的链接>` 的链接里有 `&`。cmd.exe 会把 `&`
 *      当命令分隔符，把参数截断在 `&` 处，还让退出码变成 1（实测：前半段照样跑通、退出码却是 1）。
 *   ② `opencli xiaohongshu search "A&B"` 这类搜索词同理，等于把用户输入交给 cmd 解释。
 * 直接 `spawn(node, [入口js, ...argv])` 就完全没有 shell：参数原样送达、退出码真实。
 * 只在「确实是本地 npm 包装、入口 js 就在 bin 同目录的 node_modules 下」时才走这条路，
 * 其余情况一律回退到 cmd.exe（见 spawnTarget）。
 */
function resolveShimScript(bin, exists) {
  const key = textOf(bin);
  if (key === '') return '';
  if (shimScriptCache.has(key)) return shimScriptCache.get(key);
  let script = '';
  try {
    const text = fs.readFileSync(key, 'utf8');
    for (const matched of text.matchAll(/"([^"]*\.[cm]?js)"/g)) {
      const raw = matched[1];
      if (!/%dp0%/i.test(raw)) continue;
      const rel = raw.replace(/^%dp0%[\\/]?/i, '');
      // 只认 bin 同级 node_modules 下的入口：别让一个野路子 .cmd 指定任意绝对路径去执行。
      if (!/^node_modules[\\/]/i.test(rel)) continue;
      const full = path.join(path.dirname(key), rel);
      if (exists(full)) {
        script = full;
        break;
      }
    }
  } catch {
    script = '';
  }
  shimScriptCache.set(key, script);
  return script;
}

/** 这个 bin 会不会真的落到 cmd.exe 上（会的话，含 cmd 元字符的参数必须先拦下）。 */
function usesCmdWrapper(bin, exists) {
  if (!isWindowsScript(bin)) return false;
  return resolveShimScript(bin, exists) === '';
}

/**
 * 决定真正要 spawn 什么。
 *
 * 优先级：npm 包装的 JS 入口（无 shell）→ cmd.exe 数组传参（无 shell 拼串）→ 原生可执行。
 * Node ≥ 20.12（CVE-2024-27980）起，直接 `spawn('x.cmd', args)` 会抛 EINVAL，
 * 所以 `.cmd` 必须有后手；而 `shell: true` 不可取——Node 只是把 argv 用空格连起来，
 * 既带 DeprecationWarning，参数里的 `&` 也照样会被 cmd 解释。
 */
function spawnTarget(bin, argv, exists = fs.existsSync) {
  if (isWindowsScript(bin)) {
    const script = resolveShimScript(bin, exists);
    if (script !== '') return { command: process.execPath, args: [script, ...argv], viaCmd: false };
    return { command: textOf(process.env.ComSpec) || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...argv], viaCmd: true };
  }
  return { command: bin, args: argv, viaCmd: false };
}

function hasCmdUnsafeChars(value) {
  return CMD_UNSAFE_RE.test(textOf(value));
}

/**
 * 走 cmd.exe 时对**整条 argv + bin** 的统一校验：返回错误文案，安全时返回空串。
 *
 * 为什么下沉到这里而不是只在小红书那两处检查：cmd 分支是所有平台的公共出口
 * （`reach.biliBin` 完全可能被配成一个 `.cmd`），只在 xhs 上挡等于只锁了一扇门。
 * 上层仍会先做一次带业务码的校验（bad_query / bad_target），这里是**兜底**。
 *
 * T-028 审查残余：`bin` 本身也要查。它来自本地配置（不是模型输入），但
 * `C:\Program Files (x86)\…` 这种路径里的括号会被 cmd.exe 当成命令分组符——
 * 一旦走到 cmd 分支，参数再干净也执行不了。宁可报一句清楚的错。
 */
export function cmdUnsafeArgvError(argv, bin = '') {
  const binText = textOf(bin);
  if (binText !== '' && hasCmdUnsafeChars(binText)) {
    return `可执行文件路径里有 cmd.exe 会解释的字符（& | < > ^ % " ( ) ! 或换行）：${excerpt(binText, 120)}`;
  }
  const list = Array.isArray(argv) ? argv : [];
  for (const arg of list) {
    const text = textOf(arg);
    if (text === '') continue;
    if (hasCmdUnsafeChars(text)) {
      return `参数里有 cmd.exe 会解释的字符（& | < > ^ % " ( ) ! 或换行）：${excerpt(text, 80)}`;
    }
  }
  return '';
}

/**
 * 跑一次上游 CLI，返回 `{ stdout, stderr, code }`。起不来 / 超时 / 输出超限 → reject。
 * 非 0 退出码**不** reject：上游会把结构化错误打在 stdout 上，那是可解析的信息。
 */
export async function defaultRunCli(bin, argv, { timeoutMs = 120000 } = {}) {
  const timeoutRaw = Number(timeoutMs);
  const timeout = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.trunc(timeoutRaw) : 120000;
  const target = spawnTarget(bin, argv);
  if (target.viaCmd) {
    // 只有真落到 cmd.exe 上才有这层风险（node 入口 / 原生 exe 都是数组传参、零解释）。
    const unsafe = cmdUnsafeArgvError(argv, bin);
    if (unsafe !== '') throw new Error(`拒绝经 cmd.exe 执行：${unsafe}`);
  }
  const { command, args } = target;
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: childEnv(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error(`无法启动 ${path.basename(textOf(bin)) || '上游命令'}：${error?.message ?? error}`));
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const chunks = [];
    let size = 0;
    let stderr = '';
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`${path.basename(textOf(bin)) || '上游命令'} 超时（${timeout}ms）`));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_STDOUT) {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`上游输出超过 ${MAX_STDOUT} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled || stderr.length >= 4000) return;
      stderr += chunk.toString('utf8').slice(0, 4000 - stderr.length);
    });
    child.on('error', (error) => finish(reject, new Error(`无法启动 ${path.basename(textOf(bin)) || '上游命令'}：${error?.message ?? error}`)));
    child.on('close', (code) => finish(resolve, {
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr,
      code: Number.isFinite(code) ? code : -1
    }));
  });
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────
/**
 * 构造三个工具函数：`{ status, search, read }`。
 *
 * 成功返回 `{ ok:true, ..., text }`（text 是给模型直接读的纯文本），
 * 失败返回 `{ ok:false, code, error }`——**永不抛**，方便 MCP 层直接序列化与单测断言。
 *
 * @param {object} [deps]
 * @param {(bin: string, argv: string[], options?: object) => Promise<{stdout:string,stderr:string,code:number}>} [deps.runCli]
 * @param {{ status: Function, search: Function, post: Function }} [deps.heybox] 小黑盒工具箱（单测用桩）
 * @param {() => object} [deps.readConfig]
 * @param {() => number} [deps.now]
 * @param {(p: string) => boolean} [deps.exists] 二进制探测（单测注入，免得测到本机装没装）
 */
export function createReachTools({
  runCli = defaultRunCli,
  heybox = null,
  readConfig = defaultReadConfig,
  now = () => Date.now(),
  exists = fs.existsSync
} = {}) {
  function safeReadConfig() {
    try {
      const raw = readConfig();
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  // 小黑盒的实际调用仍交给 heybox-tools，但 `reach.xiaoheiheBin` / `reach.timeoutMs`
  // 一旦配了就得**真的生效**（R-007）：
  //   · bin：解析成绝对路径后折进 heybox.cliPath，否则会出现「reach_status 说找到了、
  //     搜索却 spawn 另一个裸名字」的两套口径；
  //   · timeout：heybox-tools 自己的默认是 60s，这里用 reach 的 120s 包一层，
  //     仍然是它自己的 spawn（清代理变量那套逻辑不变）。
  const heyboxTools = heybox ?? createHeyboxTools({
    now,
    readConfig: () => {
      const raw = safeReadConfig();
      const reachCfg = normalizeReachConfig(raw.reach);
      const configured = reachCfg.xiaoheiheBin !== '' ? reachCfg.xiaoheiheBin : textOf(raw.heybox?.cliPath);
      const resolved = resolveBinValue(configured, 'xiaoheihe-cli', exists);
      return { ...raw, heybox: { ...(raw.heybox ?? {}), cliPath: resolved } };
    },
    runCli: (argv, options = {}) => {
      const reachCfg = normalizeReachConfig(safeReadConfig().reach);
      return defaultHeyboxRunCli(argv, { ...options, timeoutMs: reachCfg.timeoutMs });
    }
  });

  function currentConfig() {
    return normalizeReachConfig(safeReadConfig().reach);
  }

  function bins(cfg) {
    return resolveBins(cfg, readConfig, exists);
  }

  /**
   * `config.json` 顶层 `bili.enabled`（与 src/mcp-bili-safe.js 同口径：只有显式 false 才算关）。
   *
   * 为什么 reach 要听它：这个开关的语义是「这台机器不要用 B站 能力」。reach 绕开它自己
   * spawn bili，等于把用户明确关掉的东西又打开一次（审查残余 R-010）。
   */
  function biliFeatureDisabled() {
    const raw = safeReadConfig();
    return Boolean(raw?.bili && typeof raw.bili === 'object' && raw.bili.enabled === false);
  }

  function nowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  }

  // ① 状态：只回答「能不能用」，不发平台的业务请求。
  async function status() {
    const cfg = currentConfig();
    const resolved = bins(cfg);
    const platforms = [];

    const biliOn = !biliFeatureDisabled();
    const biliOk = cfg.enabled && biliOn && binAvailable(resolved.bili, exists);
    platforms.push({
      platform: 'bili',
      label: 'B站',
      available: biliOk,
      detail: !biliOn
        ? 'B站功能在 config.json 里被 bili.enabled=false 关掉了：reach 不会调用 bili（其它两个平台不受影响）'
        : (biliOk
          ? `已找到 ${path.basename(resolved.bili)}（bili-cli，只读）`
          : `找不到 ${path.basename(resolved.bili) || 'bili'}（没装 bili-cli，或 reach.biliBin 配错了）`)
    });

    const opencliOk = cfg.enabled && binAvailable(resolved.opencli, exists);
    const opencliLaunch = isWindowsScript(resolved.opencli)
      ? (usesCmdWrapper(resolved.opencli, exists)
        ? '（只能经 cmd.exe 调用，含 & | < > ^ % 的参数会被拒）'
        : '（直接跑它自带的 node 入口，不经过 cmd.exe）')
      : '';
    platforms.push({
      platform: 'xhs',
      label: '小红书',
      available: opencliOk,
      detail: opencliOk
        ? `已找到 ${path.basename(resolved.opencli)}${opencliLaunch}；实际能不能搜到取决于本机 Chrome 里的小红书登录态与站点是否改版（站内搜索失败会自动改问 AI 问答，并标注不是笔记列表；ask 也失败才报 unavailable）`
        : `找不到 ${path.basename(resolved.opencli) || 'opencli'}（没装 opencli，或 reach.opencliBin 配错了）`
    });

    // 小黑盒：不自己探测网卡，只问 heybox-tools 的登录态摘要（它读本地登录态，不刷首页）。
    const heyboxOk = cfg.enabled && binAvailable(resolved.heybox, exists);
    let heyboxDetail = heyboxOk
      ? `已找到 ${path.basename(resolved.heybox)}`
      : `找不到 ${path.basename(resolved.heybox) || 'xiaoheihe-cli'}（没装 xiaoheihe-cli，或 reach.xiaoheiheBin 配错了）`;
    if (heyboxOk) {
      try {
        const summary = await heyboxTools.status();
        if (summary?.ok === false) {
          heyboxDetail = `命令行在，但登录态查不到：${summary.reason ?? summary.code ?? '未知原因'}`;
        } else {
          const user = textOf(summary?.userId).trim();
          heyboxDetail = `${summary?.authenticated === true ? `已登录${user !== '' ? `（用户 id ${user}）` : ''}` : '未登录（搜索可能被拒）'}`;
          if (textOf(summary?.pauseRemainingText) !== '') heyboxDetail += `；验证码暂停中，${summary.pauseRemainingText}后恢复`;
        }
      } catch (error) {
        heyboxDetail = `登录态查不到：${excerpt(error?.message ?? error, 120)}`;
      }
    }
    platforms.push({
      platform: 'heybox',
      label: '小黑盒',
      available: heyboxOk,
      detail: heyboxDetail
    });

    return {
      ok: true,
      enabled: cfg.enabled,
      timeoutMs: cfg.timeoutMs,
      maxResults: cfg.maxResults,
      readMaxChars: READ_MAX_CHARS,
      platforms,
      hint: cfg.enabled
        ? '这三个平台都是只读检索：能搜、能读正文，不能发帖/点赞/关注。搜不到就是搜不到，失败会带 code。'
        : 'reach.enabled=false：三个工具没有注册，改 config.json 的 reach.enabled=true 后重启 MCP 子进程才生效。'
    };
  }

  // ② 搜索
  async function search({ platform, query, limit } = {}) {
    const key = normalizePlatform(platform);
    if (key === '') {
      return {
        ok: false,
        code: 'bad_platform',
        error: `不认识的平台：${textOf(platform) || '（空）'}；可选：${PLATFORM_CHOICES}`
      };
    }
    const cleaned = cleanQuery(query);
    if (cleaned === '') {
      return { ok: false, code: 'bad_query', error: '搜索词不能为空（单行文本，最多 60 字）' };
    }
    // 超长时明确拒绝而不是默默截断：截断后的词和用户想搜的不是一回事，
    // 悄悄变了词会让人以为“平台就这结果”。
    if ([...cleaned].length > QUERY_MAX) {
      return { ok: false, code: 'bad_query', error: `搜索词太长（${[...cleaned].length} 字，上限 ${QUERY_MAX} 字）` };
    }
    const word = normalizeQuery(cleaned);
    const cfg = currentConfig();
    const count = clampLimit(limit, cfg.maxResults);
    try {
      // 三个平台正常都回 `{ mode:'search', items }`；小红书站点侧不可用时可能回
      // `{ mode:'ask_fallback', text, sources, sourceCount }`（T-028）。
      const outcome = key === 'bili'
        ? { mode: 'search', items: await searchBili(cfg, word, count) }
        : key === 'xhs'
          ? await searchXhs(cfg, word, count)
          : { mode: 'search', items: await searchHeybox(cfg, word, count) };
      const items = Array.isArray(outcome.items) ? outcome.items : [];
      const asked = outcome.mode === 'ask_fallback';
      const base = {
        ok: true,
        platform: key,
        label: (key === 'bili' ? 'B站' : key === 'xhs' ? '小红书' : '小黑盒'),
        query: word,
        mode: asked ? 'ask_fallback' : 'search',
        // 降级结果是 AI 汇总，不是笔记列表：count 固定 0，也不给 items（免得被当成列表继续用）。
        count: asked ? 0 : items.length
      };
      if (asked) {
        return {
          ...base,
          sourceCount: Number.isFinite(outcome.sourceCount) ? outcome.sourceCount : 0,
          sources: Array.isArray(outcome.sources) ? outcome.sources : [],
          text: textOf(outcome.text) || formatXhsAsk({})
        };
      }
      return {
        ...base,
        items,
        text: formatSearchResult({ platform: key, query: word, items })
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof ReachError ? error.code : 'unavailable',
        ...(error?.reason ? { reason: error.reason } : {}),
        error: error?.message ?? String(error)
      };
    }
  }

  async function searchBili(cfg, word, count) {
    if (biliFeatureDisabled()) {
      throw new ReachError('unavailable', 'B站功能未启用（config.json 的 bili.enabled=false）：reach 不会调用 bili。要用就先把 bili.enabled 设为 true。');
    }
    const bin = bins(cfg).bili;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', `找不到 bili 可执行文件（reach.biliBin 未配且 PATH 里没有 bili）。装法：uv tool install bilibili-cli`);
    }
    assertCmdArgvSafe(bin, word, 'bad_query');
    // 以 `-` 开头的词会被 CLI 当成选项：把 flags 全放前面，再用 `--` 断选项。
    const args = word.startsWith('-')
      ? ['search', '--type', 'video', '-n', String(count), '--json', '--', word]
      : ['search', word, '--type', 'video', '-n', String(count), '--json'];
    const result = await runCli(bin, args, { timeoutMs: cfg.timeoutMs });
    return parseSearchOutput(result, 'bili 搜索', 'bili', (json) => parseBiliSearch(json, count));
  }

  async function searchXhs(cfg, word, count) {
    const bin = bins(cfg).opencli;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', '找不到 opencli 可执行文件（reach.opencliBin 未配且 PATH 里没有 opencli）。装法：npm i -g @jackwener/opencli');
    }
    // 极少数情况下 .cmd 解析不出 node 入口、只能落到 cmd.exe：这时搜索词里的 cmd 元字符
    // 会被当成命令语法解释——那是注入面，所以直接拒绝（换措辞），而不是硬塞进去。
    assertCmdArgvSafe(bin, word, 'bad_query');

    // dev-doc §3.2：按 n×2 或 ≥8 去要，本地仍按调用方 limit 截断（parseXhsSearch 会 slice）。
    const requestCount = xhsRequestCount(count);
    let searchError = null;
    try {
      const searchArgs = word.startsWith('-')
        ? ['xiaohongshu', 'search', '--limit', String(requestCount), '-f', 'json', '--', word]
        : ['xiaohongshu', 'search', word, '--limit', String(requestCount), '-f', 'json'];
      const result = await runCli(bin, searchArgs, { timeoutMs: cfg.timeoutMs });
      // §7.3 条件 2：data 为空 + message 精确包含 search_input_not_available。
      // 这条独立于 failureOf（成功码 veto 时 failureOf 会是 false），但降级仍要触发；
      // 非空 data 时 helper 直接 false，真结果绝不会被丢掉。
      if (xhsSearchUnavailableByMessage(extractJson(textOf(result?.stdout)))) {
        throw new ReachError('unavailable', '小红书 站内搜索不可用（search_input_not_available）');
      }
      const items = parseSearchOutput(result, '小红书 搜索', 'xhs', (json) => parseXhsSearch(json, count));
      return { mode: 'search', items };
    } catch (error) {
      searchError = error;
    }

    // 失败不是「搜不到」：只有站点侧不可用才值得降级；参数错误（bad_query）在上面就抛了。
    if (!cfg.xhsAskFallback || !fallbackEligible(searchError)) throw searchError;
    const searchReason = textOf(searchError?.message) || '未知原因';
    try {
      // 注意：ask **不接受** --limit（会 commander.unknownOption），所以这里绝不带条数。
      const askArgs = word.startsWith('-')
        ? ['xiaohongshu', 'ask', '-f', 'json', '--', word]
        : ['xiaohongshu', 'ask', word, '-f', 'json'];
      const result = await runCli(bin, askArgs, { timeoutMs: cfg.timeoutMs });
      const json = readCliJson(result, '小红书 AI 问答');
      const ask = parseXhsAsk(json);
      if (ask.answer.trim() === '') {
        throw new ReachError('unavailable', '小红书 AI 问答返回里没有可读的 answer');
      }
      return {
        mode: 'ask_fallback',
        items: [],
        sources: ask.sources,
        sourceCount: ask.sourceCount,
        text: formatXhsAsk(ask)
      };
    } catch (askError) {
      const askReason = textOf(askError?.message) || '未知原因';
      throw new ReachError(
        'unavailable',
        `小红书 搜索失败：${searchReason}；AI 问答也失败：${askReason}`,
        { reason: 'ask_fallback_failed' }
      );
    }
  }

  async function searchHeybox(cfg, word, count) {
    // 小黑盒的 argv 由 heybox-tools 拼（`search <word>`），reach 插不进 `--` 分隔符：
    // 以 `-` 开头的词会被 xiaoheihe-cli 当成选项。这里 fail closed，别把用户输入送进选项位。
    if (word.startsWith('-')) {
      throw new ReachError('bad_query', '小黑盒的搜索词不能以 - 开头（上游会把开头的 - 当成命令选项）；换个说法再搜');
    }
    const bin = bins(cfg).heybox;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', '找不到 xiaoheihe-cli（reach.xiaoheiheBin 与 heybox.cliPath 都没配，PATH 里也没有）。装法：uv tool install xiaoheihe-cli');
    }
    const requestCount = Math.min(Math.max(count, HEYBOX_REQUEST_FLOOR), HEYBOX_REQUEST_MAX);
    let called;
    try {
      called = await heyboxTools.search({ query: word, limit: requestCount });
    } catch (error) {
      throw new ReachError('unavailable', `小黑盒搜索调用失败：${excerpt(error?.message ?? error, 160)}`);
    }
    if (!called || called.ok !== true) {
      // heybox-tools 的 code（captcha / paused / auth / local / protocol…）原样带上，
      // 另外附一句「还剩多久」——模型据此决定是换平台还是等一会儿。
      const code = textOf(called?.code) || 'error';
      const reason = textOf(called?.reason) || '小黑盒没有返回原因';
      const extra = textOf(called?.pauseRemainingText) !== '' ? `；${called.pauseRemainingText}后自动恢复` : '';
      throw new ReachError('unavailable', `小黑盒暂时不可用（${code}）：${reason}${extra}`);
    }
    // `{ok:true}` 但 items 缺失/不是数组：这是上游坏了，不是「没有结果」。
    // 不能 parseHeyboxSearch 静默回空数组——那会把一次坏形状冒充成「平台没这个话题」。
    if (!Array.isArray(called.items)) {
      const raw = excerpt(JSON.stringify(called ?? null), 300);
      throw new ReachError('unavailable', `小黑盒搜索返回了意料之外的形状（unexpected_shape）：${raw}`, { reason: 'unexpected_shape' });
    }
    return parseHeyboxSearch(called, count);
  }

  // ③ 读一条
  async function read({ platform, target } = {}) {
    const key = normalizePlatform(platform);
    if (key === '') {
      return {
        ok: false,
        code: 'bad_platform',
        error: `不认识的平台：${textOf(platform) || '（空）'}；可选：${PLATFORM_CHOICES}`
      };
    }
    const parsed = normalizeTarget(key, target);
    if (!parsed.ok) return { ok: false, code: 'bad_target', error: parsed.error };
    const cfg = currentConfig();
    try {
      const item = key === 'bili'
        ? await readBili(cfg, parsed)
        : key === 'xhs'
          ? await readXhs(cfg, parsed)
          : await readHeybox(cfg, parsed);
      return {
        ok: true,
        platform: key,
        target: textOf(item.target) || parsed.ref,
        item,
        text: formatReadResult({ platform: key, item })
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof ReachError ? error.code : 'unavailable',
        ...(error?.reason ? { reason: error.reason } : {}),
        error: error?.message ?? String(error)
      };
    }
  }

  async function readBili(cfg, parsed) {
    if (biliFeatureDisabled()) {
      throw new ReachError('unavailable', 'B站功能未启用（config.json 的 bili.enabled=false）：reach 不会调用 bili。要用就先把 bili.enabled 设为 true。');
    }
    const bin = bins(cfg).bili;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', '找不到 bili 可执行文件（reach.biliBin 未配且 PATH 里没有 bili）');
    }
    assertCmdArgvSafe(bin, parsed.ref, 'bad_target');
    // 不加 -s/-c：reach_read 要的是标题/作者/数字/简介，字幕和评论留给 bili_video 那个专工具，
    // 这里少一次请求就少一次超时机会。
    const result = await runCli(bin, ['video', parsed.ref, '--json'], { timeoutMs: cfg.timeoutMs });
    const json = readCliJson(result, 'bili 视频详情');
    const item = parseBiliVideo(json);
    if (item.target === '' && parsed.bvid !== '') item.target = parsed.bvid;
    return requireReadable('bili 视频详情', item, json);
  }

  async function readXhs(cfg, parsed) {
    const bin = bins(cfg).opencli;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', '找不到 opencli 可执行文件（reach.opencliBin 未配且 PATH 里没有 opencli）');
    }
    // note 的签名链接里几乎一定带 `&xsec_token=`：只有落到 cmd.exe 时才有被截断的风险，
    // 那条路一律拒绝（宁可报错，也不发一条被截断的请求）。
    assertCmdArgvSafe(bin, parsed.ref, 'bad_target');
    // 链接 / id 已由 normalizeXhsTarget 限制成小红书域名或字母数字，不会有别的花样。
    const result = await runCli(bin, ['xiaohongshu', 'note', parsed.ref, '-f', 'json'], { timeoutMs: cfg.timeoutMs });
    const json = readCliJson(result, '小红书 笔记详情');
    const item = parseXhsNote(json);
    // 上游返回里没带 id 时用调用方给的那个，别在话术里留一个空定位。
    if (textOf(item.target) === '') item.target = parsed.id ?? parsed.ref;
    // 只有图片、没有正文的笔记是合法的：认得出笔记形状就照常返回，让话术说「没有正文可取」。
    return requireReadable('小红书 笔记详情', item, json, { allowEmptyBody: item.recognized === true });
  }

  async function readHeybox(cfg, parsed) {
    const bin = bins(cfg).heybox;
    if (!binAvailable(bin, exists)) {
      throw new ReachError('unavailable', '找不到 xiaoheihe-cli（reach.xiaoheiheBin 与 heybox.cliPath 都没配，PATH 里也没有）');
    }
    let called;
    try {
      // 只要正文与关键数字：回复列表跟正文是**同一次**请求返回的，不必额外再发请求，
      // 也就不会多一次撞验证码的机会。reach_read 的话术只用到正文/作者/条数。
      called = await heyboxTools.post({ linkId: parsed.ref });
    } catch (error) {
      throw new ReachError('unavailable', `小黑盒读帖调用失败：${excerpt(error?.message ?? error, 160)}`);
    }
    if (!called || called.ok !== true) {
      const code = textOf(called?.code) || 'error';
      const reason = textOf(called?.reason) || '小黑盒没有返回原因';
      throw new ReachError('unavailable', `小黑盒暂时不可用（${code}）：${reason}`);
    }
    return requireReadable('小黑盒 帖子', parseHeyboxPost(called), called);
  }

  // ── 上游输出解析（三个平台共用）───────────────────────────────────────────
  /**
   * 「跑起来了、也拿到了 JSON，但这段 JSON 是失败」→ 统一 unavailable。
   *
   * 判据在 reach-core 的 failureOf（`ok:false` / `error` 对象 / 已知失败码），
   * 这里只负责把上游原文拼进 error 里——模型与人都要能看见 `TIMEOUT …` 这类原始文案。
   */
  function readCliJson(result, action) {
    const stdout = textOf(result?.stdout);
    const stderr = textOf(result?.stderr);
    const exitCode = Number.isFinite(result?.code) ? result.code : -1;
    const json = extractJson(stdout);
    if (json === null) {
      const raw = excerpt(stdout) || excerpt(stderr) || '空输出';
      throw new ReachError('unavailable', `${action}没有返回可解析的 JSON（退出码 ${exitCode}）：${raw}`);
    }
    const failure = failureOf(json);
    if (failure.failed) {
      const raw = failure.text || excerpt(stdout);
      throw new ReachError('unavailable', `${action}失败（退出码 ${exitCode}，${failure.code}）：${raw}`);
    }
    return json;
  }

  /** 搜索：失败判据 + 形状判据（`data` 认不出时不能静默变成 0 条）。 */
  function parseSearchOutput(result, action, platform, parse) {
    const json = readCliJson(result, action);
    const items = parse(json);
    if (items.length === 0 && searchShape(platform, json) === '') {
      const raw = excerpt(JSON.stringify(json ?? null), 300);
      throw new ReachError('unavailable', `${action}返回了意料之外的 data 形状（unexpected_shape）：${raw}`, { reason: 'unexpected_shape' });
    }
    return items;
  }

  /**
   * 详情：标题与正文都拿不到时不能一律冒充成功——但「只有图片/视频、没有文字」是**合法**内容。
   *
   * 判据不是「有没有字」，而是「认不认得出这是该平台的详情形状」：
   *   · 小红书：parseXhsNote 认出 note_id/图片数组/用户/互动数等任一项 → 可以空正文；
   *   · B站 / 小黑盒：仍要求标题或正文至少有一个（它们的详情本来就有标题）。
   * 认不出形状才报 unexpected_shape（把坏形状当正文返回 = 假的 ok）。
   */
  function requireReadable(action, item, json, { allowEmptyBody = false } = {}) {
    if (textOf(item?.title) !== '' || textOf(item?.text) !== '') return item;
    if (allowEmptyBody) return item;
    const raw = excerpt(JSON.stringify(json ?? null), 300);
    throw new ReachError('unavailable', `${action}返回里没有可识别的标题/正文（unexpected_shape）：${raw}`, { reason: 'unexpected_shape' });
  }

  /** cmd.exe 兜底路径上的统一拦截：上层已有业务码的检查，这里再挡一次（任何平台）。 */
  function assertCmdArgvSafe(bin, value, code) {
    if (!usesCmdWrapper(bin, exists)) return;
    if (!hasCmdUnsafeChars(value)) return;
    const message = code === 'bad_target'
      ? '这个参数里有命令行会解释的字符（& | < > ^ % " 括号 ! 换行），当前这条调用路径会把它截断；换个写法再试'
      : '搜索词里有命令行特殊字符（& | < > ^ % " 括号 ! 换行），这条调用路径会把它当命令解释，换个说法再搜';
    throw new ReachError(code, message);
  }

  return { status, search, read };
}

// ── MCP 工具注册 ────────────────────────────────────────────────────────────
/**
 * 统一出口：成功时把 `text` 原样给模型（它要读的是话术，不是 JSON）；
 * 失败时给 `{ok:false, code, error}` 的 JSON 并标 isError，宿主才不会当成成功。
 */
function textResult(value) {
  if (value && typeof value === 'object' && value.ok === false) {
    return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: true };
  }
  const text = typeof value === 'string' ? value : (textOf(value?.text) || JSON.stringify(value ?? null));
  return { content: [{ type: 'text', text }] };
}

/**
 * 把 reach_status / reach_search / reach_read 注册到传入的 MCP server 上。
 *
 * 为什么挂在 snowluma 这个已有 server 上：DSH 的 MCP server 清单在启动时就固定了，
 * 新增独立 server 必须重启 DSH 才生效（与 heybox / device 同一套理由）。
 * 启用开关在 config.json 的 `reach.enabled`，入口（src/mcp-snowluma-safe.js）负责判断。
 */
export function registerReachTools(server, opts = {}) {
  const tools = createReachTools(opts);

  server.tool(
    'reach_status',
    '查三个只读检索渠道（B站 / 小红书 / 小黑盒）各自能不能用：二进制在不在、小黑盒登录态怎么样。不发业务请求、不消耗额度，先查它再决定搜哪个平台。',
    {},
    async () => textResult(await tools.status())
  );

  server.tool(
    'reach_search',
    '在三个平台之一搜索（只读，不点赞不发帖）：platform=bili（B站视频）/ xhs（小红书笔记）/ heybox（小黑盒帖子），query 是关键词（单行，≤60 字），limit 是条数（1–20，默认 8）。返回一段纯文本：标题、作者、播放/赞/评论等数字和定位信息。小红书站内搜索不可用时会自动改问小红书的 AI 问答（返回 mode=ask_fallback，正文开头有「这是 AI 汇总、不是笔记列表」的标注，并附来源链接）；这不是搜索失败，但也不是笔记列表。失败会带 code（bad_platform / bad_query / unavailable）和上游原始原因——不要把它当成“搜不到”。',
    {
      platform: z.string().describe(`平台：${PLATFORM_CHOICES}`),
      query: z.string().describe('搜索关键词，单行，最多 60 字'),
      limit: z.number().optional().describe(`返回几条（1–20），默认 ${LIMIT_DEFAULT}`)
    },
    async ({ platform, query, limit }) => textResult(await tools.search({ platform, query, limit }))
  );

  server.tool(
    'reach_read',
    '读三个平台其中一条的正文（只读）：platform=bili 传 BV 号或 bilibili.com 链接；xhs 传完整笔记链接（带 xsec_token 的那种；只给裸 id 上游可能拒绝）；heybox 传 reach_search 结果里 `小黑盒 id：` 那一行的数字。返回标题/作者/关键数字/正文（B站 与小红书最多 4000 字，小黑盒上游只给 2000 字，超长会标注）。',
    {
      platform: z.string().describe(`平台：${PLATFORM_CHOICES}`),
      target: z.string().describe('B站：BV 号或视频链接；小红书：完整笔记链接（带 xsec_token）优先，其次 note id；小黑盒：`小黑盒 id：` 那一行的数字')
    },
    async ({ platform, target }) => textResult(await tools.read({ platform, target }))
  );
}
