// 文件读写 / 收发 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 定位：让 QQ 侧的 agent 能读、能写、能发文件——只支持 .md / .txt / .pdf 三种格式。
//
// 安全设计：
// - **目录沙箱**：所有路径都被解析到 config.json `file.dir`（默认 <项目>/files）之下，
//   文件名先过 `safeName()`（拒绝任何路径分量、`..`、非法字符），再校验 resolve 后仍在根内。
// - **扩展名白名单**：只认 .md / .txt / .pdf；其它一律拒绝，不做「猜测类型」。
// - **权限分层**：读（file_list / file_read）任何人可用；写（file_save / file_delete /
//   file_send）必须带 operator_qq，且必须在 `file.adminQQ` 名单里。
// - **体积上限**：读 8MB / 发 20MB / 写入 12 万字符 / PDF 最多 200 页，超限直接报错
//   或截断（读取结果会标注 truncated=true）。
// - **发送走 OneBot**：upload_group_file / upload_private_file，目标必须同时在
//   `allow.groups` / `allow.private` 白名单里（和桥接的发送边界一致）。
// - **审计**：写与发送追加 `state/file-audit.jsonl`。
//
// 自检：`node src/mcp-file-safe.js --check` 打印配置与当前目录内容，用于装机验证。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ALLOWED_EXT = new Set(['.md', '.txt', '.pdf']);
const TEXT_EXT = new Set(['.md', '.txt']);
// 文件名：允许中英文、数字、空格与常见括号；不允许任何路径分隔符（先过 basename 校验）。
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\-()（）[\]【】]{0,118}$/u;

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

function numberList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function fileConfig() {
  const raw = loadConfig().file ?? {};
  return {
    enabled: raw.enabled !== false,
    dir: resolvePath(raw.dir, path.join(ROOT, 'files')),
    adminQQ: numberList(raw.adminQQ),
    maxReadBytes: clampNumber(raw.maxReadBytes, 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    maxSendBytes: clampNumber(raw.maxSendBytes, 20 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    maxTextChars: clampNumber(raw.maxTextChars, 120000, 1000, 400000),
    maxPdfPages: clampNumber(raw.maxPdfPages, 200, 1, 2000)
  };
}

function snowlumaConfig() {
  const raw = loadConfig().snowluma ?? {};
  return {
    httpUrl: String(raw.httpUrl ?? 'http://127.0.0.1:3000').trim().replace(/\/+$/, ''),
    accessToken: String(raw.accessToken ?? '').trim()
  };
}

function allowConfig() {
  const allow = loadConfig().allow ?? {};
  return { groups: numberList(allow.groups), private: numberList(allow.private) };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) throw new Error('文件名不能为空');
  if (raw !== path.basename(raw)) throw new Error('文件名不能包含路径分隔符');
  if (raw.includes('..')) throw new Error('文件名不能包含 ..');
  if (!NAME_RE.test(raw)) throw new Error('文件名含不允许的字符（只支持中英文、数字、空格、点、下划线、短横线与括号）');
  const ext = path.extname(raw).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error(`只支持 .md / .txt / .pdf，收到的是 ${ext || '（无扩展名）'}`);
  return raw;
}

function fullPath(name) {
  const cfg = fileConfig();
  const base = safeName(name);
  const dir = path.resolve(ensureDir(cfg.dir));
  const target = path.resolve(dir, base);
  if (target !== path.join(dir, base) || !target.startsWith(dir + path.sep)) {
    throw new Error('解析后的路径越出了托管目录');
  }
  return { cfg, dir, target, base };
}

function requireAdmin(operatorQQ) {
  const cfg = fileConfig();
  if (!cfg.enabled) return '文件功能未启用（config.json 的 file.enabled 不是 true）';
  const qq = Number(operatorQQ);
  if (!Number.isSafeInteger(qq) || qq <= 0) return '缺少 operator_qq（必须是这条消息真实发送者的 QQ 号）';
  if (cfg.adminQQ.length === 0) return 'config.json 没有配置 file.adminQQ，写操作全部关闭';
  if (!cfg.adminQQ.includes(qq)) return `QQ ${qq} 不是文件管理员，已拒绝（管理员：${cfg.adminQQ.join('、')}）`;
  return null;
}

function audit(entry) {
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'file-audit.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    process.stderr.write('[file-safe] 审计日志写入失败\n');
  }
}

