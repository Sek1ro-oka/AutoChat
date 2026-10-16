// The console's read model: one flat, JSON-safe snapshot of the simulation per
// group, for the pages that only ever read. Split out of engine.js (I-08) so
// that file stays inside the project's size ceiling — `Social#describe` still
// returns exactly this, and nothing here can write: it takes an explicit
// dependency record and only calls the readers on it.

import { budgetDay } from '../store.js';
import { SIM_STATES, energyFor, requiredScore } from './state.js';

// Never includes chat text: the console shows counts, states and reasons only
// (see docs/console.md, rule 6).
export function describeFor(deps, { now }) {
  const params = deps.params();
  const day = budgetDay(now);
  const states = new Map(deps.store.listSimStates().map(row => [row.group_id, row]));
  const groups = deps.grouped().map(id => {
    const row = states.get(id);
    const state = SIM_STATES.includes(row?.state) ? row.state : 'observing';
    const lastSpokeAt = row?.last_spoke_at ?? null;
    const idle = lastSpokeAt ? Math.max(0, now - lastSpokeAt) : null;
    const decision = deps.decisions.get(id) ?? null;
    // Each row reports *its own* effective numbers, not the global ones: that
    // is the whole point of the per-group layer, and the console renders it.
    const own = deps.params(id);
    return {
      id, state, energy: energyFor(state, idle ?? 0), lastSpokeAt, idleMs: idle,
      enabled: own.enabled, overridden: own.overridden,
      threshold: own.threshold, cooldownSeconds: Math.round(own.cooldownMs / 1000),
      spokeToday: deps.spokeToday(id, day), dailyLimit: own.dailyLimit,
      muted: deps.store.setting(`social_mute:${id}`, '0') === '1',
      activity: deps.memory.ring(id).filter(entry => now - entry.at <= deps.activityWindowMs).length,
      required: requiredScore({ threshold: own.threshold, state, energy: energyFor(state, idle ?? 0) }),
      decision,
    };
  });
  return {
    enabled: params.enabled,
    gate: { core: deps.store.setting('enabled', '1') === '1', group: deps.store.setting('groupEnabled', '1') === '1' },
    params: {
      threshold: params.threshold, cooldownSeconds: Math.round(params.cooldownMs / 1000),
      dailyLimit: params.dailyLimit,
      idleEnabled: params.idleEnabled, idleMinutes: params.idleMinutes, idleHours: params.idleHours,
    },
    defaults: {
      enabled: Boolean(deps.config.socialEnabled), threshold: deps.config.socialThreshold,
      cooldownSeconds: deps.config.socialCooldownSeconds, dailyLimit: deps.config.socialDailyLimit,
      contextMessages: deps.config.socialContextMessages, maxChunks: deps.config.socialMaxChunks,
      minDelayMs: deps.config.socialMinDelayMs, maxDelayMs: deps.config.socialMaxDelayMs,
      messageTtlHours: Math.round(deps.config.socialMessageTtlMs / 3600000),
      idleEnabled: Boolean(deps.config.socialIdleEnabled), idleMinutes: deps.config.socialIdleMinutes, idleHours: deps.config.socialIdleHours,
    },
    today: { day, spoke: groups.reduce((total, group) => total + group.spokeToday, 0) },
    groups,
  };
}
