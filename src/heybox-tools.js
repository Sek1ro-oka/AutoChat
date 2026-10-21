// 小黑盒「看帖 / 回一句」的工具实现：工具逻辑全部在这里，入口只负责把工具注册到 server 上。
//
// 定位：让 agent 能看小黑盒首页、帖子正文和搜索结果，并在**用户真的想回一句**时留一条评论。
// 签名与登录态交给本机的 xiaoheihe-cli（Python），这里只做四件事：
//   ① 把 CLI 的 `-f json` 结果瘦身成模型能读的小对象（正文里的 HTML 也在这里转纯文本）；
//   ② 评论前跑四道闸门：开关 → 内容审计 → 额度/间隔 → 重复；
//   ③ 把「今天发了几条 / 有没有被暂停」落盘到 state/heybox-usage.json；
//   ④ 每次**真发**都往 state/heybox-actions.jsonl 追加一行（成功与失败都记），
//      真发成功后还会 `post get` 回读一次，确认评论真的出现在列表里（verified）。
//
// 安全设计：
// - **出厂不发评论**：config.json 顶层 `heybox` 段里的 allowComment 默认 false、
//   dryRunDefault 默认 true；两个默认值叠加后，这个 server 开箱只能读，评论一律走演练。
// - **不走 shell**：child_process.spawn(bin, argv) 直接传数组，不经过 cmd.exe。
// - **spawn 前清代理**：本机 NO_PROXY 里的 `[::1]` 会让 CLI 内的 httpx 0.28 崩
//   （httpx.InvalidURL: Invalid port: ':1]'）。所以每次调用都复制一份 process.env，
//   删掉所有匹配 /proxy/i 的键，再把 NO_PROXY 显式设成 `localhost,127.0.0.1`。
// - **stdout 只留给 MCP 协议**：本文件不 console.log；日志只走 console.error 且 ≤200 字。
// - **CLI 不可用也要能解释**：status 在 CLI 挂了时仍然返回本地额度信息 + 中文原因。
//
// 可测试性：全部工具逻辑在 createHeyboxTools() 里，runCli / readConfig / now / stateDir
// 都可以注入。scripts/test-heybox-tools.mjs 用假 CLI + 临时 state 目录跑，不会真发评论。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  HEYBOX_DEFAULTS,
  normalizeHeyboxConfig,
  heyboxQuota,
  auditComment,
  nearDuplicate,
  createHeyboxState,
  recordAction,
  parseUsage,
  serializeUsage,
  describeCliError,
  commentReasonText,
  commentModeOf,
  captchaPauseDeadline,
  formatPauseRemaining,
} from './heybox-core.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

/** 默认 state 目录：仓库根的 state/（与 snowluma / qzone 的落盘位置保持一致）。 */
export const DEFAULT_STATE_DIR = path.join(ROOT, 'state');
const USAGE_FILENAME = 'heybox-usage.json';
const ACTIONS_FILENAME = 'heybox-actions.jsonl';

// 超时按动作分：feed/post/search 一次 60 秒足够；发评论要建请求 + 签名，给 90 秒。
const READ_TIMEOUT_MS = 60 * 1000;
const WRITE_TIMEOUT_MS = 90 * 1000;
// feed 单次约 100KB、post 约 50KB；64MB 是「绝不被输出撑爆」的硬上限，不是预期值。
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

const MINUTE_MS = 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * MINUTE_MS;

// ── 日志 ────────────────────────────────────────────────────────────────────
// stdout 是 MCP 协议流，一个字都不能往里写；stderr 可以，但限长，避免把 CLI 的原始
// 报错整段倒进宿主日志。
function logWarn(message) {
  const line = `[heybox-safe] ${String(message ?? '').replace(/\s+/g, ' ').trim()}`;
  if (line.length <= 14) return;
  console.error(line.length > 200 ? `${line.slice(0, 199)}…` : line);
}

// ── 配置 ────────────────────────────────────────────────────────────────────
/**
 * 每次调用都重读仓库根的 config.json（与 mcp-snowluma-safe.js 的 loadConfig 同款）：
 * 用户改开关后不需要重启 MCP server。读不到 / 坏 JSON 一律当空对象（全默认值）。
 */
export function defaultReadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── CLI 调用 ────────────────────────────────────────────────────────────────
const PROXY_KEY_RE = /proxy/i;

/**
 * 子进程环境：复制一份 env，**删掉所有 /proxy/i 的键**，最后再设 NO_PROXY。
 *
 * 顺序不能反：`NO_PROXY` 自己也匹配 /proxy/i，先设会被后面的删除循环清掉。
 * 另外把 Python 的 IO 编码钉成 UTF-8 —— Windows 控制台默认 GBK，CLI 打印中文 JSON
 * 时会乱码甚至抛 UnicodeEncodeError，那是环境问题，不该让模型看见。
 */
export function buildCliEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (PROXY_KEY_RE.test(key)) delete env[key];
  }
  env.NO_PROXY = 'localhost,127.0.0.1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

/**
 * 跑一次 `xiaoheihe-cli`，返回 `{ stdout, stderr, code }`。
 *
 * 失败（起不来 / 超时 / 输出超限）用 reject 表达，让上层区分「没跑起来（local）」和
 * 「跑起来了但平台拒绝（auth/captcha/rate_limit/…）」。非 0 退出码**不** reject：
 * CLI 的 `-f json` 失败时也会把结构化错误打在 stdout 上，那是可解析的信息。
 */