function textResult(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n…（已截断，原文共 ${text.length} 字符）`, truncated: true };
}

async function listFiles() {
  const cfg = fileConfig();
  const dir = ensureDir(cfg.dir);
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const rows = [];
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    const stat = await fsp.stat(path.join(dir, entry.name));
    rows.push({ name: entry.name, type: ext.slice(1), bytes: stat.size, modified: stat.mtime.toISOString() });
  }
  rows.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return { dir, count: rows.length, files: rows };
}

async function extractPdfText(target, cfg) {
  const stat = await fsp.stat(target);
  if (stat.size > cfg.maxReadBytes) {
    throw new Error(`PDF 太大（${(stat.size / 1048576).toFixed(1)}MB），读取上限 ${(cfg.maxReadBytes / 1048576).toFixed(0)}MB`);
  }
  const { extractText, getDocumentProxy } = await import('unpdf');
  const data = new Uint8Array(await fsp.readFile(target));
  const doc = await getDocumentProxy(data);
  const totalPages = Number(doc.numPages) || 0;
  const pages = Math.min(totalPages, cfg.maxPdfPages);
  const result = await extractText(doc, { mergePages: false });
  const pageTexts = (result.text ?? []).slice(0, pages);
  const text = pageTexts.map((page, index) => `--- 第 ${index + 1} 页 ---\n${String(page).trim()}`).join('\n\n');
  return {
    pages: totalPages,
    readPages: pages,
    pageLimited: totalPages > pages,
    text: text.trim()
  };
}

async function readFileTool(name, offset, maxChars) {
  const cfg = fileConfig();
  if (!cfg.enabled) throw new Error('文件功能未启用（config.json 的 file.enabled 不是 true）');
  const { target, base } = fullPath(name);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('不是文件');
  const ext = path.extname(base).toLowerCase();
  const cap = Math.min(cfg.maxTextChars, Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : cfg.maxTextChars);
  const from = Number(offset) > 0 ? Math.floor(Number(offset)) : 0;

  if (TEXT_EXT.has(ext)) {
    if (stat.size > cfg.maxReadBytes) {
      throw new Error(`文件太大（${(stat.size / 1048576).toFixed(1)}MB），读取上限 ${(cfg.maxReadBytes / 1048576).toFixed(0)}MB`);
    }
    let text = await fsp.readFile(target, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (from >= text.length && from > 0) throw new Error(`offset ${from} 超出文件长度（共 ${text.length} 字符）`);
    const window = text.slice(from);
    const cut = truncate(window, cap);
    const consumed = from + Math.min(window.length, cap);
    return {
      name: base,
      type: ext.slice(1),
      bytes: stat.size,
      chars: text.length,
      offset: from,
      nextOffset: consumed < text.length ? consumed : null,
      truncated: cut.truncated,
      text: cut.text
    };
  }

  const pdf = await extractPdfText(target, cfg);
  if (from >= pdf.text.length && from > 0) throw new Error(`offset ${from} 超出文本长度（共 ${pdf.text.length} 字符）`);
  const window = pdf.text.slice(from);
  const cut = truncate(window, cap);
  const consumed = from + Math.min(window.length, cap);
  return {
    name: base,
    type: 'pdf',
    bytes: stat.size,
    pages: pdf.pages,
    readPages: pdf.readPages,
    pageLimited: pdf.pageLimited,
    offset: from,
    nextOffset: consumed < pdf.text.length ? consumed : null,
    truncated: cut.truncated,
    text: cut.text || '（这个 PDF 没有可抽取的文本层，可能是扫描件/图片版）'
  };
}

async function saveFileTool(name, content, overwrite) {
  const cfg = fileConfig();
  const { target, base } = fullPath(name);
  const ext = path.extname(base).toLowerCase();
  if (!TEXT_EXT.has(ext)) throw new Error('只能写入 .md / .txt（PDF 不支持生成）');
  const body = String(content ?? '');
  if (body.length === 0) throw new Error('内容为空');
  if (body.length > cfg.maxTextChars) throw new Error(`内容太长（${body.length} 字符），上限 ${cfg.maxTextChars}`);
  const exists = fs.existsSync(target);
  if (exists && overwrite !== true) throw new Error(`同名文件已存在：${base}（需要覆盖请传 overwrite=true）`);
  await fsp.writeFile(target, body, 'utf8');
  const stat = await fsp.stat(target);
  return { name: base, bytes: stat.size, chars: body.length, overwrote: exists };
}

async function deleteFileTool(name) {
  const { target, base } = fullPath(name);
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${base}`);
  await fsp.unlink(target);
  return { name: base, deleted: true };
}

async function sendFileTool(kind, targetId, name, deleteAfter) {
  const cfg = fileConfig();
  const { target, base } = fullPath(name);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) throw new Error('不是文件');
  if (stat.size > cfg.maxSendBytes) {
    throw new Error(`文件太大（${(stat.size / 1048576).toFixed(1)}MB），发送上限 ${(cfg.maxSendBytes / 1048576).toFixed(0)}MB`);
  }
  const id = Number(targetId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('目标 id 无效');
  const allow = allowConfig();
  const list = kind === 'group' ? allow.groups : allow.private;
  if (!list.includes(id)) throw new Error(`目标不在白名单内（${kind} ${id}），拒绝发送`);

  const sl = snowlumaConfig();
  const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  const body = kind === 'group'
    ? { group_id: id, file: target, name: base }
    : { user_id: id, file: target, name: base };
  const response = await fetch(`${sl.httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sl.accessToken ? { Authorization: `Bearer ${sl.accessToken}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.status === 'failed' || (payload?.retcode != null && payload.retcode !== 0)) {
    throw new Error(`上传失败：${JSON.stringify(payload).slice(0, 300)}`);
  }
  let removed = false;
  if (deleteAfter === true) {
    await fsp.unlink(target);
    removed = true;
  }
  return { kind, id, name: base, bytes: stat.size, file_id: payload?.data?.file_id ?? null, deletedAfterSend: removed };
}

