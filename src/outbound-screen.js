// The outbound shape gate (I-06 · A-06): the last point where a message is
// still a value instead of bytes on a socket.
//
// One chokepoint (`OneBot.call`) sees every outbound action — social speech,
// pokes, the Q&A path — so the policy lives here and the transport only applies
// it. Three dispositions, none of them silent:
//
//   L1 mask  (groups only)  local paths, URLs, very long digit runs → head…tail
//   L2 block (everywhere)   the five provider-prefixed credential shapes → fixed sentence
//   L3 log   (everywhere)   generic "key = value" at high entropy → sent as is
//
// L2 never drops the message *silently*: a vanished reply is indistinguishable
// from the simulation's own `SILENCE_MARK` ("不回", engine.js:32), so an operator
// would read a screening failure as a personality trait (research §2.5). It
// substitutes the sentence below and says so in the log.
//
// Why the gitleaks allowlists are here rather than on the prefix rules: a chat
// line like "token 过期了" or "api_id=123" must not be treated as a secret, and
// those are shapes only the *generic* rule can even see. Applying the word-only
// allowlist to the five prefix rules would whitelist every GitHub PAT
// (`ghp_…` is `[a-zA-Z_.-]+`), which is the one thing the acceptance list
// requires to be blocked.

const TEXT_ACTIONS = new Set(['send_group_msg', 'send_private_msg', 'send_msg']);

export const BLOCKED_SENTENCE = '这条消息包含疑似密钥，已拦截。';

// gitleaks' provider-prefix rules, copied verbatim (research §2.3). Not
// tightened and not anchored further: a false negative here is a leaked key.
const SECRET_RULES = [
  ['aws_access_key_id', /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/],
  ['gcp_api_key', /\b(AIza[\w-]{35})(?:[\x60'"\s;]|\\[nr]|$)/],
  ['github_pat', /ghp_[0-9a-zA-Z]{36}/],
  ['github_fine_grained_pat', /github_pat_\w{82}/],
  ['slack_token', /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/],
];

// L1: things that are routine in a group but should not be published verbatim.
// The digit floor is 16 so QQ numbers (5–11) and 13-digit millisecond stamps
// stay readable (research §2.4); a 19-digit snowflake or a card number still
// gets clipped.
const STOP = `\\s，。；：、！？（）「」《》"'…`;
const GROUP_MASKS = [
  ['windows_path', new RegExp(`[A-Za-z]:\\\\[^${STOP}]*`, 'g')],
  ['unc_path', new RegExp(`\\\\\\\\[^${STOP}]*`, 'g')],
  ['url', new RegExp(`https?://[^${STOP}]+`, 'g')],
  ['long_digits', /\d{16,}/g],
];

// L3: gitleaks' generic-api-key rule, same keyword list and same gate.
const GENERIC_KEY =
  /[\w.-]{0,50}?(?:access|auth|api|credential|creds|key|password|passwd|secret|token)[ \t\w.-]{0,20}[\s'"]{0,3}(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}([\w.=-]{10,150})/i;

// The two allowlists, straight from gitleaks: values that are just words, keys
// that merely *contain* a secret-ish word (`api_id`, `csrf_token`, …), and the
// stopword list of placeholder values ("000000", "changeme", …).
const WORD_ONLY = /^[a-zA-Z_.-]+$/;
const GENERIC_KEYS = ['api_id', 'api_name', 'access_id', 'credentials_id', 'bucket_key', 'secret_length', 'csrf_token'];
const STOPWORDS = ['000000', '123456', '1234567', 'abcdef', 'xxxxxx', '******', 'changeme', 'example', 'password', 'sample', 'secret', 'test', 'token'];

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / value.length) * Math.log2(count / value.length);
  return bits;
}

function findSecret(text) {
  for (const [name, re] of SECRET_RULES) if (re.test(text)) return name;
  return null;
}

function findGeneric(text) {
  const match = GENERIC_KEY.exec(text);
  if (!match) return null;
  const value = match[1];
  const whole = match[0].toLowerCase();
  if (WORD_ONLY.test(value)) return null;
  if (STOPWORDS.includes(value.toLowerCase())) return null;
  if (GENERIC_KEYS.some(key => whole.includes(key))) return null;
  return entropy(value) >= 3.5 ? 'generic_secret' : null;
}

// First 4 + last 4, middle elided. Short matches collapse to the ellipsis.
function maskText(text) {
  let rule = null;
  let out = text;
  for (const [name, re] of GROUP_MASKS) {
    out = out.replace(re, match => {
      rule ??= name;
      return match.length <= 8 ? '…' : `${match.slice(0, 4)}…${match.slice(-4)}`;
    });
  }
  return { text: out, rule };
}

// One text run, in disposition order: a key never gets masked into invisibility
// before it is recognised, and a blocked run is never re-scanned.
function screenText(text, inGroup, state) {
  const secret = findSecret(text);
  if (secret) {
    state.verdict = 'block';
    state.reason = secret;
    return BLOCKED_SENTENCE;
  }
  const masked = inGroup ? maskText(text) : { text, rule: null };
  if (masked.rule && state.verdict === 'pass') {
    state.verdict = 'mask';
    state.reason = masked.rule;
  }
  if (state.verdict === 'pass' && findGeneric(masked.text)) state.reason = 'generic_secret';
  return masked.text;
}

/**
 * Screen one outbound action. Never throws, never returns null: on anything it
 * does not recognise it hands the caller back exactly what it was given.
 *
 * @returns {{ params: object, verdict: 'pass'|'mask'|'block', reason: string|null }}
 */
export function screenOutbound(action, params) {
  if (!TEXT_ACTIONS.has(action) || !params || typeof params !== 'object' || params.message == null) {
    return { params, verdict: 'pass', reason: null };
  }
  const inGroup = params.group_id !== undefined && params.group_id !== null;
  const state = { verdict: 'pass', reason: null };
  if (typeof params.message === 'string') {
    return { params: { ...params, message: screenText(params.message, inGroup, state) }, ...state };
  }
  if (!Array.isArray(params.message)) return { params, verdict: 'pass', reason: null };
  const message = params.message.map(segment => {
    if (!segment || segment.type !== 'text' || typeof segment.data?.text !== 'string') return segment;
    const text = screenText(segment.data.text, inGroup, state);
    return text === segment.data.text ? segment : { ...segment, data: { ...segment.data, text } };
  });
  return { params: { ...params, message }, ...state };
}
