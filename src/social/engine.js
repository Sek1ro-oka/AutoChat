// Social simulation: the group member that decides for itself (V2 · Phase 3).
// Rules decide *when* to speak, the model decides *what* to say — silence costs
// nothing; only an utterance reaches the model, the ledger and the chat.
// It observes every group message (its own included, recorded because NapCat
// does not echo self-sent reliably) but never answers one that addresses the
// bot: that reply belongs to `Bot`. Every gate (switch, mute, daily cap,
// cooldown, budget) is checked before the model is called, and `store.reserve`
// checks it again atomically — speech shares one daily ledger with Q&A.

import { budgetDay } from '../store.js';
import { costMicro, estimateInput, usageCost } from '../model.js';
import { isRepeat, score } from './attention.js';
import { blockedFor, gateFor, minReserveFor, spokeTodayFor } from './gates.js';
import { GroupMemory } from './memory.js';
import { applyParams, resolveParams } from './params.js';
import { parseSegments } from './quote.js';
import { render } from './renderer.js';
import { sampleUsage, socialRequestFor, speakFor, systemPromptFor } from './speech.js';
import { ENERGY_BY_STATE, SIM_STATES, energyFor, requiredScore, transition } from './state.js';
import { describeFor } from './view.js';
import { IdleSpeech } from './idle.js';
import { errorDetail } from '../logger.js';

// state.js's state machine is re-exported so "the simulation" has one entry.
export { ENERGY_BY_STATE, SIM_STATES, energyFor, requiredScore, transition };

const ACTIVITY_WINDOW_MS = 120000;
const ENGAGE_WINDOW_MS = 180000;
const IGNORE_MS = 240000;
const RETREAT_MS = 900000;
// Handled by the answering path, not by the simulation (images, `search`, …).
const SILENCE_MARK = '不回';

export class Social extends IdleSpeech {
  constructor({
    config, store, model, ledger = null, personas = null, slang = null, stickers = null, log = () => {},
    now = Date.now, random = Math.random, sleep = null,
  } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.model = model;
    this.ledger = ledger;
    this.personas = personas;
    this.slang = slang;
    this.stickers = stickers;
    this.log = log;
    this.now = now;
    this.random = random;
    this.sleep = sleep ?? (ms => (ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()));
    this.memory = new GroupMemory({ store, ttlMs: config.socialMessageTtlMs, now: this.now });
    this.tails = new Map();          // group -> serialising promise
    this.decisions = new Map();      // group -> last decision (no message text)
    this.idleRunning = false;        // re-entrancy guard for the idle timer
  }

  // --- parameters (runtime-overridable from the console) ---------------------
  // Resolution lives in params.js; with no group it returns the global view.
  params(group = null) { return resolveParams(this.store, this.config, group); }

  grouped() { return this.config.groupIds ?? [this.config.groupId]; }

