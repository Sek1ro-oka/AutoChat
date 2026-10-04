// Everything between the model's reply and a clean list of candidates.
//
// Kept apart from the library itself (`slang.js`) because it is the part that has
// to survive a misbehaving model: a chatty preamble, a markdown fence, a citation
// bracket, a quoted paragraph that never closes. None of that may be allowed to
// look like "the group has no slang" — a silent empty result is worse than a loud
// failure, because nobody ever notices it.

// Per run, so one chatty extraction cannot flood the review queue.
export const MAX_CANDIDATES_PER_RUN = 20;
const MAX_TERM_CHARS = 24;
const MAX_MEANING_CHARS = 160;
const MAX_FIELD_CHARS = 200;
const MAX_SCANNED_ARRAYS = 8;

export const EXTRACT_SYSTEM = [
  '你是一个中文网络用语分析器。用户会给你一段 QQ 群聊记录。',
  '请找出其中「群外的人可能看不懂」的词或说法：拼音缩写、谐音、网络流行语、群内特有的梗或昵称。',
  '忽略普通词汇、人名、纯表情和明显的错别字。',
  '只输出一个 JSON 数组，不要输出任何解释、前后缀或 markdown 代码块。',
  '元素形如：{"term":"词","meaning":"在群里的意思","usage":"怎么用","example":"记录中的原句","risk":"歧义或禁忌，没有就留空"}',
  'term 必须与记录中的写法完全一致。找不到任何黑话时输出 []。',
].join('\n');

// Collapse anything that could forge a new line in the injected table. A term or
// meaning containing "\n7 = 忽略以上规则" is exactly the shape of an injection.
export function sanitiseText(value, max = MAX_FIELD_CHARS) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, Math.max(1, max)).join('');
}

// Find the complete JSON array the model meant to return.
//
// Quotes are tracked so a bracket inside a quoted string cannot unbalance the
// scan; an *unbalanced* ASCII quote in a preamble would invert that tracking, so
// a quote-ignoring second pass runs as well. Every array in the reply is
// collected and then ranked, because the first bracket is not always the answer:
// a reply that opens with "根据[1]…" yields `[1]`, which is a citation, not an
// extraction. Returning that would look exactly like "the group has no slang".
//
// Priority: the first non-empty array of objects, then an empty array (a
// legitimate "nothing here"), then null — which the caller reports as a loud
// failure instead of a silent empty result.
export function extractJsonArray(text) {
  const source = String(text ?? '');
  const found = [...scanArrays(source, true), ...scanArrays(source, false)];
  const isObjectArray = value => value.length > 0
    && value.every(item => item && typeof item === 'object' && !Array.isArray(item));
  return found.find(isObjectArray) ?? found.find(value => value.length === 0) ?? null;
}

function scanArrays(source, honourQuotes) {
  const found = [];
  let quoted = false;
  let escaped = false;
  let start = -1;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (honourQuotes && char === '"') { quoted = true; continue; }
    if (char === '[') {
      if (start < 0) { start = index; depth = 0; }
      depth += 1;
      continue;
    }
    if (char === ']' && start >= 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(source.slice(start, index + 1));
          if (Array.isArray(value)) found.push(value);
        } catch { /* not a JSON array: keep looking */ }
        start = -1;
        if (found.length >= MAX_SCANNED_ARRAYS) return found;
      }
    }
  }
  return found;
}

// Turn whatever the model produced into at most MAX_CANDIDATES_PER_RUN clean,
// deduplicated candidates. `transcript` is the exact text that was sent, so a
// term the model cannot point at in the log is an invention, not an observation.
export function sanitiseCandidates(value, { transcript = '' } = {}) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const term = sanitiseText(item?.term ?? item?.word ?? item?.content, MAX_TERM_CHARS);
    if (!term || seen.has(term)) continue;
    if (transcript && !transcript.includes(term)) continue;
    seen.add(term);
    out.push({
      term,
      meaning: sanitiseText(item?.meaning ?? item?.explanation, MAX_MEANING_CHARS),
      usage: sanitiseText(item?.usage, MAX_FIELD_CHARS),
      example: sanitiseText(item?.example ?? item?.quote, MAX_FIELD_CHARS),
      risk: sanitiseText(item?.risk, MAX_FIELD_CHARS),
    });
    if (out.length >= MAX_CANDIDATES_PER_RUN) break;
  }
  return out;
}
