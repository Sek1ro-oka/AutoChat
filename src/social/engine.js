// Social simulation: the group member that decides for itself (V2 · Phase 3).
//
// Division of labour, copied from the one part of qq-bridge worth copying:
// **rules decide *when* to speak, the model decides *what* to say.** Deciding to
// stay silent costs nothing; only an actual utterance reaches the model, the
// budget ledger and the chat.
//
// The engine is a runtime participant (see src/runtime.js). It observes every
// group message — including its own, which it records itself because NapCat does
// not reliably echo self-sent messages — and it never answers a message that
// addresses the bot: that reply belongs to `Bot`, and two answers to one @ is
// exactly the kind of bug that makes a bot obvious.
//
// Every gate below (switch, mute, daily cap, cooldown, budget) is checked before
// the model is called, and the budget reservation is checked again atomically by
// `store.reserve` — speech shares the one daily ledger with Q&A.

import { budgetDay } from '../store.js';
import { costMicro, estimateInput, usageCost } from '../model.js';
import { containsTerm } from '../terms.js';
import { isRepeat, score } from './attention.js';
import { GroupMemory } from './memory.js';
import { parseSegments } from './quote.js';
import { buildSocialRequest, withSlang } from './prompt.js';
import { render } from './renderer.js';
import { ENERGY_BY_STATE, SIM_STATES, energyFor, requiredScore, transition } from './state.js';

// The state machine lives in state.js and the group memory in memory.js;
// re-exported so callers that only care about "the simulation" have one entry.
export { ENERGY_BY_STATE, SIM_STATES, energyFor, requiredScore, transition };

const ACTIVITY_WINDOW_MS = 120000;
const ENGAGE_WINDOW_MS = 180000;
const IGNORE_MS = 240000;
const RETREAT_MS = 900000;
// Handled by the answering path, not by the simulation (images, `search`, …).
const SILENCE_MARK = '不回';

