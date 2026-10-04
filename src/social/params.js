// The simulation's numbers, and which group they apply to (V2 · per-group
// specialisation).
//
// Split out of engine.js for two reasons: that file sits against the project's
// size ceiling, and "which numbers apply" is a different question from "should
// we speak" — the same split prompt.js already makes for "what do we send".
//
// Resolution order, lowest first:
//   `.env` default  <  global setting  <  per-group setting
// A group with no override rows resolves to exactly the global value, so an
// install that predates this layer — or one that never touches the group page —
// behaves precisely as before.
//
// `null` in a patch clears the layer it would have written, which is how the
// console says "inherit again".

import { GROUP_KEYS, GROUP_LIMITS, boolOverride, numberOverride, withinRange } from '../group-settings.js';

// Global setting names and their per-group counterparts, kept in one table so a
// parameter cannot be readable in one scope and unwritable in the other.
const FIELDS = Object.freeze({
  enabled: Object.freeze({ global: 'social_enabled', group: GROUP_KEYS.socialEnabled, bool: true }),
  threshold: Object.freeze({ global: 'social_threshold', group: GROUP_KEYS.socialThreshold, range: GROUP_LIMITS.threshold }),
  cooldownSeconds: Object.freeze({
    global: 'social_cooldown_seconds', group: GROUP_KEYS.socialCooldown, range: GROUP_LIMITS.cooldownSeconds, round: true,
  }),
  dailyLimit: Object.freeze({
    global: 'social_daily_limit', group: GROUP_KEYS.socialDailyLimit, range: GROUP_LIMITS.dailyLimit, round: true,
  }),
});

export function resolveParams(store, config, group = null) {
  const globalText = (key, fallback) => {
    const value = store.setting(key, null);
    return value === null ? fallback : value;
  };
  const globalNumber = (key, fallback) => {
    const value = store.setting(key, null);
    const parsed = Number(value);
    return value !== null && Number.isFinite(parsed) ? parsed : fallback;
  };
  const globalEnabled = globalText('social_enabled', config.socialEnabled ? '1' : '0') === '1';
  const globalThreshold = globalNumber('social_threshold', config.socialThreshold);
  const globalCooldown = globalNumber('social_cooldown_seconds', config.socialCooldownSeconds);
  const globalDaily = globalNumber('social_daily_limit', config.socialDailyLimit);

  // `undefined` from these helpers means "no row in this scope".
  const scoped = group === null || group === undefined ? null : String(group);
  const perEnabled = scoped ? boolOverride(store, GROUP_KEYS.socialEnabled(scoped)) : undefined;
  const perThreshold = scoped ? numberOverride(store, GROUP_KEYS.socialThreshold(scoped)) : undefined;
  const perCooldown = scoped ? numberOverride(store, GROUP_KEYS.socialCooldown(scoped)) : undefined;
  const perDaily = scoped ? numberOverride(store, GROUP_KEYS.socialDailyLimit(scoped)) : undefined;

  return {
    enabled: perEnabled ?? globalEnabled,
    threshold: perThreshold ?? globalThreshold,
    cooldownMs: (perCooldown ?? globalCooldown) * 1000,
    dailyLimit: perDaily ?? globalDaily,
    contextMessages: config.socialContextMessages,
    maxChunks: config.socialMaxChunks,
    minDelayMs: config.socialMinDelayMs,
    maxDelayMs: config.socialMaxDelayMs,
    // Which of the four came from a per-group row. The console shows this so an
    // operator can tell "this group's own value" from "inherited".
    overridden: {
      enabled: perEnabled !== undefined, threshold: perThreshold !== undefined,
      cooldownSeconds: perCooldown !== undefined, dailyLimit: perDaily !== undefined,
    },
  };
}

// Apply a console patch. Unknown keys are ignored on purpose: the endpoint takes
// a patch, not a replacement. `group` absent writes the global rows (the
// pre-existing behaviour); `group` present writes that group's override rows.
export function applyParams({ store, config, group = null, patch = {}, log = () => {} }) {
  const scoped = group === null || group === undefined ? null : String(group);
  const keyFor = field => (scoped === null ? field.global : field.group(scoped));
  const write = (field, value) => {
    if (value === null) {
      if (!store.remove) throw new Error('SOCIAL_PARAM_INVALID');
      store.remove(keyFor(field));
      return;
    }
    if (field.bool) {
      if (typeof value !== 'boolean') throw new Error('SOCIAL_PARAM_INVALID');
      store.set(keyFor(field), value ? '1' : '0');
      return;
    }
    const parsed = withinRange(value, field.range);
    if (parsed === null) throw new Error('SOCIAL_PARAM_INVALID');
    store.set(keyFor(field), String(field.round ? Math.round(parsed) : parsed));
  };
  let touched = false;
  for (const [name, field] of Object.entries(FIELDS)) {
    if (!(name in patch)) continue;
    write(field, patch[name]);
    touched = true;
  }
  if (touched) log('social_params_changed');
  return touched;
}
