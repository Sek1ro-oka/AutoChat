// The gates: "may we speak *now*?" — the switch, the per-group switch and mute,
// the daily cap, the cooldown and the budget. They are the reason a message can
// be observed without ever reaching the model, and they read state through the
// arguments they are given. Split out of engine.js (I-08) so that file stays
// inside the project's size ceiling; `Social` keeps the same methods, delegated
// here, and `store.reserve` checks the budget again atomically.

import { budgetDay } from '../store.js';
import { costMicro } from '../model.js';
import { containsTerm } from '../terms.js';

export function blockedFor(config, text) { return containsTerm(text, config.blockTerms); }

export function spokeTodayFor(store, group, day) {
  return Number(store.setting(`social_count:${day}:${group}`, '0')) || 0;
}

// Cheap lower bound used only to avoid a pointless model attempt; `reserve` is
// the authority and can still refuse.
export function minReserveFor(config) {
  return costMicro(1024, Math.min(config.maxOutput, 256), config);
}

export function gateFor(store, config, message, state, params, now) {
  if (store.setting('enabled', '1') !== '1') return 'disabled';
  if (store.setting('groupEnabled', '1') !== '1') return 'group_off';
  if (store.setting(`social_mute:${message.group}`, '0') === '1') return 'muted';
  if (message.hasImage) return 'image';
  if (!message.text) return 'empty';
  if (blockedFor(config, message.text)) return 'blocked';
  if (spokeTodayFor(store, message.group, budgetDay(now)) >= params.dailyLimit) return 'daily_limit';
  if (state.lastSpokeAt && now - state.lastSpokeAt < params.cooldownMs) return 'cooldown';
  const remaining = store.balance(budgetDay(now), config.budgetMicro).remaining;
  if (remaining < minReserveFor(config)) return 'budget';
  return null;
}
