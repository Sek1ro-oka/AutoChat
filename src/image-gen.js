// 生图功能的 IO 薄层：调上游取图、落盘、按 id 读回、维护最近索引。
//
// 判断全在 `src/image-core.js`（纯函数、可单测），这里只负责三件有副作用的事：
//   1. 用 `safeFetchBuffer`（DNS 固定 + 私网拦截 + 限量读取）抓图，`fetchImpl` 可注入假实现；
//   2. 把字节写成 `state/images/<uuid>.<jpg|png|webp|gif>`（0600 权限，id 不可预测）；
//   3. 维护 `state/image-index.json`，超出条数时删最旧的文件。
//
// 索引**不做全局单例**：每次读写都重新打开文件，桥接多进程/热重载时不会拿一份内存副本
// 互相覆盖；代价是每次多一次 readFile，对「一天几十次」的生图频率完全可以忽略。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { safeFetchBuffer } from './safe-fetch.js';
import { buildPollinationsUrl, cleanImagePrompt, parseImageResult } from './image-core.js';

/** 与 safeFetchBuffer 的默认值一致：上游 JPEG 通常 100–400KB，8MB 是防呆上限。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 只放行 randomUUID() 的形状；任何路径分隔符/点号都进不来，读文件不做路径拼接兜底。 */
const IMAGE_ID_RE = /^[0-9a-f-]{36}$/;
const EXTENSIONS = Object.freeze(['jpg', 'png', 'webp', 'gif']);
const MIME_BY_EXT = Object.freeze({
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
});
const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});
const MIME_ALIASES = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
});
const DEFAULT_INDEX_MAX = 200;
const INDEX_VERSION = 1;
const DEFAULT_RETRY_AFTER_MS = 45 * 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncateByCodePoints(text, maxChars) {
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * 从 safeFetchBuffer 的抛错里捞 HTTP 状态码。
 *
 * `safeFetchBuffer` 遇到 402 时抛的是 `图片抓取失败：HTTP 402`，**头信息已经丢了** ——
 * 这是「默认走 safeFetchBuffer」的代价：拿不到 `Retry-After`，402 只能按本地 45 秒兜底。
 * 好处是 SSRF 防护/大小限制/超时全部复用同一套实现，不为一个可选头另写一条 http 请求。
 * 注入的 `fetchImpl` 可以直接返回 `{ statusCode:402, headers:{'retry-after':'12'} }`
 * 走完整解析（见下），测试用它覆盖真实头的路径。
 */
function statusFromFetchError(error) {
  const message = String(error?.message ?? error ?? '');
  const match = message.match(/HTTP\s+(\d{3})/);
  return match ? Number(match[1]) : 0;
}

/** 把 fetchImpl 的返回值收敛成 { status, buffer, retryAfter, contentType }；非法返回 null。 */
function normalizeFetchResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const statusRaw = raw.statusCode ?? raw.status;
  const status = Number.isFinite(Number(statusRaw)) ? Number(statusRaw) : 0;
  const headers = isPlainObject(raw.headers) ? raw.headers : {};
  const retryAfter = raw.retryAfter ?? headers['retry-after'] ?? headers['Retry-After'];
  const contentType = raw.contentType ?? headers['content-type'] ?? headers['Content-Type'];
  return { status, buffer: raw.buffer ?? raw.body, retryAfter, contentType };
}

/**
 * 调上游生成一张图（dev-doc §四）。
 *
 * 默认 `safeFetchBuffer(url, 8MB)`；测试注入 `fetchImpl(url, maxBytes)`，返回值与
 * `safeFetchBuffer` 同形状（`{ statusCode, buffer }`，可带 `headers`），或按同样方式抛错。
 * 返回 `{ ok:true, buffer, mime }` 或 `{ ok:false, reason, retryAfterMs?, status? }`。
 *
 * 402 不重试（research §四）：重试只会再吃一次 402，还多占一次本地额度。
 * 网络层失败统一 `fetch_failed`，有状态码的失败统一 `upstream_error`（dev-doc §五 502 码）；
 * 但 402 必须单独成 `rate_limited`，否则桥接会把它当上游故障而不是「等 45 秒再来」。
 */
