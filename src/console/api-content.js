// Console data builders: personas, social simulation, slang and sticker
// libraries, and per-group specialisation.

import { clearGroupOverrides } from '../group-settings.js';

// --- Personas (Phase 2) -----------------------------------------------------
// Thin wrappers so the route table stays declarative; every rule (fallback
// order, name validation, path containment) lives in src/personas.js.
export function buildPersonas({ personas }) {
  if (!personas) return { available: false };
  return { available: true, ...personas.describe() };
}

export function buildPersonaFile({ personas, kind = 'card', name = '' }) {
  if (!personas) throw new Error('PERSONA_UNAVAILABLE');
  return kind === 'behavior' ? personas.behaviorFile() : personas.card(name);
}

// --- Social simulation (Phase 3) -------------------------------------------
// Everything the page shows, in one call. Deliberately text-free: states,
// counters and the reason for the last decision, never a group message.
export function buildSocial({ social, now = Date.now() }) {
  if (!social) return { available: false };
  return { available: true, ...social.describe({ now }) };
}

// --- Slang library (Phase 4) -----------------------------------------------
// The list is text-free apart from the curated meaning; the verbatim group quote
// behind an entry is only served one at a time, on an explicit click.
export function buildSlang({ slang }) {
  if (!slang) return { available: false };
  return { available: true, ...slang.describe(), exportable: true };
}

export function buildSlangEntry({ slang, id }) {
  if (!slang) throw new Error('SLANG_UNAVAILABLE');
  return slang.entry(id);
}

// --- Sticker library (Phase 6) ---------------------------------------------
// The list exposes notes/descriptions and counts, never picture bytes; the file
// name is served so the page can render a thumbnail link, nothing more.
export function buildStickers({ stickers }) {
  if (!stickers) return { available: false };
  return { available: true, ...stickers.describe() };
}

export function buildStickerEntry({ stickers, id }) {
  if (!stickers) throw new Error('STICKER_UNAVAILABLE');
  return stickers.entry(id);
}

// --- Per-group specialisation ----------------------------------------------
// The group ids the console may act on. The page builder (what we list) and the
// writer (what we accept) go through this one helper: they used to be two
// hand-copied expressions that agreed everywhere except their last branch. With
// no subsystem able to enumerate groups the set is empty, so the list and the
// writer agree by construction — and "the set is empty" has to mean "there is
// nothing to operate on", never "let everything through". `.env`'s GROUP_QQS is
// deliberately not a fallback: both subsystems enumerate exactly those ids, so
// it would only ever add groups that nothing can actually write.
function knownGroupIds({ social, slang }) {
  if (social) return social.grouped();
  if (slang) return slang.groups();
  return [];
}

// One card per served group, pulling the three specialisable subsystems into a
// single row so the operator sees "what this group actually is" in one place.
export function buildGroups({ personas, social, slang, now = Date.now() }) {
  const groupIds = knownGroupIds({ social, slang });
  const socialView = social ? social.describe({ now }) : null;
  const socialByGroup = new Map((socialView?.groups ?? []).map(g => [String(g.id), g]));
  return {
    available: { personas: Boolean(personas), social: Boolean(social), slang: Boolean(slang) },
    groups: groupIds.map(id => ({
      id: String(id),
      persona: personas ? personas.groupView(id) : null,
      social: socialByGroup.get(String(id)) ?? null,
      slang: slang ? slang.groupView(id) : null,
    })),
    // Reference for the pickers: the persona dropdown needs the card names and
    // the global active card, and the social rows show their inherited defaults.
    personas: personas ? { active: personas.active(), characters: personas.list().map(c => c.name) } : null,
    socialGlobal: socialView ? {
      threshold: socialView.params.threshold,
      cooldownSeconds: socialView.params.cooldownSeconds,
      dailyLimit: socialView.params.dailyLimit,
    } : null,
  };
}

// Route a group-page write to the right subsystem. `subsystem` is mandatory; the
// rest of the patch is subsystem-specific and validated by that subsystem.
export function applyGroupPatch({ personas, social, slang, store, group, patch = {} }) {
  const scoped = String(group ?? '');
  if (!scoped) throw new Error('GROUP_PARAM_INVALID');
  const known = knownGroupIds({ social, slang });
  if (!known.includes(scoped)) throw new Error('GROUP_NOT_FOUND');
  const { subsystem, ...rest } = patch;
  if (subsystem === 'persona') {
    if (!personas) throw new Error('PERSONA_UNAVAILABLE');
    personas.setGroupActive(scoped, rest.name === undefined ? null : rest.name);
  } else if (subsystem === 'social') {
    if (!social) throw new Error('SOCIAL_UNAVAILABLE');
    social.setParams({ group: scoped, ...rest });
  } else if (subsystem === 'slang') {
    if (!slang) throw new Error('SLANG_UNAVAILABLE');
    slang.setParams({ group: scoped, enabled: rest.enabled });
  } else if (subsystem === 'reset') {
    clearGroupOverrides(store, scoped);
  } else {
    throw new Error('GROUP_PARAM_INVALID');
  }
  return true;
}
