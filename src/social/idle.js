// Idle-initiated speech (V2 · Phase 6), split out of engine.js so that file
// stays inside the project's size ceiling.
//
// The simulation no longer only reacts: with the switch on, a group that has
// been silent long enough is offered a prompt to break the ice. Every gate is
// still checked before the model is called — silence must not become spending.
//
// `Social` extends this class, so the methods below reach `this.deliver`,
// `this.serialise` and the rest of the engine through normal dispatch.

import { budgetDay } from '../store.js';
import { buildIdleRequest } from './prompt.js';
import { SIM_STATES } from './state.js';

export class IdleSpeech {
  // Whether the current Beijing hour falls inside a `H-H` window such as 9-22.
  idleAllowed(hour, spec) {
    const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(spec ?? '0-23'));
    if (!match) return false;
    const start = Number(match[1]); const end = Number(match[2]);
    return hour >= start && hour <= end;
  }

  // When anyone last spoke in this group: the live ring when we have one, else
  // the persisted ledger (which survives a restart).
  lastActivity(group) {
    const ring = this.memory.ring(group);
    if (ring.length) return ring[ring.length - 1].at;
    const rows = this.store.recentMessages(group, { limit: 1 });
    return rows[0]?.at ?? 0;
  }

  async idleSpeak(group, send, alive, params) {
    const stored = this.store.getSimState(group);
    const state = { state: SIM_STATES.includes(stored?.state) ? stored.state : 'observing' };
    let messages;
    try {
      messages = buildIdleRequest({
        memory: this.memory, config: this.config, group, params,
        system: this.systemPrompt(group), idleMinutes: params.idleMinutes,
      });
    } catch { this.log('social_context_failed'); return false; }
    return this.deliver(messages, group, send, alive, state, params);
  }

  async idleTick(send, alive = () => true) {
    if (this.idleRunning) return;
    this.idleRunning = true;
    try {
      const now = this.now();
      for (const group of this.grouped()) {
        const params = this.params(group);
        if (!params.enabled || !params.idleEnabled) continue;
        if (this.store.setting('enabled', '1') !== '1' || this.store.setting('groupEnabled', '1') !== '1') continue;
        if (this.store.setting(`social_mute:${group}`, '0') === '1') continue;
        if (!this.idleAllowed(this.hour(), params.idleHours)) continue;
        if (now - this.lastActivity(group) < params.idleMinutes * 60000) continue;
        if (this.spokeToday(group, budgetDay(now)) >= params.dailyLimit) continue;
        if (this.store.balance(budgetDay(now), this.config.budgetMicro).remaining < this.minReserve()) continue;
        await this.serialise(group, () => this.idleSpeak(group, send, alive, params));
      }
    } finally { this.idleRunning = false; }
  }
}
