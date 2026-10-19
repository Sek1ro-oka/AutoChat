// B站「看视频」MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 定位：让 QQ 侧的 agent 能真正「看」一个 B站视频——拿标题/简介/时长/播放数据，
// 有字幕就把字幕读进来，需要时再看评论、相关推荐和 B站自己的 AI 总结。
// 底层复用用户机器上已装好的 bili-cli（agent-reach 的 B站渠道就是它），
// 而不是把 agent-reach 整个 skill 塞进 QQ 侧：skill 依赖 shell，而 QQ agent 刻意没有命令执行能力。
//
// 安全设计：
// - **只读**：只暴露 search / video / hot / rank 四个只读动作，绝不调用 login、like、coin、
//   triple、dynamic-post 等写操作。
// - **参数受限**：BV 号必须匹配 `^BV[0-9A-Za-z]{10}$`；URL 只接受 bilibili.com 域名；
//   关键词长度上限 60 字符、不允许换行，避免拼接出奇怪的命令参数。
// - **不走 shell**：child_process.spawn(bin, argv) 直接传数组，不经过 cmd.exe。
// - **输出限量**：字幕默认最多 6000 字符、评论最多 10 条、整体 stdout 上限 8MB，
//   超限截断并标注 truncated，防止一个视频把上下文撑爆。
// - **超时**：默认 60s，超时直接 kill 子进程。
//
// 自检：`node src/mcp-bili-safe.js --check` 打印解析到的 bili 路径与一次真实搜索的结果。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const MAX_STDOUT = 8 * 1024 * 1024;

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

// bili-cli 的默认安装位置：uv tool 装到 %USERPROFILE%\.local\bin\bili.exe
function defaultBiliBin() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, '.local', 'bin', 'bili.exe'),
    path.join(home, '.local', 'bin', 'bili')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function biliConfig() {
  const raw = loadConfig().bili ?? {};
  const configured = String(raw.bin ?? '').trim();
  const bin = configured
    ? (path.isAbsolute(configured) ? configured : path.join(ROOT, configured))
    : defaultBiliBin();
  return {
    enabled: raw.enabled !== false,
    bin,
    timeoutMs: clampNumber(raw.timeoutMs, 60000, 5000, 180000),
    maxSubtitleChars: clampNumber(raw.maxSubtitleChars, 6000, 500, 40000),
    maxComments: clampNumber(raw.maxComments, 10, 0, 50),
    useOpencli: raw.useOpencli !== false,
    opencliBin: String(raw.opencliBin ?? '').trim()
  };
}

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function truncate(text, max) {
  const str = String(text ?? '');
  if (str.length <= max) return { text: str, truncated: false };
  return { text: `${str.slice(0, max)}\n\n…（已截断，共 ${str.length} 字符）`, truncated: true };
}

// 子进程统一环境：bili-cli 是 Python 写的，Windows 控制台默认 GBK 会让它打印 emoji 时崩掉，
// 必须强制 UTF-8；PYTHONWARNINGS 压掉证书库那条无害告警（它会污染 stderr）。
function childEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONWARNINGS: 'ignore'
  };
}

