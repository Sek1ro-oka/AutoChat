// 小鲸鱼的日记本：每个聊天一个文件夹，一天一个 .md 文件。
//
// 目录形状（默认 ROOT = 仓库根，运行时被 state/ 忽略规则覆盖，不进版本库）：
//   state/diaries/<group_群号 | private_QQ号>/<YYYY-MM-DD>.md
//
// 设计要点：
// - **key 来自模型**，所以必须当不可信输入处理：只接受 `group:<数字>` / `private:<数字>`，
//   目录名由 key 派生后再 resolve 校验必须仍落在 diaries 根目录内（防 `../` 穿越）。
// - 一天可以写多则，按 `## HH:MM · 标题` 分节，节间空行；同一天最多 MAX_ENTRIES_PER_DAY 则。
// - 写入先落 `.tmp` 再 rename，避免半个文件（同一会话并发写时也不会互相截断）。
// - 这里不判断"该不该写"——那是提示词的事；本模块只负责安全落盘与读回。
import fs from 'node:fs';
import path from 'node:path';

export const DIARY_KEY_RE = /^(group|private):\d{1,20}$/;
export const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_ENTRIES_PER_DAY = 20;
export const MAX_ENTRY_CHARS = 4000;
export const MAX_TITLE_CHARS = 60;
export const MAX_MOOD_CHARS = 20;
export const MAX_TAGS = 8;
export const MAX_TAG_CHARS = 20;
export const MAX_READ_CHARS = 20000;

/** key 是否是可写日记的会话（格式与桥接其它 v2 工具一致）。 */
export function diaryKeyOk(key) {
  return DIARY_KEY_RE.test(String(key ?? '').trim());
}

/** 会话 key → 文件夹名，例如 `group:123456789` → `group_123456789`。 */
export function diaryFolderName(key) {
  const k = String(key ?? '').trim();
  if (!diaryKeyOk(k)) throw new Error('会话 key 非法：只接受 group:<群号> / private:<QQ号>');
  return k.replace(':', '_');
}

/** 该会话的日记目录（未创建时不抛错）。 */
export function diaryDirOf(root, key) {
  const base = path.resolve(String(root));
  const dir = path.resolve(base, diaryFolderName(key));
  if (dir !== base && !dir.startsWith(base + path.sep)) throw new Error('日记目录越界');
  return dir;
}

/** 该会话某天的日记文件路径。 */
export function diaryFilePath(root, key, date) {
  const d = normalizeDiaryDate(date);
  const file = path.resolve(diaryDirOf(root, key), `${d}.md`);
  const dir = diaryDirOf(root, key);
  if (!file.startsWith(dir + path.sep)) throw new Error('日记文件越界');
  return file;
}

/** 本地时区的 YYYY-MM-DD。 */
export function localDateOf(now = Date.now()) {
  const t = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** 本地时区的 HH:MM。 */
export function localTimeOf(now = Date.now()) {
  const t = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}`;
}

/**
 * 规范化日期：空 = 今天；只接受真实存在的 `YYYY-MM-DD`，且不得晚于今天
 * （日记是"已经发生的事"，不允许预写未来）。
 */
export function normalizeDiaryDate(date, now = Date.now()) {
  const raw = String(date ?? '').trim();
  const today = localDateOf(now);
  if (raw === '') return today;
  if (!DIARY_DATE_RE.test(raw)) throw new Error('日期格式必须是 YYYY-MM-DD');
  const [y, m, d] = raw.split('-').map(Number);
  const t = new Date(y, m - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) throw new Error('日期不存在');
  if (raw > today) throw new Error('不能写未来的日记');
  return raw;
}

/**
 * 正文净化：统一换行、去掉控制字符、压掉过长的空行；顺手把明显的
 * 本机绝对路径与凭据形态替换掉（RULES 的红线：日记也不留这些）。
 */
export function sanitizeDiaryText(text, maxChars = MAX_ENTRY_CHARS) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // 本机路径：C:\xxx / D:/xxx / /home/xxx / /Users/xxx
  s = s.replace(/\b[A-Za-z]:[\\/][^\s，。、；：）)】」"'`]+/g, '（本机路径已隐去）');
  s = s.replace(/(?:^|[\s（(])(?:\/home|\/Users|\/root)\/[^\s，。、；：）)】」"'`]+/g, ' （本机路径已隐去）');
  // 凭据形态：token/secret/password/api key 后面跟值
  s = s.replace(/\b(token|password|passwd|secret|api[_-]?key)\s*[=:]\s*[^\s，。、；：）)]+/gi, '$1=（已隐去）');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  const trimmed = s.trim();
  if (maxChars > 0 && trimmed.length > maxChars) return trimmed.slice(0, maxChars);
  return trimmed;
}