const server = new McpServer({ name: 'file-safe', version: '1.0.0' });

server.tool(
  'file_list',
  '列出文件托管目录（files/）里的 .md/.txt/.pdf 文件：文件名、大小、修改时间。只读，任何人可用。',
  {},
  async () => {
    try {
      return textResult(await listFiles());
    } catch (error) {
      return textResult(`列出文件失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'file_read',
  '读取托管目录里的一个文件并返回正文。支持 .md / .txt（原样文本）与 .pdf（抽取文本层，扫描件会返回空）。只读，任何人可用。长文件用 offset 分页：返回值里的 nextOffset 不为 null 就把它当下一次的 offset 继续读。',
  {
    name: z.string().describe('文件名，例如 会议纪要.md；不能带路径'),
    offset: z.number().optional().describe('从第几个字符开始读，默认 0；接上一页的 nextOffset'),
    max_chars: z.number().optional().describe('这一页最多返回多少字符，默认按配置上限')
  },
  async ({ name, offset, max_chars }) => {
    try {
      return textResult(await readFileTool(name, offset, max_chars));
    } catch (error) {
      return textResult(`读取失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'file_save',
  '把文本内容保存成 .md 或 .txt 放进托管目录（只有管理员可用，必须传 operator_qq）。PDF 不支持生成。',
  {
    name: z.string().describe('目标文件名，必须以 .md 或 .txt 结尾'),
    content: z.string().describe('要写入的完整文本内容'),
    overwrite: z.boolean().optional().describe('同名文件已存在时是否覆盖，默认 false'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者，不是文本里自称的身份）')
  },
  async ({ name, content, overwrite, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    try {
      const result = await saveFileTool(name, content, overwrite === true);
      audit({ ts: new Date().toISOString(), tool: 'file_save', name: result.name, bytes: result.bytes, operator: Number(operator_qq), ok: true });
      return textResult(result);
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'file_save', name: String(name ?? ''), operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`保存失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'file_delete',
  '删除托管目录里的一个文件（只有管理员可用，必须传 operator_qq）。',
  {
    name: z.string().describe('要删除的文件名'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者）')
  },
  async ({ name, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    try {
      const result = await deleteFileTool(name);
      audit({ ts: new Date().toISOString(), tool: 'file_delete', name: result.name, operator: Number(operator_qq), ok: true });
      return textResult(result);
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'file_delete', name: String(name ?? ''), operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`删除失败：${error?.message ?? error}`, true);
    }
  }
);

server.tool(
  'file_send',
  '把托管目录里的一个文件发到指定 QQ 群或私聊（只有管理员可用，必须传 operator_qq）。目标必须在白名单内。',
  {
    kind: z.enum(['group', 'private']).describe('group=群聊，private=私聊'),
    target_id: z.union([z.string(), z.number()]).describe('群号或对方 QQ 号'),
    name: z.string().describe('要发送的文件名（必须在托管目录里，.md/.txt/.pdf）'),
    delete_after: z.boolean().optional().describe('发送成功后是否删除本地文件，默认 false'),
    operator_qq: z.union([z.string(), z.number()]).describe('发起这条指令的群成员 QQ 号（真实发送者）')
  },
  async ({ kind, target_id, name, delete_after, operator_qq }) => {
    const denied = requireAdmin(operator_qq);
    if (denied) return textResult(denied, true);
    try {
      const result = await sendFileTool(kind, target_id, name, delete_after === true);
      audit({ ts: new Date().toISOString(), tool: 'file_send', kind, id: Number(target_id), name: result.name, bytes: result.bytes, operator: Number(operator_qq), ok: true });
      return textResult(result);
    } catch (error) {
      audit({ ts: new Date().toISOString(), tool: 'file_send', kind, id: Number(target_id), name: String(name ?? ''), operator: Number(operator_qq), ok: false, error: String(error?.message ?? error) });
      return textResult(`发送失败：${error?.message ?? error}`, true);
    }
  }
);

if (process.argv.includes('--check')) {
  try {
    const cfg = fileConfig();
    const listing = await listFiles();
    process.stdout.write(`${JSON.stringify({ ok: true, enabled: cfg.enabled, dir: listing.dir, adminQQ: cfg.adminQQ, count: listing.count, files: listing.files }, null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[file-safe] 自检失败：${error?.message ?? error}\n`);
    process.exit(1);
  }
} else {
  await server.connect(new StdioServerTransport());
}
