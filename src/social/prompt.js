// What the simulation actually sends to the model.
//
// Kept apart from the decision logic in engine.js because these two questions
// have different failure modes: "should we speak" is about rules, budget and
// timing, while "what do we send" is about rendering an untrusted group log into
// a prompt. Splitting them also keeps engine.js inside the project's size ceiling.
//
// Two invariants, carried over from Phase 3 and enforced here:
//   * QQ numbers never enter a prompt — members are relabelled by the caller;
//   * every piece of group text is flattened and escaped before it is embedded,
//     so a member cannot forge our structure markers or inject instructions.

import { escapeForPrompt, formatQuote } from './quote.js';

// Append the group's confirmed slang table to a system prompt. Both prompt
// callers (the answering path and the simulation) use this one implementation
// instead of each writing the same concat; `grouped` is false for a private
// chat, which has no group vocabulary. `group` narrows the table to the terms
// that apply to this group — a term scoped to another group is left out (see
// docs/slang.md). Absent the module the prompt is byte-for-byte what it was
// before Phase 4.
export function withSlang(base, slang, { grouped = true, group = null } = {}) {
  if (!grouped || !slang) return base;
  const block = slang.block({ group });
  return block ? `${base}\n\n${block}` : base;
}

// The behaviour protocol from `personas/behavior.md` says what kind of member
// this is; this addendum says what *this* call is: one line in a live chat.
export const SOCIAL_ADDENDUM = [
  '你正在一个 QQ 群里，收到的是一段群聊记录。请判断是否值得参与。',
  '只输出你要发送的聊天内容本身：不要称呼自己、不要解释、不要 markdown、不要括号动作、不要写旁白。',
  '一次最多 2~3 句短句，总共不超过 60 字，像在手机上打字。',
  '不要重复你刚才说过的话；不确定、无话可说、或插不上嘴时，只输出两个字：不回。',
].join('\n');

export function buildSocialRequest({ memory, config, message, params, system }) {
  // The current message is shown on its own line, so drop its ring copy.
  const history = memory.ring(message.group)
    .filter(entry => entry.id !== message.id)
    .slice(-params.contextMessages);
  const name = user => (user === config.botId ? '你' : memory.label(message.group, user));
  const parts = [
    '[群聊记录开始]',
    ...history.map(entry => `${entry.bot ? '你' : name(entry.user)}：${escapeForPrompt(entry.text, 160)}`),
    '[群聊记录结束]',
  ];
  if (message.replyId) {
    const quoted = memory.lookup(message.group, message.replyId);
    parts.push(quoted
      ? formatQuote({ name: name(quoted.user), text: quoted.text })
      : '[引用 一条更早的消息]');
  }
  parts.push(`[当前这条消息] ${name(message.user)}：${escapeForPrompt(message.text, 200)}`);
  parts.push('请只输出你要发送的内容，或只输出「不回」。');
  return [
    { role: 'system', content: `${system}\n\n${SOCIAL_ADDENDUM}` },
    { role: 'user', content: parts.join('\n') },
  ];
}

// The idle-initiated variant (Phase 6): nobody has spoken for a while, so there
// is no "current message" to react to. The prompt asks the model to break the
// silence instead. History and escaping rules are identical to buildSocialRequest.
export function buildIdleRequest({ memory, config, group, params, system, idleMinutes }) {
  const history = memory.ring(group).slice(-params.contextMessages);
  const name = user => (user === config.botId ? '你' : memory.label(group, user));
  const parts = [
    '[群聊记录开始]',
    ...history.map(entry => `${entry.bot ? '你' : name(entry.user)}：${escapeForPrompt(entry.text, 160)}`),
    '[群聊记录结束]',
  ];
  parts.push(`群里已经安静了约 ${idleMinutes} 分钟。你想主动冒个泡说点什么，别让气氛冷下去。`);
  parts.push('请只输出你要发送的内容，或只输出「不回」。');
  return [
    { role: 'system', content: `${system}\n\n${SOCIAL_ADDENDUM}` },
    { role: 'user', content: parts.join('\n') },
  ];
}