  // Persist a console edit. Without `group` the global rows are written; with it,
  // that group's overrides. `null` clears the layer ("inherit again").
  setParams(patch = {}) {
    const { group, ...rest } = patch;
    if (group === undefined) {
      applyParams({ store: this.store, config: this.config, patch: rest, log: this.log });
    } else {
      const scoped = String(group);
      if (!this.grouped().includes(scoped)) throw new Error('SOCIAL_PARAM_INVALID');
      if ('muted' in rest) {
        if (typeof rest.muted !== 'boolean') throw new Error('SOCIAL_PARAM_INVALID');
        this.store.set(`social_mute:${scoped}`, rest.muted ? '1' : '0');
      }
      const { muted, ...numbers } = rest;
      applyParams({ store: this.store, config: this.config, group: scoped, patch: numbers, log: this.log });
    }
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
    // Parse first: the enable switch is per group (see params.js), so it can
    // only be read once the group is known. Still before anything is written —
    // a group with the simulation off stores nothing.
    const message = this.parse(event);
    if (!message) return Promise.resolve(false);
    if (!this.params(message.group).enabled) return Promise.resolve(false);
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
    const job = previous.then(task).catch(error => { this.log('social_failed', errorDetail(error)); return false; });
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

  // --- "may we speak?" ------------------------------------------------------
  // The gates and their lower-bound helpers live in gates.js; they read the
  // store and config through these, and the model is never called if one fails.
  gate(message, state, params, now) { return gateFor(this.store, this.config, message, state, params, now); }

  minReserve() { return minReserveFor(this.config); }

  spokeToday(group, day) { return spokeTodayFor(this.store, group, day); }

  blocked(text) { return blockedFor(this.config, text); }

  record(group, decision) { this.decisions.set(group, decision); }

  async consider(message, send, alive) {
    const params = this.params(message.group);
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
  // Prompt assembly and the model call live in speech.js (every one of them
  // still a method here). They take one explicit record, built below, so nothing
  // in that module reaches back into this instance.
  speech() {
    return {
      config: this.config, ledger: this.ledger, personas: this.personas, slang: this.slang,
      stickers: this.stickers, log: this.log, memory: this.memory, now: this.now,
      params: group => this.params(group),
      deliver: (messages, group, send, alive, state, params) => this.deliver(messages, group, send, alive, state, params),
    };
  }

  systemPrompt(group = null) { return systemPromptFor(this.speech(), group); }

  request(message, params) {
    const deps = this.speech();
    return socialRequestFor(deps.memory, deps.config, message, params, systemPromptFor(deps, message.group));
  }

  sample(sessionKey, usage) { return sampleUsage(this.speech(), sessionKey, usage); }

  async speak(message, send, alive, state) { return speakFor(this.speech(), message, send, alive, state); }

  // Everything after the prompt — budget, model call, marker stripping, render,
  // send, record — is identical whether speech was provoked by a message or by
  // silence, so both paths share it. `group` (not a message) is the target.
  // It stays here: it is the only writer of the daily speech counter.
  async deliver(messages, group, send, alive, state, params) {
    const sessionKey = `social:group:${group}`;
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

    let raw = String(result.text ?? ''); let stickerIds = [];
    if (this.stickers?.enabled()) {
      const parsed = this.stickers.parseMarkers(raw);
      raw = parsed.text; stickerIds = parsed.ids;
    }
    const text = raw.trim();
    if (text === SILENCE_MARK || (!text && !stickerIds.length)) { this.log('social_declined'); return false; }
    if (this.blocked(text)) { this.log('social_blocked'); return false; }
    const { chunks, delays } = render(text, {
      max: params.maxChunks, random: this.random,
      minDelayMs: params.minDelayMs, maxDelayMs: params.maxDelayMs,
    });
    if (!chunks.length && !stickerIds.length) { this.log('social_empty'); return false; }
    const recentBotTexts = this.memory.botTexts(group, 3);
    if (text && isRepeat(chunks.join(''), recentBotTexts)) { this.log('social_repeat'); return false; }

    let sent = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) await this.sleep(delays[index]);
      if (!alive()) break;
      let response = null;
      try {
        response = await send('send_group_msg', {
          group_id: Number(group), message: [{ type: 'text', data: { text: chunks[index] } }],
        });
      } catch { this.log('social_send_failed'); break; }
      sent += 1;
      this.memory.remember({
        id: response?.message_id === undefined || response?.message_id === null ? null : String(response.message_id),
        group, user: this.config.botId, at: this.now(), text: chunks[index], fromBot: true,
      });
    }
    // A sticker the model asked for goes out after the text it paired with.
    if (stickerIds.length) {
      try {
        sent += await this.stickers.sendByIds(stickerIds, { action: 'send_group_msg', target: { group_id: Number(group) } }, send);
      } catch { this.log('social_sticker_send_failed'); }
    }
    if (!sent) return false;

    this.store.bump(`social_count:${day}:${group}`, 1);
    const next = transition(state.state, 'spoke');
    this.store.saveSimState({
      groupId: group, state: next, lastSpokeAt: this.now(),
      energy: ENERGY_BY_STATE[next], updated: this.now(),
    });
    this.log('social_spoke');
    return true;
  }

  // --- console view ---------------------------------------------------------
  // Never includes chat text: the console shows counts, states and reasons only
  // (see docs/console.md, rule 6). The rows themselves are assembled in view.js.
  describe({ now = this.now() } = {}) {
    return describeFor({
      store: this.store, memory: this.memory, config: this.config, decisions: this.decisions,
      params: group => this.params(group), grouped: () => this.grouped(),
      spokeToday: (group, day) => this.spokeToday(group, day), activityWindowMs: ACTIVITY_WINDOW_MS,
    }, { now });
  }

  maintain() {
    return this.store.pruneMessages(this.now() - this.config.socialMessageTtlMs);
  }
}
