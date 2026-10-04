// OneBot message parsing, prompt escaping and quote formatting (V2 · Phase 3).
//
// Group text is UNTRUSTED. Two rules follow from that and are enforced here:
//
//   1. every piece of group text is flattened and neutralised before it reaches
//      a prompt, so a member cannot smuggle an instruction ("忽略以上规则…")
//      into the model, nor forge one of our own `[引用 …]` markers;
//   2. a quote is rendered as data — `[引用 某人：原文]` — never as a directive.
//
// The module is deliberately pure: no clock, no store, no socket.

// C0 controls except tab/newline; they only exist to confuse a reader or a model.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BRACKET_RE = /[[\]]/g;
const BRACKET_MAP = { '[': '【', ']': '】' };

export const MAX_TEXT_CHARS = 400;
export const MAX_QUOTE_CHARS = 120;
export const MAX_NAME_CHARS = 24;

// Flatten to a single line, drop control characters, cap the length, and swap
// square brackets for their fullwidth twins so group text can never imitate the
// structured markers we add ourselves.
export function escapeForPrompt(text, limit = MAX_TEXT_CHARS) {
  const flat = String(text ?? '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  const cut = Array.from(flat).slice(0, Math.max(0, limit)).join('');
  return cut.replace(BRACKET_RE, match => BRACKET_MAP[match]);
}

// OneBot v11 message segment array -> the few fields the simulation needs.
// Unknown segment types are counted, never interpreted.
export function parseSegments(message) {
  const text = [];
  const mentions = [];
  let replyId = null;
  let hasImage = false;
  let hasOther = false;
  for (const item of Array.isArray(message) ? message : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.data?.text === 'string') { text.push(item.data.text); continue; }
    if (item.type === 'at') {
      const qq = String(item.data?.qq ?? '');
      if (/^\d+$/.test(qq)) mentions.push(qq);
      continue;
    }
    if (item.type === 'reply') {
      const id = item.data?.id;
      if (id !== null && id !== undefined && id !== '') replyId = String(id);
      continue;
    }
    if (item.type === 'image') { hasImage = true; continue; }
    if (item.type === 'face' || item.type === 'mface') continue;
    hasOther = true;
  }
  return { text: text.join('').trim(), mentions, replyId, hasImage, hasOther };
}

// `[引用 群友1：原文]`. The punctuation is the fullwidth colon so a member
// cannot type an identical-looking ASCII sequence and have it read as ours.
export function formatQuote({ name = '', text = '' } = {}) {
  const who = escapeForPrompt(name || '某条消息', MAX_NAME_CHARS);
  const body = escapeForPrompt(text, MAX_QUOTE_CHARS);
  return body ? `[引用 ${who}：${body}]` : `[引用 ${who}的消息]`;
}
