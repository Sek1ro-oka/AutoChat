// Speech, part one: assembling the prompt and calling the model. Split out of
// engine.js (I-08) so that file stays inside the project's size ceiling —
// `Social` still offers every one of these as a method, delegated from there.
// This module holds no state of its own: each function receives an explicit
// dependency record, so everything it touches is named in its signature and
// nothing reaches back into the instance. Delivery (`deliver`) stays in
// engine.js: it is the only writer of the daily speech counter.

import { buildSocialRequest, withSlang } from './prompt.js';

// The group's confirmed slang table (Phase 4) rides along with the persona
// here; `slang` is optional, and without it the prompt is unchanged. Both the
// persona and the slang table are resolved for *this* group, so a group that
// pinned its own card or narrowed its vocabulary gets exactly that.
export function systemPromptFor({ config, personas, slang, stickers, log }, group = null) {
  let base = config.systemPrompt;
  if (personas) {
    try { base = personas.resolve(group); }
    catch { log('social_persona_failed'); }
  }
  base = withSlang(base, slang, { group });
  // The sticker library rides along here too: an unprompted member may drop a
  // sticker when it fits. Same block and hint as the answering path.
  if (stickers?.enabled()) {
    const block = stickers.block();
    if (block) base = `${base}\n\n${block}`;
    base = `${base}\n\n${stickers.hint()}`;
  }
  return base;
}

// Building the prompt (history, quoting, escaping) lives in prompt.js — it is
// about rendering untrusted group text, a different failure mode from the
// "should we speak at all" decisions engine.js makes.
export function socialRequestFor(memory, config, message, params, system, log = () => {}) {
  return buildSocialRequest({ memory, config, message, params, system, log });
}

export function sampleUsage({ ledger, config, now }, sessionKey, usage) {
  if (!ledger) return null;
  const trace = ledger.begin(sessionKey);
  return ledger.sample(trace, usage, config, now());
}

export async function speakFor(deps, message, send, alive, state) {
  const params = deps.params(message.group);
  let messages;
  try { messages = socialRequestFor(deps.memory, deps.config, message, params, systemPromptFor(deps, message.group), deps.log); }
  catch { deps.log('social_context_failed'); return false; }
  return deps.deliver(messages, message.group, send, alive, state, params);
}
