// The simulation's state machine — pure functions only (V2 · Phase 3).
//
// Kept separate from engine.js for one reason: every rule that decides *how
// willing* the bot is to speak lives here as a total function of its inputs, so
// it can be reasoned about and tested without a store, a clock or a socket.
//
// Three observable events drive the transitions:
//   spoke   — we just said something
//   engaged — someone reacted to us (named us, quoted us, replied to our line)
//   ignored — we spoke and nobody came
//   cooled  — we stayed quiet long enough to try again

export const SIM_STATES = Object.freeze(['observing', 'active', 'probing', 'retreating']);

const TRANSITIONS = Object.freeze({
  observing: { spoke: 'probing', engaged: 'active' },
  probing: { engaged: 'active', ignored: 'retreating' },
  active: { ignored: 'retreating' },
  retreating: { cooled: 'observing' },
});

export function transition(state, event) {
  if (!SIM_STATES.includes(state)) return 'observing';
  return TRANSITIONS[state]?.[event] ?? state;
}

// Willingness to speak, 0..1. Being mid-conversation should count for something
// and being ignored should count against; that is the entire mechanism.
export const ENERGY_BY_STATE = Object.freeze({ observing: 0.3, probing: 0.45, active: 0.85, retreating: 0.05 });
export const ENERGY_HALF_LIFE_MS = 30 * 60000;

export function energyFor(state, idleMs = 0) {
  const base = ENERGY_BY_STATE[state] ?? ENERGY_BY_STATE.observing;
  if (!(idleMs > 0)) return base;
  return Number((base * Math.exp(-idleMs / ENERGY_HALF_LIFE_MS)).toFixed(3));
}

// An active conversation needs a lower score; a retreating bot needs a much
// higher one. Together with energy this is the only place the threshold moves.
const STATE_ADJUST = Object.freeze({ observing: 0, probing: -1, active: -2.5, retreating: 4 });

export function requiredScore({ threshold = 6, state = 'observing', energy = 0.5 } = {}) {
  const adjust = STATE_ADJUST[state] ?? 0;
  return Number(((Number(threshold) || 0) + adjust - (Number(energy) - 0.5) * 2).toFixed(3));
}