export async function fetchGeneratedImage(options = {}) {
  const source = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const { prompt, width, height, seed, safe, fetchImpl } = source;
  const url = buildPollinationsUrl({ prompt, width, height, seed, safe });
  const fetcher = typeof fetchImpl === 'function' ? fetchImpl : safeFetchBuffer;

  let raw;
  try {
    raw = await fetcher(url, MAX_IMAGE_BYTES);
  } catch (error) {
    const status = statusFromFetchError(error);
    if (status === 402) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: DEFAULT_RETRY_AFTER_MS, status: 402 };
    }
    if (status > 0) return { ok: false, reason: 'upstream_error', status };
    return { ok: false, reason: 'fetch_failed' };
  }

  const result = normalizeFetchResult(raw);
  if (!result) return { ok: false, reason: 'fetch_failed' };
  const parsed = parseImageResult({
    status: result.status,
    retryAfter: result.retryAfter,
    contentType: result.contentType,
    buffer: result.buffer,
  });
  if (!parsed.ok) return parsed;
  return { ok: true, buffer: result.buffer, mime: parsed.mime };
}

/** 确定落盘用的 mime：配置/调用方给的值优先，认简写；认不出就用魔数嗅探（复用核心层）。 */
function resolveMime(mime, buffer) {
  const clean = typeof mime === 'string' ? mime.trim().toLowerCase() : '';
  if (EXT_BY_MIME[clean]) return clean;
  if (MIME_ALIASES[clean]) return MIME_ALIASES[clean];
  const sniffed = parseImageResult({ status: 200, buffer });
  return sniffed.ok ? sniffed.mime : '';
}

/**
 * 把生成的图片写到 `dir/<uuid>.<ext>`（dev-doc §四）。
 *
 * - id 用 `crypto.randomUUID()`，不可预测；扩展名按 mime 定（jpeg → jpg），不是按用户输入；
 * - 写文件尝试 0600（Windows 上 mode 只影响只读位，Linux 上才是真正的权限位）；
 * - 返回可直接塞进索引/响应体的记录；`meta` 可选，原样浅拷贝带回（桥接用来放
 *   width/height/source 这类展示字段）。
 *
 * buffer 为空 / dir 为空 / mime 认不出属于**编程错误**，直接抛 TypeError —— 静默写一个
 * 0 字节文件或 `.bin` 只会让后面读图的人更难排查。
 */
export async function saveGeneratedImage({ dir, buffer, mime, prompt, meta, now } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError('saveGeneratedImage：buffer 必须是非空 Buffer');
  }
  const directory = typeof dir === 'string' ? dir.trim() : '';
  if (directory === '') throw new TypeError('saveGeneratedImage：dir 不能为空');

  const resolvedMime = resolveMime(mime, buffer);
  const ext = EXT_BY_MIME[resolvedMime];
  if (!ext) throw new TypeError(`saveGeneratedImage：不支持的图片类型 ${mime ?? '(空)'}`);

  const id = crypto.randomUUID();
  const file = path.resolve(directory, `${id}.${ext}`);
  const tsRaw = Number(now);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.trunc(tsRaw) : Date.now();

  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(file, buffer, { mode: 0o600 });

  const record = {
    id,
    file,
    bytes: buffer.length,
    mime: resolvedMime,
    prompt: cleanImagePrompt(prompt),
    ts,
  };
  if (isPlainObject(meta)) record.meta = { ...meta };
  return record;
}

/**
 * 按 id 读回落盘的图片（dev-doc §四）：依次试 jpg/png/webp/gif，命中即返回 `{ buffer, mime }`。
 *
 * id 必须先过 `/^[0-9a-f-]{36}$/`：URL 里的 `<id>` 会直接传进来，不做校验的话
 * `../../config.json` 之类的值就是一次任意文件读。未命中/坏 id 一律 null（不抛）。
 */