export class Social {
  constructor({
    config, store, model, ledger = null, personas = null, slang = null, log = () => {},
    now = Date.now, random = Math.random, sleep = null,
  } = {}) {
    this.config = config;
    this.store = store;
    this.model = model;
    this.ledger = ledger;
    this.personas = personas;
    this.slang = slang;
    this.log = log;
    this.now = now;
    this.random = random;
    this.sleep = sleep ?? (ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()));
    this.memory = new GroupMemory({ store, ttlMs: config.socialMessageTtlMs, now: this.now });
    this.tails = new Map();          // group -> serialising promise
    this.decisions = new Map();      // group -> last decision (no message text)
  }

  // --- parameters (runtime-overridable from the console) ---------------------
  params() {
    const c = this.config;
    const num = (key, fallback) => {
      const raw = this.store.setting(key, null);
      const value = Number(raw);
      return raw !== null && Number.isFinite(value) ? value : fallback;
    };
    return {
      enabled: this.store.setting('social_enabled', c.socialEnabled ? '1' : '0') === '1',
      threshold: num('social_threshold', c.socialThreshold),
      cooldownMs: num('social_cooldown_seconds', c.socialCooldownSeconds) * 1000,
      dailyLimit: num('social_daily_limit', c.socialDailyLimit),
      contextMessages: c.socialContextMessages,
      maxChunks: c.socialMaxChunks,
      minDelayMs: c.socialMinDelayMs,
      maxDelayMs: c.socialMaxDelayMs,
    };
  }

  grouped() { return this.config.groupIds ?? [this.config.groupId]; }

  // Validate and persist a console edit. Unknown keys are ignored on purpose:
  // the endpoint takes a patch, not a replacement.
  setParams(patch = {}) {
    const bool = value => (typeof value === 'boolean' ? value : null);
    const within = (value, min, max) => (Number.isFinite(Number(value))
      && Number(value) >= min && Number(value) <= max ? Number(value) : null);
    if ('enabled' in patch) {
      const value = bool(patch.enabled);
      if (value === null) throw new Error('SOCIAL_PARAM_INVALID');
      this.store.set('social_enabled', value ? '1' : '0');
    }
    if ('threshold' in patch) {
      const value = within(patch.threshold, 0, 100);
      if (value === null) throw new Error('SOCIAL_PARAM_INVALID');
      this.store.set('social_threshold', String(value));
    }
    if ('cooldownSeconds' in patch) {
      const value = within(patch.cooldownSeconds, 5, 3600);
      if (value === null) throw new Error('SOCIAL_PARAM_INVALID');
      this.store.set('social_cooldown_seconds', String(Math.round(value)));
    }
    if ('dailyLimit' in patch) {
      const value = within(patch.dailyLimit, 1, 500);
      if (value === null) throw new Error('SOCIAL_PARAM_INVALID');
      this.store.set('social_daily_limit', String(Math.round(value)));
    }
    if (patch.group !== undefined) {
      const group = String(patch.group);
      if (!this.grouped().includes(group)) throw new Error('SOCIAL_PARAM_INVALID');
      const muted = bool(patch.muted);
      if (muted === null) throw new Error('SOCIAL_PARAM_INVALID');
      this.store.set(`social_mute:${group}`, muted ? '1' : '0');
    }
    this.log('social_params_changed');
    return this.describe();
  }

  referencesBot(group, message) {
    if (message.mentions.includes(this.config.botId)) return true;
    if (this.memory.isBotLine(group, message.replyId)) return true;
    return this.botNames().some(name => name && message.text.includes(name));
  }

  botNames() {
    const names = [this.config.botName, ...(this.config.botNicknames ?? [])].filter(Boolean);
    return names;
  }

  hour() {
    return new Date(this.now() + 8 * 3600000).getUTCHours();
  }

  // --- event intake ---------------------------------------------------------
  parse(event) {
    const c = this.config;
    if (!event || event.post_type !== 'message' || event.message_type !== 'group') return null;
    if (String(event.self_id) !== c.botId) return null;
    if (!Array.isArray(event.message) || event.message_id == null) return null;
    const group = String(event.group_id);
    if (!this.grouped().includes(group)) return null;
    const user = String(event.user_id);
    if (!/^\d+$/.test(user)) return null;
    const now = this.now();
    if (!Number.isFinite(event.time) || Math.abs(now / 1000 - event.time) > 300) return null;
    const parsed = parseSegments(event.message);
    return {
      id: String(event.message_id), group, user, at: event.time * 1000,
      text: parsed.text, mentions: parsed.mentions, replyId: parsed.replyId,
      hasImage: parsed.hasImage, fromBot: user === c.botId,
    };
  }

  observe(event, send, alive) {
    if (!this.params().enabled) return Promise.resolve(false);
    const message = this.parse(event);
    if (!message) return Promise.resolve(false);
    this.memory.remember(message);
    if (message.fromBot) return Promise.resolve(false);
    // Chat content stays out of SQLite unless the simulation is on: the ledger
    // exists for scoring, dedupe and slang learning, not for archiving.
    this.store.noteMessage({
      groupId: message.group, messageId: message.id, userId: message.user,
      at: message.at, text: message.text, kind: message.hasImage ? 'image' : 'text',
    });
    const isAlive = typeof alive === 'function' ? alive : () => true;
    return this.serialise(message.group, () => this.consider(message, send, isAlive));
  }

  // One decision at a time per group: two answers to the same burst would be the
  // most visible way to look like a machine.
  serialise(group, task) {
    const previous = this.tails.get(group) ?? Promise.resolve();
    const job = previous.then(task).catch(error => { this.log('social_failed'); return false; });
    const tracked = job.finally(() => { if (this.tails.get(group) === tracked) this.tails.delete(group); });
    this.tails.set(group, tracked);
    return tracked;
  }

  async drain() { await Promise.allSettled([...this.tails.values()]); }

  // --- decision -------------------------------------------------------------
  // Lazy state advance: no timers, no background loop. When a message arrives we
  // first ask "how long has it been?", then "did it react to us?".
  advance(group, stored, message, now) {
    let state = SIM_STATES.includes(stored?.state) ? stored.state : 'observing';
    const lastSpokeAt = stored?.last_spoke_at ?? null;
    const idle = lastSpokeAt ? Math.max(0, now - lastSpokeAt) : 0;
    if (state === 'probing' && lastSpokeAt && idle > IGNORE_MS) state = transition(state, 'ignored');
    if (state === 'retreating' && lastSpokeAt && idle > RETREAT_MS) state = transition(state, 'cooled');
    if (lastSpokeAt && idle <= ENGAGE_WINDOW_MS && state !== 'observing' && this.referencesBot(group, message)) {
      state = transition(state, 'engaged');
    }
    return { state, lastSpokeAt, energy: energyFor(state, idle) };
  }

  gate(message, state, params, now) {
    if (this.store.setting('enabled', '1') !== '1') return 'disabled';
    if (this.store.setting('groupEnabled', '1') !== '1') return 'group_off';
    if (this.store.setting(`social_mute:${message.group}`, '0') === '1') return 'muted';
    if (message.hasImage) return 'image';
    if (!message.text) return 'empty';
    if (this.blocked(message.text)) return 'blocked';
    if (this.spokeToday(message.group, budgetDay(now)) >= params.dailyLimit) return 'daily_limit';
    if (state.lastSpokeAt && now - state.lastSpokeAt < params.cooldownMs) return 'cooldown';
    const remaining = this.store.balance(budgetDay(now), this.config.budgetMicro).remaining;
    if (remaining < this.minReserve()) return 'budget';
    return null;
  }

  // Cheap lower bound used only to avoid a pointless model attempt; `reserve`
  // below is the authority and can still refuse.
  minReserve() {
    return costMicro(1024, Math.min(this.config.maxOutput, 256), this.config);
  }

  spokeToday(group, day) {
    return Number(this.store.setting(`social_count:${day}:${group}`, '0')) || 0;
  }

  blocked(text) { return containsTerm(text, this.config.blockTerms); }

  record(group, decision) { this.decisions.set(group, decision); }

  async consider(message, send, alive) {
    const params = this.params();
    const now = this.now();
    const state = this.advance(message.group, this.store.getSimState(message.group), message, now);
    const hour = this.hour();
    const ring = this.memory.ring(message.group);
    const recentBotTexts = this.memory.botTexts(message.group, 5);
    const activity = ring.filter(entry => now - entry.at <= ACTIVITY_WINDOW_MS).length;
    const scored = score({
      text: message.text,
      mentionedBot: message.mentions.includes(this.config.botId),
      repliesBot: this.memory.isBotLine(message.group, message.replyId),
      mentionsOthers: message.mentions.some(qq => qq !== this.config.botId),
      activity, hour, botNames: this.botNames(), recentBotTexts,
    });

    // An @ is an obligation, and the obligation is already being met by `Bot`.
    // Recording it as engagement keeps the state machine honest without a second
    // answer.
    if (scored.force) {
      const engaged = { state: 'active', lastSpokeAt: state.lastSpokeAt, energy: ENERGY_BY_STATE.active };
      this.store.saveSimState({ groupId: message.group, ...engaged, updated: now });
      this.record(message.group, { at: now, speak: false, reason: 'addressed_by_core', score: scored.score, need: null, reasons: scored.reasons });
      return false;
    }

    const gate = this.gate(message, state, params, now);
    const need = requiredScore({ threshold: params.threshold, state: state.state, energy: state.energy });
    const passes = scored.score >= need;
    const reason = gate ?? (passes ? 'scored' : 'below_threshold');
    this.record(message.group, { at: now, speak: !gate && passes, reason, score: scored.score, need, reasons: scored.reasons });
    this.store.saveSimState({
      groupId: message.group, state: state.state,
      lastSpokeAt: state.lastSpokeAt, energy: state.energy, updated: now,
    });
    if (gate || !passes) { this.log('social_skipped'); return false; }
    return this.speak(message, send, alive, state);
  }

  // --- speech ---------------------------------------------------------------
  // The group's confirmed slang table (Phase 4) rides along with the persona
  // here; `slang` is optional, and without it the prompt is unchanged.
  systemPrompt() {
    let base = this.config.systemPrompt;
    if (this.personas) {
      try { base = this.personas.resolve(); }
      catch { this.log('social_persona_failed'); }
    }
    return withSlang(base, this.slang);
  }

  // Building the prompt (history, quoting, escaping) lives in prompt.js — it is
  // about rendering untrusted group text, a different failure mode from the
  // "should we speak at all" decisions this file makes.
  request(message, params) {
    return buildSocialRequest({
      memory: this.memory, config: this.config, message, params, system: this.systemPrompt(),
    });
  }

  sample(sessionKey, usage) {
    if (!this.ledger) return null;
    const trace = this.ledger.begin(sessionKey);
    return this.ledger.sample(trace, usage, this.config, this.now());
  }

  async speak(message, send, alive, state) {
    const params = this.params();
    const sessionKey = `social:group:${message.group}`;
    let messages;
    try { messages = this.request(message, params); }
    catch { this.log('social_context_failed'); return false; }
    const day = budgetDay(this.now());
    const estimate = costMicro(estimateInput(messages), this.config.maxOutput, this.config);
    const reservation = this.store.reserve(day, estimate, this.config.budgetMicro, this.now(), { sessionKey });
    if (!reservation) { this.log('social_budget_blocked'); return false; }

    // Reaction time. Bounded by config, and shutdown waits for it (see drain()).
    await this.sleep(params.minDelayMs + this.random() * Math.max(0, params.maxDelayMs - params.minDelayMs));
    if (!alive()) { this.store.settle(reservation, 0); return false; }

    let result;
    try { result = await this.model.complete(messages); }
    catch {
      this.store.uncertain(reservation);
      this.log('social_model_failed');
      return false;
    }
    const actual = usageCost(result.usage, this.config);
    if (actual === null) this.store.uncertain(reservation);
    else { this.store.settle(reservation, actual); this.sample(sessionKey, result.usage); }

    const text = String(result.text ?? '').trim();
    if (!text || text === SILENCE_MARK) { this.log('social_declined'); return false; }
    if (this.blocked(text)) { this.log('social_blocked'); return false; }
    const { chunks, delays } = render(text, {
      max: params.maxChunks, random: this.random,
      minDelayMs: params.minDelayMs, maxDelayMs: params.maxDelayMs,
    });
    if (!chunks.length) { this.log('social_empty'); return false; }
    const recentBotTexts = this.memory.botTexts(message.group, 3);
    if (isRepeat(chunks.join(''), recentBotTexts)) { this.log('social_repeat'); return false; }

    let sent = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await this.sleep(delays[index]);
      if (!alive()) break;
      let response = null;
      try {
        response = await send('send_group_msg', {
          group_id: Number(message.group), message: [{ type: 'text', data: { text: chunks[index] } }],
        });
      } catch { this.log('social_send_failed'); break; }
      sent += 1;
      this.memory.remember({
        id: response?.message_id === undefined || response?.message_id === null ? null : String(response.message_id),
        group: message.group, user: this.config.botId, at: this.now(), text: chunks[index], fromBot: true,
      });
    }
    if (!sent) return false;

    this.store.set(`social_count:${day}:${message.group}`, this.spokeToday(message.group, day) + 1);
    const next = transition(state.state, 'spoke');
    this.store.saveSimState({
      groupId: message.group, state: next, lastSpokeAt: this.now(),
      energy: ENERGY_BY_STATE[next], updated: this.now(),
    });
    this.log('social_spoke');
    return true;
  }

  // --- console view ---------------------------------------------------------
  // Never includes chat text: the console shows counts, states and reasons only
  // (see docs/console.md, rule 6).
  describe({ now = this.now() } = {}) {
    const params = this.params();
    const day = budgetDay(now);
    const states = new Map(this.store.listSimStates().map(row => [row.group_id, row]));
    const groups = this.grouped().map(id => {
      const row = states.get(id);
      const state = SIM_STATES.includes(row?.state) ? row.state : 'observing';
      const lastSpokeAt = row?.last_spoke_at ?? null;
      const idle = lastSpokeAt ? Math.max(0, now - lastSpokeAt) : null;
      const decision = this.decisions.get(id) ?? null;
      return {
        id, state, energy: energyFor(state, idle ?? 0), lastSpokeAt, idleMs: idle,
        spokeToday: this.spokeToday(id, day), dailyLimit: params.dailyLimit,
        muted: this.store.setting(`social_mute:${id}`, '0') === '1',
        activity: this.memory.ring(id).filter(entry => now - entry.at <= ACTIVITY_WINDOW_MS).length,
        required: requiredScore({ threshold: params.threshold, state, energy: energyFor(state, idle ?? 0) }),
        decision,
      };
    });
    return {
      enabled: params.enabled,
      gate: { core: this.store.setting('enabled', '1') === '1', group: this.store.setting('groupEnabled', '1') === '1' },
      params: {
        threshold: params.threshold, cooldownSeconds: Math.round(params.cooldownMs / 1000),
        dailyLimit: params.dailyLimit,
      },
      defaults: {
        enabled: Boolean(this.config.socialEnabled), threshold: this.config.socialThreshold,
        cooldownSeconds: this.config.socialCooldownSeconds, dailyLimit: this.config.socialDailyLimit,
        contextMessages: this.config.socialContextMessages, maxChunks: this.config.socialMaxChunks,
        minDelayMs: this.config.socialMinDelayMs, maxDelayMs: this.config.socialMaxDelayMs,
        messageTtlHours: Math.round(this.config.socialMessageTtlMs / 3600000),
      },
      today: { day, spoke: groups.reduce((total, group) => total + group.spokeToday, 0) },
      groups,
    };
  }

  maintain() {
    return this.store.pruneMessages(this.now() - this.config.socialMessageTtlMs);
  }
}