function splitTags(tags) {
  const raw = Array.isArray(tags) ? tags : tags === undefined || tags === null ? [] : [tags];
  const out = [];
  for (const item of raw) {
    const t = String(item ?? '').trim().replace(/^#+/, '');
    if (!t) continue;
    if (t.length > MAX_TAG_CHARS) continue;
    if (out.length >= MAX_TAGS) break;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function countEntries(text) {
  return (text.match(/^## /gm) || []).length;
}

function composeEntry({ time, title, mood, tags, content }) {
  const head = `## ${time}${title ? ` · ${title}` : ''}`;
  const meta = [];
  if (mood) meta.push(`心情：${mood}`);
  if (tags.length) meta.push(`标签：${tags.join('、')}`);
  const lines = [head];
  if (meta.length) lines.push(`（${meta.join(' ｜ ')}）`);
  lines.push('', content);
  return lines.join('\n');
}

/**
 * 写一则日记。
 * @returns {{ok:true, key:string, date:string, time:string, entries:number, bytes:number, created:boolean}}
 */
export function writeDiaryEntry({ root, key, content, date, title, mood, tags, mode = 'append', now = Date.now() }) {
  const k = String(key ?? '').trim();
  if (!diaryKeyOk(k)) throw new Error('会话 key 非法：只接受 group:<群号> / private:<QQ号>');
  const day = normalizeDiaryDate(date, now);
  const body = sanitizeDiaryText(content, MAX_ENTRY_CHARS);
  if (!body) throw new Error('日记正文为空');
  const ttl = sanitizeDiaryText(title, MAX_TITLE_CHARS).replace(/\n+/g, ' ').trim();
  const md = sanitizeDiaryText(mood, MAX_MOOD_CHARS).replace(/\n+/g, ' ').trim();
  const tg = splitTags(tags);
  const dir = diaryDirOf(root, k);
  const file = diaryFilePath(root, k, day);
  fs.mkdirSync(dir, { recursive: true });

  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const entriesBefore = countEntries(previous);
  if (mode !== 'replace' && entriesBefore >= MAX_ENTRIES_PER_DAY) {
    throw new Error(`今天已经写了 ${MAX_ENTRIES_PER_DAY} 则，够了`);
  }
  const entry = composeEntry({ time: localTimeOf(now), title: ttl, mood: md, tags: tg, content: body });

  let next;
  if (mode === 'replace' || !previous) {
    next = `# ${day}\n\n${entry}\n`;
  } else {
    next = `${previous.replace(/\s*$/, '')}\n\n${entry}\n`;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, next, 'utf8');
  fs.renameSync(tmp, file);
  return {
    ok: true,
    key: k,
    date: day,
    time: localTimeOf(now),
    entries: countEntries(next),
    bytes: Buffer.byteLength(next, 'utf8'),
    created: !previous
  };
}

function previewOf(text) {
  const lines = text.split('\n');
  const lastHeader = lines.map((l, i) => (l.startsWith('## ') ? i : -1)).filter((i) => i >= 0).pop();
  const start = lastHeader === undefined ? 0 : lastHeader + 1;
  for (let i = start; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#') || l.startsWith('（')) continue;
    return l.length > 60 ? `${l.slice(0, 60)}…` : l;
  }
  return '';
}

/** 列出最近若干天的日记（新→旧）。 */
export function listDiaryEntries({ root, key, limit = 7, now = Date.now() }) {
  const k = String(key ?? '').trim();
  if (!diaryKeyOk(k)) throw new Error('会话 key 非法：只接受 group:<群号> / private:<QQ号>');
  const dir = diaryDirOf(root, k);
  const max = Math.min(Math.max(Number(limit) || 7, 1), 30);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  } catch {
    names = [];
  }
  names.sort().reverse();
  const items = [];
  for (const name of names.slice(0, max)) {
    const file = path.join(dir, name);
    let text = '';
    let stat = null;
    try {
      text = fs.readFileSync(file, 'utf8');
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    items.push({
      date: name.slice(0, 10),
      entries: countEntries(text),
      bytes: stat ? stat.size : Buffer.byteLength(text, 'utf8'),
      preview: previewOf(text)
    });
  }
  return {
    ok: true,
    key: k,
    folder: diaryFolderName(k),
    today: localDateOf(now),
    total: names.length,
    items
  };
}

/** 读某一天的日记全文（超长按 maxChars 截断并标记）。 */
export function readDiaryEntry({ root, key, date, maxChars = MAX_READ_CHARS, now = Date.now() }) {
  const k = String(key ?? '').trim();
  if (!diaryKeyOk(k)) throw new Error('会话 key 非法：只接受 group:<群号> / private:<QQ号>');
  const day = normalizeDiaryDate(date, now);
  const file = diaryFilePath(root, k, day);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, key: k, date: day, missing: true, error: `${day} 没有日记` };
  }
  const cap = Math.min(Math.max(Number(maxChars) || MAX_READ_CHARS, 500), MAX_READ_CHARS);
  const truncated = text.length > cap;
  return {
    ok: true,
    key: k,
    date: day,
    entries: countEntries(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated,
    text: truncated ? text.slice(0, cap) : text
  };
}

/** 该会话日记的汇总读数（控制台/工具列表用）。 */
export function diaryStatsOf({ root, key, now = Date.now() }) {
  const k = String(key ?? '').trim();
  if (!diaryKeyOk(k)) throw new Error('会话 key 非法：只接受 group:<群号> / private:<QQ号>');
  const dir = diaryDirOf(root, k);
  let days = 0;
  let entries = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
      days += 1;
      const file = path.join(dir, name);
      const text = fs.readFileSync(file, 'utf8');
      entries += countEntries(text);
      bytes += Buffer.byteLength(text, 'utf8');
    }
  } catch {}
  return { ok: true, key: k, folder: diaryFolderName(k), today: localDateOf(now), days, entries, bytes };
}