function runBili(argv, timeoutMs) {
  const cfg = biliConfig();
  if (!cfg.enabled) return Promise.reject(new Error('B站功能未启用（config.json 的 bili.enabled 不是 true）'));
  if (!cfg.bin || !fs.existsSync(cfg.bin)) {
    return Promise.reject(new Error(`找不到 bili 可执行文件（当前解析为 ${cfg.bin || '空'}）。装法：uv tool install bilibili-cli，或在 config.json 的 bili.bin 里写绝对路径。`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.bin, argv, { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`bili 超时（${timeoutMs}ms）：${argv.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_STDOUT) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`bili 输出超过 ${MAX_STDOUT} 字节上限`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 4000); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 bili：${error?.message ?? error}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`bili 退出码 ${code}：${stderr.trim().slice(0, 400) || '无输出'}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

function parseJsonOutput(stdout, action) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`${action} 没有返回 JSON：${text.slice(0, 200) || '空输出'}`);
  try {
    return JSON.parse(text.slice(start));
  } catch (error) {
    throw new Error(`${action} 返回的不是合法 JSON：${text.slice(0, 200)}（${error?.message ?? error}）`);
  }
}

// ── opencli 兜底：bili-cli 拿不到字幕时，用浏览器里已登录的 B站 会话取字幕 ──────────
// opencli 在 Windows 上是 npm 的 .cmd 包装，必须经 cmd.exe 调用；参数只有校验过的 BV 号，
// 没有用户可控的字符串拼进去。
function defaultOpencliBin() {
  const appData = process.env.APPDATA || '';
  const candidates = [
    path.join(appData, 'npm', 'opencli.cmd'),
    path.join(appData, 'npm', 'opencli.exe'),
    path.join(appData, 'npm', 'opencli')
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function opencliBin(cfg) {
  const configured = String(cfg.opencliBin ?? '').trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
  return defaultOpencliBin();
}

function runOpencli(argv, timeoutMs) {
  return new Promise((resolve) => {
    const bin = argv.shift();
    const child = spawn('cmd.exe', ['/d', '/s', '/c', bin, ...argv], { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve('');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (chunks.length < 4096) chunks.push(chunk); });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function subtitleViaOpencli(bvid, cfg) {
  if (cfg.useOpencli === false) return null;
  const bin = opencliBin(cfg);
  if (!bin) return null;
  const raw = await runOpencli([bin, 'bilibili', 'subtitle', bvid, '-f', 'json'], Math.min(cfg.timeoutMs, 90000));
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let json;
  try {
    json = JSON.parse(text.slice(start));
  } catch {
    return null;
  }
  if (json?.ok !== true || !Array.isArray(json.data)) return null;
  const lines = json.data.map((item) => String(item?.content ?? '').trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const language = String(json.data[0]?.language ?? '');
  return {
    source: `opencli${language ? `:${language}` : ''}`,
    text: lines.join('\n')
  };
}

// 只接受 BV 号或 bilibili.com 的视频链接，其它一律拒绝（防止把任意参数喂给 CLI）
function normalizeTarget(target) {
  const value = String(target ?? '').trim();
  if (BVID_RE.test(value)) return value;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('链接格式不对');
    }
    const host = url.hostname.toLowerCase();
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv'].includes(host)) {
      throw new Error(`只支持 B站链接，收到的是 ${host}`);
    }
    return value;
  }
  throw new Error('第一个参数要是 BV 号（BV 开头 12 位）或 B站视频链接');
}

async function searchVideos(keyword, limit) {
  const cfg = biliConfig();
  const word = String(keyword ?? '').trim();
  if (!word) throw new Error('关键词不能为空');
  if (word.length > 60) throw new Error('关键词太长（上限 60 字符）');
  if (/[\r\n]/.test(word)) throw new Error('关键词不能包含换行');
  const n = clampNumber(limit, 5, 1, 10);
  const { stdout } = await runBili(['search', word, '--type', 'video', '-n', String(n), '--json'], cfg.timeoutMs);
  const json = parseJsonOutput(stdout, '搜索');
  const items = Array.isArray(json?.data) ? json.data : [];
  return {
    keyword: word,
    count: items.length,
    videos: items.map((item) => ({
      bvid: item.bvid ?? item.id ?? '',
      title: item.title ?? '',
      author: item.author ?? '',
      play: item.play ?? null,
      duration: item.duration ?? ''
    }))
  };
}

async function videoDetail(target, options = {}) {
  const cfg = biliConfig();
  const ref = normalizeTarget(target);
  const argv = ['video', ref, '--json'];
  if (options.withSubtitle !== false) argv.push('-s');
  if (options.withComments) argv.push('-c');
  if (options.withAi) argv.push('--ai');
  if (options.withRelated) argv.push('-r');
  const { stdout } = await runBili(argv, cfg.timeoutMs);
  const json = parseJsonOutput(stdout, '视频详情');
  const data = json?.data ?? {};
  const video = data.video ?? {};
  const stats = video.stats ?? {};
  const subtitle = data.subtitle ?? {};
  const bvid = video.bvid ?? ref;

  // bili-cli 的字幕依赖登录态，多数视频拿不到；退回 opencli（走浏览器里已登录的 B站 会话）。
  let subtitleText = String(subtitle.text ?? '');
  let subtitleSource = subtitle.available === true ? 'bili' : '';
  if (options.withSubtitle !== false && subtitle.available !== true && /^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    const fallback = await subtitleViaOpencli(bvid, cfg);
    if (fallback) {
      subtitleText = fallback.text;
      subtitleSource = fallback.source;
    }
  }
  const sub = truncate(subtitleText, cfg.maxSubtitleChars);
  const comments = Array.isArray(data.comments) ? data.comments.slice(0, cfg.maxComments) : [];
  const related = Array.isArray(data.related) ? data.related.slice(0, 5) : [];
  return {
    bvid,
    title: video.title ?? '',
    url: video.url ?? '',
    author: video.owner?.name ?? '',
    duration: video.duration ?? '',
    description: truncate(video.description ?? '', 500).text,
    stats: {
      view: stats.view ?? null,
      like: stats.like ?? null,
      coin: stats.coin ?? null,
      favorite: stats.favorite ?? null,
      share: stats.share ?? null,
      danmaku: stats.danmaku ?? null
    },
    subtitle: {
      available: sub.text.length > 0,
      source: subtitleSource,
      chars: subtitleText.length,
      truncated: sub.truncated,
      text: sub.text
    },
    aiSummary: truncate(data.ai_summary ?? '', 2000).text,
    comments: comments.map((item) => ({
      author: item.author ?? item.user ?? '',
      content: truncate(item.content ?? item.message ?? '', 200).text,
      like: item.like ?? null
    })),
    related: related.map((item) => ({ bvid: item.bvid ?? item.id ?? '', title: item.title ?? '' })),
    warnings: Array.isArray(data.warnings) ? data.warnings.slice(0, 5) : []
  };
}

async function hotVideos(limit) {
  const cfg = biliConfig();
  const n = clampNumber(limit, 5, 1, 10);
  const { stdout } = await runBili(['hot', '-n', String(n), '--json'], cfg.timeoutMs);
  const json = parseJsonOutput(stdout, '热门');
  const raw = json?.data;
  // bili-cli 1.x 的 hot 把列表放在 data.items；旧版/其它命令可能是 data 数组或 data.list。
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw?.list) ? raw.list : []));
  return {
    count: items.length,
    videos: items.slice(0, n).map((item) => ({
      bvid: item.bvid ?? item.id ?? '',
      title: item.title ?? '',
      author: item.author ?? item.owner?.name ?? '',
      play: item.play ?? item.stats?.view ?? null
    }))
  };
}

const server = new McpServer({ name: 'bili-safe', version: '1.0.0' });

server.tool(
  'bili_search',
  '在 B站搜索视频（只读）。返回 BV 号、标题、UP 主、播放量、时长。群友问「B站上有没有 xxx」时用它。',
  {
    keyword: z.string().describe('搜索关键词，最多 60 字'),
    limit: z.number().optional().describe('返回几条，默认 5，最多 10')
  },
  async ({ keyword, limit }) => {
    try {
      return textResult(await searchVideos(keyword, limit));
    } catch (error) {
      return textResult(`搜索失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'bili_video',
  '查看一个 B站视频的具体内容（只读）：标题、UP 主、时长、播放/点赞/收藏数据、简介，默认连带字幕正文。要看评论、相关推荐或 B站 AI 总结就传对应开关。只有 BV 号或 B站链接能传。',
  {
    target: z.string().describe('BV 号（如 BV1GJ411x7h7）或 bilibili.com 视频链接'),
    with_subtitle: z.boolean().optional().describe('是否取字幕正文，默认 true'),
    with_comments: z.boolean().optional().describe('是否取热门评论，默认 false'),
    with_ai: z.boolean().optional().describe('是否取 B站自己的 AI 总结，默认 false'),
    with_related: z.boolean().optional().describe('是否取相关推荐，默认 false')
  },
  async ({ target, with_subtitle, with_comments, with_ai, with_related }) => {
    try {
      return textResult(await videoDetail(target, {
        withSubtitle: with_subtitle !== false,
        withComments: with_comments === true,
        withAi: with_ai === true,
        withRelated: with_related === true
      }));
    } catch (error) {
      return textResult(`读取视频失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'bili_hot',
  '看 B站当前热门视频（只读）。返回 BV 号、标题、UP 主、播放量。',
  {
    limit: z.number().optional().describe('返回几条，默认 5，最多 10')
  },
  async ({ limit }) => {
    try {
      return textResult(await hotVideos(limit));
    } catch (error) {
      return textResult(`读取热门失败：${error?.message ?? error}`, true);
    }
  }
);

if (process.argv.includes('--check')) {
  try {
    const cfg = biliConfig();
    const probe = cfg.enabled && cfg.bin ? await searchVideos('暗区突围', 2) : null;
    process.stdout.write(`${JSON.stringify({ ok: true, enabled: cfg.enabled, bin: cfg.bin, timeoutMs: cfg.timeoutMs, probe }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[bili-safe] 自检失败：${error?.message ?? error}\n`);
    process.exit(1);
  }
} else {
  await server.connect(new StdioServerTransport());
}