export async function readStoredImage(options = {}) {
  const source = options !== null && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const { dir, id } = source;
  const directory = typeof dir === 'string' ? dir.trim() : '';
  const imageId = typeof id === 'string' ? id.trim() : '';
  if (directory === '' || !IMAGE_ID_RE.test(imageId)) return null;

  for (const ext of EXTENSIONS) {
    const file = path.join(directory, `${imageId}.${ext}`);
    try {
      const buffer = await fs.promises.readFile(file);
      if (buffer.length === 0) continue;
      return { buffer, mime: MIME_BY_EXT[ext] };
    } catch {
      // 不存在 / 无权限 / 是目录：都继续试下一个扩展名，最终交给调用方按 null 处理。
    }
  }
  return null;
}

// ── 索引 ────────────────────────────────────────────────────────────────────

/** 索引条目的白名单形状；坏条目（缺 id/file/ts）直接丢，避免脏数据把裁剪逻辑带偏。 */
function normalizeIndexEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const file = typeof raw.file === 'string' ? raw.file.trim() : '';
  const tsRaw = Number(raw.ts);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? Math.trunc(tsRaw) : 0;
  if (!IMAGE_ID_RE.test(id) || file === '' || ts === 0) return null;

  const entry = { id, file, ts };
  const bytes = Number(raw.bytes);
  if (Number.isFinite(bytes) && bytes >= 0) entry.bytes = Math.trunc(bytes);
  if (typeof raw.mime === 'string' && raw.mime.trim() !== '') entry.mime = raw.mime.trim().toLowerCase();
  if (typeof raw.prompt === 'string' && raw.prompt.trim() !== '') {
    entry.prompt = truncateByCodePoints(raw.prompt.trim(), 300);
  }
  if (isPlainObject(raw.meta)) entry.meta = { ...raw.meta };
  return entry;
}

/**
 * 读索引，**永不抛**：文件不存在 / 坏 JSON / 字段不合法都返回 `[]`。
 * 结果按 ts 倒序（最新在前），调用方可以直接取第一条。
 */
export async function readIndex(indexPath) {
  const file = typeof indexPath === 'string' ? indexPath.trim() : '';
  if (file === '') return [];
  let text;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (isPlainObject(parsed) && Array.isArray(parsed.entries) ? parsed.entries : []);
  return list.map(normalizeIndexEntry).filter(Boolean).sort((a, b) => b.ts - a.ts);
}

/**
 * 追加/更新一条索引并落盘，超出 `max` 时删掉最旧那条的**文件**（dev-doc §四）。
 *
 * - 同一 id 重复保存是替换，不会在索引里出现两条；
 * - 裁剪按 ts 倒序保留前 max 条，`max` 缺省 200，钳到 [1, 1000]；
 * - 删除前校验目标文件在索引目录之下：索引被手工改过时，最多是「少删一个文件」，
 *   不会顺着 `file` 字段删到别处；`unlink` 失败（已被清掉/权限）忽略，不影响索引写入；
 * - 写盘用 tmp + rename，避免进程在写一半时被杀留下半截 JSON。
 *
 * 返回裁剪后的条目数组（最新在前）。indexPath 为空是编程错误，抛 TypeError。
 */
export async function saveIndexEntry(indexPath, entry, max = DEFAULT_INDEX_MAX) {
  const file = typeof indexPath === 'string' ? indexPath.trim() : '';
  if (file === '') throw new TypeError('saveIndexEntry：indexPath 不能为空');

  const existing = await readIndex(file);
  const normalized = normalizeIndexEntry(entry);
  if (!normalized) return existing;

  const maxRaw = Number(max);
  const limit = Number.isFinite(maxRaw)
    ? Math.min(1000, Math.max(1, Math.trunc(maxRaw)))
    : DEFAULT_INDEX_MAX;
  const list = [normalized, ...existing.filter((item) => item.id !== normalized.id)]
    .sort((a, b) => b.ts - a.ts);
  const kept = list.slice(0, limit);
  const dropped = list.slice(limit);

  const root = path.resolve(path.dirname(file));
  for (const old of dropped) {
    try {
      const target = path.resolve(old.file);
      if (target === root || !target.startsWith(root + path.sep)) continue;
      await fs.promises.unlink(target);
    } catch {
      // 文件早被清掉 / 权限不足：索引照写，下次裁剪还会再试。
    }
  }

  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, entries: kept }, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
  return kept;
}
