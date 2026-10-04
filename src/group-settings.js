// Per-group specialisation (V2).
//
// Three subsystems — the persona, the social simulation and the slang library —
// can each be tuned per group instead of once for the whole bot. Every override
// is a namespaced row in the `settings` table, the same pattern `social_mute:<g>`
// already used: a group with no row inherits the global value, so a stock
// install behaves exactly as before this existed.
//
// The key names and the numeric bounds live here, in one place, because two
// different callers must agree on them: the readers (personas.js, the social
// engine, slang.js) and the writer (the console's group page). A drift between
// the two would be silent — the console would "save" a value nothing ever read.

export const GROUP_KEYS = Object.freeze({
  persona: group => `group_persona:${group}`,
  socialEnabled: group => `group_social_enabled:${group}`,
  socialThreshold: group => `group_social_threshold:${group}`,
  socialCooldown: group => `group_social_cooldown_seconds:${group}`,
  socialDailyLimit: group => `group_social_daily_limit:${group}`,
  slangEnabled: group => `group_slang_enabled:${group}`,
});

// Bounds shared by the engine's validator and the console's inputs. They match
// the `.env` ranges in config.js, so a per-group value can never be one the
// global default could not have been.
export const GROUP_LIMITS = Object.freeze({
  threshold: Object.freeze({ min: 0, max: 100 }),
  cooldownSeconds: Object.freeze({ min: 5, max: 3600 }),
  dailyLimit: Object.freeze({ min: 1, max: 500 }),
  // Idle-initiated speech is a whole-bot switch, not a per-group one, but its
  // bounds still live here so the console and the engine share one table.
  idleMinutes: Object.freeze({ min: 5, max: 720 }),
});

export const withinRange = (value, { min, max }) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

// `undefined` means "no override — inherit"; every reader treats it that way.
// A stored empty string is a real value (the persona reader uses it for
// "explicitly the built-in default"), so it must not be folded into `undefined`.
export function rawOverride(store, key) {
  const value = store?.setting?.(key, null);
  return value === null || value === undefined ? undefined : value;
}

export function boolOverride(store, key) {
  const value = rawOverride(store, key);
  return value === undefined ? undefined : value === '1';
}

export function numberOverride(store, key) {
  const value = rawOverride(store, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Drop every override for one group, returning it to the global defaults.
// Returns the keys that were actually removed so the caller can log a real
// number instead of claiming a reset that changed nothing.
export function clearGroupOverrides(store, group) {
  if (!store?.remove) throw new Error('GROUP_UNAVAILABLE');
  const removed = [];
  for (const build of Object.values(GROUP_KEYS)) {
    const key = build(group);
    if (store.remove(key) > 0) removed.push(key);
  }
  return removed;
}