export async function defaultRunCli(argv, options = {}) {
  const bin = String(options.cliPath ?? '').trim() || HEYBOX_DEFAULTS.cliPath;
  const timeoutRaw = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.trunc(timeoutRaw) : READ_TIMEOUT_MS;

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        env: buildCliEnv(),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new Error(`无法启动 ${bin}：${error?.message ?? error}`));
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
      finish(reject, new Error(`${bin} 超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`${bin} 输出超过 ${MAX_STDOUT_BYTES} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (settled || stderr.length >= 4000) return;
      stderr += chunk.toString('utf8').slice(0, 4000 - stderr.length);
    });
    child.on('error', (error) => finish(reject, new Error(`无法启动 ${bin}：${error?.message ?? error}`)));
    child.on('close', (code) => {
      finish(resolve, {
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr,
        code: Number.isFinite(code) ? code : -1,
      });
    });
  });
}

// ── 小工具（纯函数）─────────────────────────────────────────────────────────
function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function intOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 按码点截断：超长时补一个 `…`，保证「≤N 字」是硬上限（不是 N+1）。 */
function truncateText(value, max) {
  const chars = [...textOf(value)];
  if (chars.length <= max) return chars.join('');
  if (max <= 0) return '';
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** 先压成单行再截断：列表里的摘要一旦带换行，JSON 会很难读。 */
function squashText(value, max) {
  return truncateText(textOf(value).replace(/\s+/g, ' ').trim(), max);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/** 去 HTML 标签：`<br>` / 段落收尾转折行，其余标签直接删，实体解码。 */
function stripHtml(value) {
  const body = textOf(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(body)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 帖子正文转纯文本。
 *
 * 实测 `post get` 的 `link.text` 有两种形态：空字符串（纯外链帖），以及
 * `[{"text":"<p>…</p>"}]` 这种「富文本块数组」的 JSON 字符串（块里的 text 是 HTML）。
 * 两种都要能读，所以先试 JSON，再退回「整段当 HTML 处理」。
 */
function richTextToPlain(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const source = raw.trim();
  if (source.startsWith('[') || source.startsWith('{')) {
    try {
      const blocks = JSON.parse(source);
      const lines = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.text === 'string' && node.text.trim() !== '') lines.push(stripHtml(node.text));
        for (const key of ['content', 'children']) {
          if (Array.isArray(node[key])) node[key].forEach(walk);
        }
      };
      if (Array.isArray(blocks)) blocks.forEach(walk);
      else walk(blocks);
      const joined = lines.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (joined !== '') return joined;
    } catch {
      // 不是合法 JSON：当普通 HTML 走下面的兜底
    }
  }
  return stripHtml(source);
}

/**
 * 时间戳 → 北京时间 `YYYY-MM-DD HH:mm`。
 *
 * 小黑盒的 `create_at` 是**秒**级 unix 时间戳（10 位）；11 位以上按毫秒处理。
 * 不用 toLocaleString —— 那依赖 ICU 与进程时区，测试会随机器漂。
 */
function formatCreateAt(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'object') return formatCreateAt(value.$date ?? value.value ?? '');
  const raw = textOf(value).trim();
  const numeric = typeof value === 'number' ? value : (/^\d{10,13}$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isFinite(numeric)) return raw;
  const ms = numeric < 1e12 ? numeric * 1000 : numeric;
  const date = new Date(ms + BEIJING_OFFSET_MS);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function authorOf(value) {
  if (!value || typeof value !== 'object') return '';
  const user = value.user;
  if (typeof user === 'string') return user.trim();
  if (user && typeof user === 'object') {
    const name = textOf(user.username ?? user.name ?? user.nickname).trim();
    if (name !== '') return name;
  }
  return textOf(value.username ?? value.nickname ?? value.user_name).trim();
}

function imageUrlOf(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  for (const key of ['url', 'src', 'thumb', 'image', 'original']) {
    if (typeof value[key] === 'string' && value[key].trim() !== '') return value[key].trim();
  }
  return '';
}

/** 图片列表：imgs / images / thumbs 依次合并去重；都没有就退回 thumb/original 单图。 */
function imagesOf(item, max) {
  const found = [];
  for (const key of ['imgs', 'images', 'thumbs']) {
    const list = item?.[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const url = imageUrlOf(entry);
      if (url !== '') found.push(url);
    }
  }
  if (found.length === 0) {
    const single = imageUrlOf(item?.thumb) || imageUrlOf(item?.original);
    if (single !== '') found.push(single);
  }
  return [...new Set(found)].slice(0, max);
}

function topicsOf(item, max) {
  const list = Array.isArray(item?.topics) ? item.topics : [];
  const names = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry.trim() : textOf(entry?.name).trim();
    if (name !== '' && !names.includes(name)) names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

/** 数字 id 落地成 Number（能精确表示时），否则保留原字符串，避免大 id 被浮点吃掉。 */
function idFromDigits(digits) {
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : digits;
}

/**
 * 取链接 id。feed/搜素里的 `linkid` 是数字；search 的 `report_id` 是 base64 游标
 * （不是 id），只在没有 linkid 时才兜底，而且必须全是数字才认。
 */
function linkIdOf(value) {
  if (!value || typeof value !== 'object') return '';
  const raw = value.linkid ?? value.link_id ?? value.linkId ?? value.id ?? value.report_id;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw);
  const text = textOf(raw).trim();
  if (!/^\d+$/.test(text)) return '';
  return idFromDigits(text);
}

/** 参数里的 linkId：只接受纯数字（模型偶尔会把数字传成字符串）。 */
function normalizeLinkId(value) {
  const text = textOf(value).trim();
  return /^\d{1,20}$/.test(text) ? text : '';
}

// ── CLI 结果整形 ────────────────────────────────────────────────────────────
/** 假 runCli 可能只回字符串；统一成 `{ stdout, stderr, code }`。 */
function normalizeCliResult(value) {
  if (typeof value === 'string') return { stdout: value, stderr: '', code: 0 };
  const source = value && typeof value === 'object' ? value : {};
  const codeRaw = Number(source.code ?? source.exitCode ?? 0);
  return {
    stdout: textOf(source.stdout ?? source.output),
    stderr: textOf(source.stderr ?? (typeof source.error === 'string' ? source.error : '')),
    code: Number.isFinite(codeRaw) ? Math.trunc(codeRaw) : 0,
  };
}

/** CLI 偶尔会在 JSON 前打日志；从第一个 `{` 起解析，失败再从末尾 `}` 截一次。 */
function parseJsonLoose(text) {
  const raw = textOf(text).trim();
  if (raw === '') return null;
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const body = raw.slice(start);
  try { return JSON.parse(body); } catch {}
  const end = body.lastIndexOf('}');
  if (end > 0) {
    try { return JSON.parse(body.slice(0, end + 1)); } catch {}
  }
  return null;
}

/** 非 0 退出码的失败：优先用 stdout 上的结构化错误，其次按 stderr 文本关键词认。 */
function describeFailure(result) {
  const parsed = parseJsonLoose(result.stdout);
  if (parsed && typeof parsed === 'object') return describeCliError(parsed);
  const text = [textOf(result.stdout).trim(), textOf(result.stderr).trim()].filter(Boolean).join('\n');
  return describeCliError(text);
}

// ── 审计 / 评论文案 ─────────────────────────────────────────────────────────
const AUDIT_TEXTS = Object.freeze({
  empty: '评论是空的',
  too_short: '太短了：至少 5 个字，别只发「好」「牛」',
  too_long: '太长了：超过字数上限',
  multiline: '评论里不要换行，平台会把换行吞成空格',
  meaningless: '只有表情或标点，写点实际内容',
  repetitive: '同一个字重复太多了，像灌水',
  unsafe: '内容里有链接 / 手机号 / 联系方式这类不该出现的东西',
});

function auditReasonText(reason, cfg) {
  if (reason === 'too_long') {
    const cap = Number(cfg?.postMaxChars);
    if (Number.isFinite(cap) && cap > 0) return `太长了：上限 ${Math.trunc(cap)} 字`;
  }
  return AUDIT_TEXTS[reason] ?? '这条评论没通过内容审计';
}

// ── 结果整形（纯函数）───────────────────────────────────────────────────────
function slimFeedItem(item) {
  return {
    linkId: linkIdOf(item),
    title: squashText(stripHtml(item?.title), 120),
    summary: squashText(stripHtml(item?.description), 120),
    author: authorOf(item),
    commentCount: intOf(item?.comment_num),
    awardCount: intOf(item?.link_award_num),
    images: imagesOf(item, 3),
    topics: topicsOf(item, 5),
  };
}

function slimSearchItem(entry) {
  const info = entry?.info && typeof entry.info === 'object' ? entry.info : (entry ?? {});
  return {
    linkId: linkIdOf(info) || linkIdOf(entry),
    title: squashText(stripHtml(info.title), 120),
    summary: squashText(stripHtml(info.description), 120),
    author: authorOf(info) || authorOf(entry),
    commentCount: intOf(info.comment_num),
  };
}

/** `post get` 的每条评论形如 `{comment:[{…}]}`（实测），也兼容 `{comment:{…}}` / 平铺。 */
function commentPayload(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.comment ?? entry;
  if (Array.isArray(raw)) return raw[0] && typeof raw[0] === 'object' ? raw[0] : null;
  return typeof raw === 'object' ? raw : null;
}

/** 纯数字 id → 数字串（不是纯数字就回空串）。评论 id 一律按字符串落地，避免大 id 被浮点吃掉。 */
function digitsOf(value) {
  const text = textOf(value).trim();
  return /^\d{1,20}$/.test(text) ? text : '';
}

/** 评论 id：平台写 `commentid`，个别版本写 `comment_id`；统一成数字串，取不到回空串。 */
function commentIdOf(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return digitsOf(payload.commentid ?? payload.comment_id);
}

/**
 * 从 `comment create` 的返回值里挖评论 id。
 *
 * 为什么只认这些键：`data.id` 之类含义不明的键绝对不能猜 —— 万一那是帖子 id，
 * 写进 actions 的 `messageId` 就是一条错账，比空着更坏。挖不到就回空串，
 * 交给 `post get` 回读兜底（回读也是唯一能确认「这条评论真在线」的路径）。
 */
function commentIdFromCli(json) {
  const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : {};
  const nested = data.comment && typeof data.comment === 'object' ? data.comment : {};
  const wrapped = data.result && typeof data.result === 'object' ? data.result : {};
  const candidates = [
    data.commentid, data.comment_id, data.commentId,
    nested.commentid, nested.comment_id, nested.commentId,
    wrapped.commentid, wrapped.comment_id, wrapped.commentId,
  ];
  for (const value of candidates) {
    const id = digitsOf(value);
    if (id !== '') return id;
  }
  return '';
}

function slimPostComment(entry) {
  const payload = commentPayload(entry);
  if (!payload) return null;
  const text = squashText(payload.text ?? payload.content, 300);
  if (text === '') return null;
  return {
    user: authorOf(payload),
    text,
    // 平台字段就叫 `up`（点赞数），不是「作者本人」那种布尔。
    likes: intOf(payload.up ?? payload.like_num ?? payload.likes),
    childCount: intOf(payload.child_num),
    commentId: commentIdOf(payload),
  };
}

// ── 工具工厂 ────────────────────────────────────────────────────────────────
/**
 * 构造五个工具函数。返回值每个都是 `{ ok, ... }` 的**朴素对象**（永不抛），
 * 方便 MCP 层直接 JSON 序列化，也方便单测逐字段断言。
 *
 * @param {object} [deps]
 * @param {(argv: string[], options?: object) => Promise<{stdout:string,stderr:string,code:number}>} [deps.runCli]
 * @param {() => object} [deps.readConfig]
 * @param {() => number} [deps.now] 毫秒时间戳；单测注入假时钟
 * @param {string} [deps.stateDir] usage / actions 的落盘目录
 */
export function createHeyboxTools({
  runCli = defaultRunCli,
  readConfig = defaultReadConfig,
  now = () => Date.now(),
  stateDir = DEFAULT_STATE_DIR,
} = {}) {
  const usageFile = path.join(stateDir, USAGE_FILENAME);
  const actionsFile = path.join(stateDir, ACTIONS_FILENAME);

  function currentConfig() {
    let raw;
    try { raw = readConfig(); } catch { raw = {}; }
    // 顶层 `heybox` 段（不是 socialV2.heybox）—— 见 work/agent-tasks/T-022/dev-doc.md。
    return normalizeHeyboxConfig(raw?.heybox);
  }

  function nowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  }

  function readUsage() {
    try {
      return parseUsage(fs.readFileSync(usageFile, 'utf8'));
    } catch {
      return createHeyboxState(nowMs());
    }
  }

  function writeUsage(state) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(usageFile, serializeUsage(state), 'utf8');
      return true;
    } catch (error) {
      logWarn(`写 ${USAGE_FILENAME} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  function appendAction(record) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(actionsFile, `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (error) {
      logWarn(`追加 ${ACTIONS_FILENAME} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 最近 N 条**真发成功**的评论文本（dry-run 与失败行不算）。
   * 只比「最近 5 条」是调用方的口径，nearDuplicate 自己不截断。
   */
  function recentSentTexts(limit = 5) {
    let raw = '';
    try { raw = fs.readFileSync(actionsFile, 'utf8'); } catch { return []; }
    const texts = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let record;
      try { record = JSON.parse(trimmed); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      if (record.dryRun !== false || record.ok === false) continue;
      if (typeof record.text !== 'string' || record.text.trim() === '') continue;
      texts.push(record.text);
    }
    return texts.slice(-limit);
  }

  /**
   * 调 CLI 并把结果收敛成 `{ ok:true, json }` 或 `{ ok:false, code, reason }`。
   * 只有「没跑起来」才回 `local`；平台拒绝一律走 describeCliError 的中文码。
   */
  async function invoke(cfg, argv, timeoutMs) {
    let raw;
    try {
      raw = await runCli(argv, { timeoutMs, cliPath: cfg.cliPath });
    } catch (error) {
      const message = textOf(error?.message ?? error).slice(0, 180);
      logWarn(`CLI 调用失败：${message}`);
      return { ok: false, code: 'local', reason: `小黑盒命令行调用失败：${message}` };
    }
    const result = normalizeCliResult(raw);
    if (result.code !== 0) {
      const info = describeFailure(result);
      return { ok: false, code: info.code, reason: info.text };
    }
    const json = parseJsonLoose(result.stdout);
    if (!json || typeof json !== 'object') {
      logWarn(`CLI 输出不是 JSON（${String(result.stdout).slice(0, 80)}）`);
      return { ok: false, code: 'protocol', reason: '小黑盒命令行返回的不是可解析的 JSON' };
    }
    if (json.ok === false) {
      const info = describeCliError(json);
      return { ok: false, code: info.code, reason: info.text };
    }
    return { ok: true, json };
  }

  function disabledResult(cfg) {
    return { ok: false, code: 'disabled', reason: commentReasonText('disabled', { dailyComments: cfg.dailyComments }) };
  }

  /** 自己的 user_id（回读校验用）。auth status 失败就返回空串，让调用方降级。 */
  async function selfUserId(cfg) {
    const called = await invoke(cfg, ['-f', 'json', 'auth', 'status'], READ_TIMEOUT_MS);
    if (!called.ok) return '';
    return textOf(called.json?.data?.user_id).trim();
  }

  /**
   * 真发的回读校验：再拉一次 post get，在 `comments[].comment[]` 里找
   * 「text 完全一致 + 作者是自己 user_id」的那条。
   *
   * 找不到只代表「没验证到」，不代表没发出去 —— 平台审核、分页、风控都会让回读落空。
   * 所以这里只回 verified，由调用方决定怎么如实告诉模型。
   *
   * 命中时把那条评论的 `commentId` 也带出来：这是唯一能把「刚发的评论」和
   * 「actions 里的 messageId」对上号的来源（CLI 的 create 返回值不一定带 id）。
   */
  async function verifySent(cfg, id, body) {
    const userId = await selfUserId(cfg);
    if (userId === '') return { verified: false, detail: '拿不到自己的 user_id' };
    const called = await invoke(cfg, ['-f', 'json', 'post', 'get', id], READ_TIMEOUT_MS);
    if (!called.ok) return { verified: false, detail: called.reason };
    const rawComments = Array.isArray(called.json?.data?.result?.comments) ? called.json.data.result.comments : [];
    let matchedId = '';
    const found = rawComments.some((entry) => {
      const payload = commentPayload(entry);
      if (!payload) return false;
      const authorId = textOf(payload.userid ?? payload.user?.userid).trim();
      if (authorId !== userId || textOf(payload.text).trim() !== body) return false;
      matchedId = commentIdOf(payload);
      return true;
    });
    return found ? { verified: true, commentId: matchedId } : { verified: false };
  }

  /**
   * 记一次验证码暂停：`pausedUntil = at + captchaPauseMs`，并把结果写给调用方。
   *
   * 四个 CLI 入口（feed / post / search / comment）共用这一个 30 分钟窗口
   * （都读 `heybox-usage.json` 的 pausedUntil）：被要过一次验证码之后继续请求，
   * 只会延长风控；而各写各的窗口等于各停各的，用户看到「评论不能发但还能看帖」
   * 会以为是 bug。**读请求同样会撞验证码**（本机实测过 `post get` 被要验证码），
   * 所以暂停期内连看帖/刷首页也一并停手。
   */
  function applyCaptchaPause(cfg, state, at) {
    const pausedUntil = captchaPauseDeadline(at, cfg);
    const tracked = writeUsage({ ...state, pausedUntil, pausedReason: 'captcha' });
    const remaining = formatPauseRemaining(pausedUntil, at);
    const out = {
      pausedUntil,
      tracked,
      remaining,
      hint: `暂停期间所有小黑盒请求（看帖 / 搜索 / 评论）都不再发出；${remaining}后自动恢复`,
    };
    if (!tracked) out.warn = '暂停状态没写进 heybox-usage.json，重启后可能忘记暂停';
    return out;
  }

  /**
   * 四个入口撞到验证码时的统一出口：置暂停窗口 + 回一条带「还剩多久」的拒绝。
   * 收在一处是为了「暂停窗口只有一份账」——散着写迟早有一路忘记落盘。
   *
   * @param {object} state 调用方手里最新的 usage（search/feed/post 传 readUsage()）
   */
  function captchaBlocked(cfg, at, called, state) {
    const paused = applyCaptchaPause(cfg, state, at);
    const out = {
      ok: false,
      code: 'captcha',
      reason: called.reason,
      pausedUntil: paused.pausedUntil,
      pausedReason: 'captcha',
      pauseRemainingText: paused.remaining,
      hint: paused.hint,
    };
    if (paused.warn) out.warn = paused.warn;
    return out;
  }

  /**
   * 暂停闸门：暂停期内直接拒绝，不调 CLI（feed / post / search 共用）。
   * 返回 null 表示没在暂停、可以继续。
   */
  function pauseBlocker(cfg, at) {
    const state = readUsage();
    if (!(state.pausedUntil > at)) return null;
    return {
      ok: false,
      code: 'paused',
      reason: commentReasonText('paused', { pausedUntil: state.pausedUntil, pausedRemainingMs: Math.max(0, state.pausedUntil - at) }),
      pausedUntil: state.pausedUntil,
      pausedReason: state.pausedReason || 'captcha',
      pauseRemainingText: formatPauseRemaining(state.pausedUntil, at),
    };
  }

  // ① 状态
  async function status() {
    const cfg = currentConfig();
    const at = nowMs();
    const state = readUsage();
    const quota = heyboxQuota(state, cfg, at);
    const mode = commentModeOf(cfg);
    const called = await invoke(cfg, ['-f', 'json', 'auth', 'status'], READ_TIMEOUT_MS);
    const data = called.ok && called.json?.data && typeof called.json.data === 'object' ? called.json.data : {};
    const authenticated = data.authenticated === true;
    const result = {
      ok: called.ok === true,
      enabled: cfg.enabled,
      allowComment: cfg.allowComment,
      authenticated,
      userId: textOf(data.user_id).trim(),
      usedToday: quota.usedToday,
      dailyComments: quota.dailyComments,
      remaining: quota.remaining,
      // 能不能「真发」是四件事与：功能开着、评论开关开着、额度够、登录有效。
      canComment: Boolean(cfg.enabled) && Boolean(cfg.allowComment) && quota.ok && authenticated,
      quotaReason: quota.reason,
      nextAllowedAt: quota.nextAllowedAt,
      pausedUntil: state.pausedUntil,
      pausedReason: state.pausedReason,
      dryRunDefault: cfg.dryRunDefault,
      // 两个布尔值的「当前生效含义」：模型直接读这句就能回答「你现在能发评论吗」，
      // 不用自己把 allowComment / dryRunDefault 组合一遍（组合错就是两个字段自相矛盾）。
      commentMode: mode.mode,
      commentModeText: mode.text,
      // 暂停窗口多长、还剩多久：只在真在暂停里才给剩余时长，避免平时也冒出「还剩 0 分钟」。
      captchaPauseMs: cfg.captchaPauseMs,
    };
    const pauseText = formatPauseRemaining(state.pausedUntil, at);
    if (pauseText !== '') result.pauseRemainingText = pauseText;
    if (!called.ok) {
      result.code = called.code;
      result.reason = called.reason;
    }
    return result;
  }

  // ② 首页
  async function feed({ limit } = {}) {
    const cfg = currentConfig();
    const at = nowMs();
    if (!cfg.enabled) return disabledResult(cfg);
    // 与搜索/评论共用暂停窗口：首页也是小黑盒的读接口，风控窗口内先别动。
    const blocked = pauseBlocker(cfg, at);
    if (blocked) return blocked;
    const count = clampInt(limit, 8, 1, 20);
    const called = await invoke(cfg, ['-f', 'json', 'feed'], READ_TIMEOUT_MS);
    if (!called.ok) {
      if (called.code === 'captcha') return captchaBlocked(cfg, at, called, readUsage());
      return called;
    }
    const links = called.json?.data?.result?.links;
    if (!Array.isArray(links)) {
      logWarn('feed 返回里没有 data.result.links');
      return { ok: true, count: 0, items: [] };
    }
    // CLI 一次固定给 10 条，`--limit` 不生效 —— 截取只能在这里做（所以 11–20 也只到 10）。
    const items = links.slice(0, count).map(slimFeedItem);
    return { ok: true, count: items.length, items };
  }

  // ③ 帖子
  async function post({ linkId, comments } = {}) {
    const cfg = currentConfig();
    const at = nowMs();
    if (!cfg.enabled) return disabledResult(cfg);
    const id = normalizeLinkId(linkId);
    if (id === '') return { ok: false, code: 'input', reason: 'linkId 必须是数字（用 heybox_feed / heybox_search 返回的 linkId）' };
    // 读帖子同样吃风控（实测 `post get` 也会被要验证码），所以暂停期内先不读。
    const blocked = pauseBlocker(cfg, at);
    if (blocked) return blocked;
    const wantComments = clampInt(comments, 8, 0, 20);
    const called = await invoke(cfg, ['-f', 'json', 'post', 'get', id], READ_TIMEOUT_MS);
    if (!called.ok) {
      if (called.code === 'captcha') return captchaBlocked(cfg, at, called, readUsage());
      return called;
    }
    const result = called.json?.data?.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'protocol', reason: '小黑盒没有返回这条帖子的内容' };
    }
    const link = result.link && typeof result.link === 'object' ? result.link : {};
    const rawComments = Array.isArray(result.comments) ? result.comments : [];
    const list = wantComments === 0
      ? []
      : rawComments.map(slimPostComment).filter(Boolean).slice(0, wantComments);
    return {
      ok: true,
      linkId: linkIdOf(link) || idFromDigits(id),
      title: squashText(stripHtml(link.title), 120),
      // 正文保留换行（长文分段是内容的一部分），只做 HTML → 纯文本 + 2000 字上限。
      text: truncateText(richTextToPlain(link.text ?? link.description ?? ''), 2000),
      author: authorOf(link),
      createAt: formatCreateAt(link.create_at),
      commentCount: intOf(link.comment_num ?? result.total_floor_num),
      images: imagesOf(link, 5),
      comments: list,
    };
  }

  // ④ 搜索
  async function search({ query, limit } = {}) {
    const cfg = currentConfig();
    const at = nowMs();
    if (!cfg.enabled) return disabledResult(cfg);
    // 暂停窗口与评论共用：被要过一次验证码之后继续搜索，只会把风控窗口拉得更长。
    const blocked = pauseBlocker(cfg, at);
    if (blocked) return blocked;
    const rawQuery = textOf(query);
    if (/[\r\n]/.test(rawQuery)) return { ok: false, code: 'input', reason: '搜索词不能包含换行' };
    const word = rawQuery.replace(/\s+/g, ' ').trim();
    if (word === '') return { ok: false, code: 'input', reason: '搜索词不能为空' };
    if ([...word].length > 60) return { ok: false, code: 'input', reason: '搜索词太长（上限 60 字）' };
    const count = clampInt(limit, 5, 1, 10);
    const called = await invoke(
      cfg,
      ['-f', 'json', 'search', word, '--type', 'post', '--limit', String(count)],
      READ_TIMEOUT_MS,
    );
    if (!called.ok) {
      // 搜索撞到验证码：置同一个暂停窗口。不重试、不换个搜索词绕 —— 风控看的是行为量。
      if (called.code === 'captcha') return captchaBlocked(cfg, at, called, readUsage());
      return called;
    }
    const items = called.json?.data?.result?.items;
    const list = (Array.isArray(items) ? items : [])
      .map(slimSearchItem)
      .filter((item) => item.title !== '' || item.linkId !== '')
      .slice(0, count);
    return { ok: true, query: word, count: list.length, items: list };
  }

  // ⑤ 评论
  async function comment({ linkId, text, dryRun } = {}) {
    const cfg = currentConfig();
    const at = nowMs();

    // ① 总开关
    if (!cfg.enabled) return disabledResult(cfg);
    // ② 评论开关（出厂 false：只读能力先上线，评论必须显式打开）
    if (!cfg.allowComment) {
      return { ok: false, code: 'comment_disabled', reason: commentReasonText('comment_disabled', {}) };
    }
    const id = normalizeLinkId(linkId);
    if (id === '') return { ok: false, code: 'input', reason: 'linkId 必须是数字（用 heybox_feed / heybox_search 返回的 linkId）' };
    const body = textOf(text).trim();

    // ③ 内容审计（比额度更早，因为「内容不合格」是用户自己能立刻改的）
    const audit = auditComment(body, cfg);
    if (!audit.ok) {
      return {
        ok: false,
        code: 'audit',
        reason: auditReasonText(audit.reason, cfg),
        detail: audit.detail,
      };
    }

    // ④ 额度与间隔（暂停 > 日上限 > 最小间隔，顺序由 heyboxQuota 定死）
    const state = readUsage();
    const quota = heyboxQuota(state, cfg, at);
    if (!quota.ok) {
      const reject = {
        ok: false,
        code: quota.reason,
        reason: commentReasonText(quota.reason, quota),
        usedToday: quota.usedToday,
        dailyComments: quota.dailyComments,
        remaining: quota.remaining,
        nextAllowedAt: quota.nextAllowedAt,
        pausedUntil: quota.pausedUntil,
        pausedReason: state.pausedReason || '',
      };
      // 暂停中额外把「还剩多久」单列一份：模型不必从 reason 里抠时长
      if (quota.reason === 'paused') reject.pauseRemainingText = formatPauseRemaining(quota.pausedUntil, at);
      return reject;
    }

    // ⑤ 重复：只和「最近 5 条真发成功的」比，演练记录不参与
    const duplicate = nearDuplicate(body, recentSentTexts(5));
    if (duplicate !== '') {
      return { ok: false, code: 'duplicate', match: duplicate, reason: '和最近发过的评论太像了，换个说法' };
    }

    // ⑥ 演练：让 CLI 按 --dry-run 走一遍（校验登录态/帖子/文本），但不记账
    const wantDryRun = typeof dryRun === 'boolean' ? dryRun : cfg.dryRunDefault;
    if (wantDryRun) {
      const probe = await invoke(cfg, ['-f', 'json', 'comment', 'create', id, '--text', body, '--dry-run'], WRITE_TIMEOUT_MS);
      if (!probe.ok) return probe;
      // 只有 CLI 明确说「没按 dry-run 执行」才中止；字段缺失不拦（版本差异）。
      if (probe.json?.data?.dry_run === false) {
        return { ok: false, code: 'protocol', reason: '小黑盒命令行没有按 dry-run 执行，已中止' };
      }
      return { ok: true, dryRun: true, preview: { linkId: idFromDigits(id), text: body } };
    }

    // ⑦ 真发
    const sent = await invoke(cfg, ['-f', 'json', 'comment', 'create', id, '--text', body], WRITE_TIMEOUT_MS);
    if (!sent.ok) {
      appendAction({ ts: at, linkId: idFromDigits(id), text: body, dryRun: false, ok: false, reason: sent.reason });
      if (sent.code === 'captcha') {
        // 验证码 = 平台在风控。不重试，按 captchaPauseMs（默认 30 分钟）把看帖/搜索/评论一起停掉。
        // 之前是「停到当天 24:00」：一条验证码废掉剩下半天，还会和日额度混成一句说不清的理由。
        return captchaBlocked(cfg, at, sent, state);
      }
      return sent;
    }

    // 成功才记账：先算新状态，写盘失败也不影响「评论已经发出去了」这个事实。
    // 注意顺序——actions 行必须等回读之后再写，那一行要带上 commentId，先写就只能写 null。
    // 代价是回读那两次 CLI 调用（auth status + post get）之间进程若被杀，这一行会丢；
    // 但丢一行日志 ≠ 丢评论，回读失败也照样会落一行（readback:'not_found'）。
    const nextState = recordAction(state, at);
    const tracked = writeUsage(nextState);

    // ⑧ 回读校验：真发的「成功」以能在评论列表里看到自己那条为准。两个来源：
    //   a) CLI 自己已经回读过（xhh_operator 的 comment create 拿到 comment_id 后会再拉一次
    //      `post sort=latest`，逐条比对 commentid / 文本 / userid，命中就把 verified 置 true）。
    //      这种情况直接采信，不再多发一次请求 —— 小黑盒的读请求同样会触发风控，能省就省。
    //   b) 否则由我们 `post get` 复核（老版本 CLI 没有这一步，返回值里也没有 verified）。
    // 回读落空 ≠ 没发出去（审核延迟 / 分页 / 风控），所以不动 ok，只如实标 verified。
    const cliData = sent.json?.data && typeof sent.json.data === 'object' ? sent.json.data : {};
    // id 的取法有优先级：CLI 的 create 返回值自带就优先用它（不用猜、也不受审核延迟影响），
    // 否则用回读命中那条的 commentId；都没有就是 null —— 宁可空着，也不写一个猜出来的 id。
    const fromCli = commentIdFromCli(sent.json);
    let check;
    let readbackSource;
    if (fromCli !== '' && cliData.verified === true) {
      check = { verified: true, commentId: fromCli };
      readbackSource = 'cli';
    } else {
      check = await verifySent(cfg, id, body);
      readbackSource = 'local';
    }
    const readback = check.verified === true ? 'found' : 'not_found';
    const fromReadback = readback === 'found' ? textOf(check.commentId).trim() : '';
    const messageId = fromCli !== '' ? fromCli : (fromReadback !== '' ? fromReadback : null);
    const logged = appendAction({
      ts: at,
      linkId: idFromDigits(id),
      text: body,
      dryRun: false,
      messageId,
      readback,
      readbackSource,
    });

    const result = {
      ok: true,
      dryRun: false,
      linkId: idFromDigits(id),
      text: body,
      usedToday: nextState.count,
      verified: check.verified === true,
      messageId,
      readback,
      readbackSource,
    };
    if (!result.verified) {
      result.reason = 'readback_missing';
      if (check.detail) result.detail = check.detail;
    }
    const warns = [];
    if (!tracked) warns.push('本地计数写入失败，下次评论的额度可能不准');
    if (!logged) warns.push('评论已经发出去了，但本地 actions 记账失败（不影响评论本身）');
    if (warns.length > 0) result.warn = warns.join('；');
    return result;
  }

  return { status, feed, post, search, comment };
}

// ── MCP 工具注册 ────────────────────────────────────────────────────────────
/** 统一出口：结果一律是 JSON 文本；`ok:false` 同时标 isError，宿主才不会当成成功。 */
function textResult(value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  const failed = Boolean(value) && typeof value === 'object' && value.ok === false;
  return { content: [{ type: 'text', text: payload }], ...(failed ? { isError: true } : {}) };
}

/**
 * 把 5 个 heybox_* 工具注册到传入的 MCP server 上（描述与入参 schema 与独立入口逐字一致）。
 *
 * 为什么不总是用独立 server：DSH 的 MCP server 清单在启动时就读死了，新增一个独立
 * server 必须重启 DSH 才生效。所以日常运行时这些工具挂在已有的 snowluma server 上
 * （src/mcp-snowluma-safe.js 调用本函数）；src/mcp-heybox-safe.js 只是手动/调试入口。
 *
 * opts 原样透传给 createHeyboxTools()：单测靠它注入假 CLI 与临时 state 目录。
 */
export function registerHeyboxTools(server, opts = {}) {
  const tools = createHeyboxTools(opts);

  server.tool(
    'heybox_status',
    '查小黑盒登录状态与今天的评论额度（只读）：是否登录、用户 id、今天已评论几条、还剩几条、现在能不能评论、是否被验证码暂停（还剩多久）、以及评论模式的当前生效值（commentMode + 一句人话）。',
    {},
    async () => textResult(await tools.status())
  );

  server.tool(
    'heybox_feed',
    '看小黑盒首页推荐，返回链接 id 和摘要；想看正文用 heybox_post。只读，一次最多 10 条。验证码暂停期内会直接拒绝（返回里说明还剩多久），不会去碰小黑盒。',
    {
      limit: z.number().optional().describe('返回几条（1–20），默认 8；CLI 一次只给 10 条，所以实际最多 10 条'),
    },
    async ({ limit }) => textResult(await tools.feed({ limit }))
  );

  server.tool(
    'heybox_post',
    '看一条小黑盒帖子的正文和前几条评论（只读）。linkId 用 heybox_feed 或 heybox_search 返回的 linkId。验证码暂停期内同样直接拒绝。',
    {
      linkId: z.union([z.number(), z.string()]).describe('帖子 id（heybox_feed / heybox_search 返回的 linkId）'),
      comments: z.number().optional().describe('带几条评论（0–20），默认 8'),
    },
    async ({ linkId, comments }) => textResult(await tools.post({ linkId, comments }))
  );

  server.tool(
    'heybox_search',
    '在小黑盒搜索帖子（只读）：返回链接 id、标题、摘要、作者、评论数。搜太勤会被小黑盒要验证码：一旦被要过验证码，所有小黑盒请求（看帖 / 搜索 / 评论）会一起暂停一段时间（默认 30 分钟），返回里会说明还剩多久，暂停期间不要再试。',
    {
      query: z.string().describe('搜索关键词，最多 60 字'),
      limit: z.number().optional().describe('返回几条（1–10），默认 5'),
    },
    async ({ query, limit }) => textResult(await tools.search({ query, limit }))
  );

  server.tool(
    'heybox_comment',
    '在小黑盒帖子下发一条评论。只有你自己真的想回一句时才用；一次一条；默认 dry-run，不会真发（要真发得显式传 dryRun=false，且 config.json 打开了 allowComment）。不要为了刷存在感连续评论；真发成功后会回读评论区确认，并在返回里给出评论 id（messageId）与回读结果。验证码/登录失效时不要重试：验证码会自动把看帖 / 搜索 / 评论一起暂停一段时间。',
    {
      linkId: z.union([z.number(), z.string()]).describe('帖子 id（heybox_feed / heybox_search 返回的 linkId）'),
      text: z.string().describe('评论正文，纯文本，5–200 字，不要带链接 / 手机号 / 联系方式'),
      dryRun: z.boolean().optional().describe('是否只演练不真发；缺省用配置里的 dryRunDefault（出厂 true）'),
    },
    async ({ linkId, text, dryRun }) => textResult(await tools.comment({ linkId, text, dryRun }))
  );
}

