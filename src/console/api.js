// Console data builders. Pure functions over `{ config, store, bot, transport,
// runtime }` so the console can be unit tested without opening a socket.

import { budgetDay, CHINA_OFFSET_MS } from '../store.js';
import { reportCost, sampleCostMicro, splitTotals } from '../ledger.js';
import { clearGroupOverrides } from '../group-settings.js';
import { runtimeValues, applyRuntimeValue } from '../runtime-config.js';

const SECRET = /(key|token|secret|password|passwd)/i;

const mask = value => {
  const text = String(value ?? '');
  if (!text) return '';
  return text.length <= 8 ? '••••' : `${text.slice(0, 4)}••••${text.slice(-2)}`;
};

// Walk the effective config and blank out anything that looks like a credential.
export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] = SECRET.test(name) ? mask(item) : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function buildSummary({ config, store, bot, transport, runtime, now = Date.now(), startedAt = now }) {
  const day = budgetDay(now);
  const balance = store.balance(day, config.budgetMicro);
  return {
    generatedAt: now,
    uptimeMs: Math.max(0, now - startedAt),
    connection: {
      ready: Boolean(transport?.ready),
      reconnecting: Boolean(transport?.timer) || (transport?.retry ?? 0) > 0,
      retry: transport?.retry ?? 0,
    },
    model: { active: store.setting('active_model', 'default'), name: config.model },
    switches: {
      enabled: store.setting('enabled', '1') === '1',
      // Why it is off, not only that it is off (D-19/E-10): `/停止` and the
      // automatic meltdown flip the same switch, and the two need opposite
      // reactions. Additive fields — the booleans above keep their meaning.
      enabledReason: store.setting('enabled_reason', ''),
      groupEnabled: store.setting('groupEnabled', '1') === '1',
      groupEnabledReason: store.setting('groupEnabled_reason', ''),
      webSearch: Boolean(config.webSearchEnabled),
      vision: Boolean(config.visionEnabled),
      antiSpam: Boolean(config.antiSpamEnabled),
      groupManagement: Boolean(config.groupManagementEnabled),
    },
    queue: { depth: bot?.queued ?? 0, sendFailures: bot?.sendFailures ?? 0 },
    budget: { day, limitMicro: config.budgetMicro, ...balance },
    groups: store.listGroups().map(group => ({ id: group.id, due: group.due })),
    participants: runtime?.stats?.() ?? [],
  };
}

export function buildSessions({ store, limit = 200 }) {
  return { sessions: store.listSessions(limit) };
}

export function buildCharges({ store, days = 30 }) {
  return { days: store.chargeDays(days) };
}

export function buildConfig({ config }) {
  const { apiKey, onebotToken, consoleToken, modelProfiles, ...rest } = config;
  return {
    config: redact(rest),
    credentials: { apiKey: mask(apiKey), onebotToken: mask(onebotToken), consoleToken: mask(consoleToken) },
    modelProfiles: (modelProfiles ?? []).map(profile => redact(profile)),
  };
}

// --- Runtime settings (V2) -------------------------------------------------
// The editable view of the non-secret knobs. The field table itself lives in
// src/runtime-config.js so the proxy (reader) and this page (writer) can never
// disagree on a key; a write re-describes the whole table, like every other
// console page, so the client re-renders from one response.
export function buildSettings({ config, store }) {
  return runtimeValues(config, store);
}

export function applySetting({ config, store, name, value }) {
  applyRuntimeValue(config, store, name, value);
  return runtimeValues(config, store);
}

// --- Token & cost dashboard (Phase 5) --------------------------------------
// Ranges are fixed so the chart never renders an unbounded number of bars.
export const COST_RANGES = Object.freeze({
  '24h': { buckets: 24, unitMs: 3600000, unit: 'hour' },
  '3d': { buckets: 72, unitMs: 3600000, unit: 'hour' },
  '7d': { buckets: 7, unitMs: 86400000, unit: 'day' },
  '30d': { buckets: 30, unitMs: 86400000, unit: 'day' },
});

// Zero-fill empty slots so the chart keeps a stable x-axis instead of collapsing.
function series(rows, { start, buckets, unitMs }, config) {
  const bySlot = new Map(rows.map(row => [row.t, row]));
  const points = [];
  for (let index = 0; index < buckets; index += 1) {
    const t = start + index * unitMs;
    const row = bySlot.get(t);
    const { peakMicro, offMicro, totalMicro } = reportCost(row, config);
    points.push({ t, peakMicro, offMicro, totalMicro, calls: row?.calls ?? 0, ...splitTotals(row) });
  }
  return points;
}

export function buildCost({ config, store, range = '24h', sessions = 50, samples = 20, now = Date.now() }) {
  const spec = COST_RANGES[range] ?? COST_RANGES['24h'];
  // Align to China-time bucket boundaries (`epoch multiples` would put a "day"
  // boundary at 08:00 Beijing, splitting a real billing day in half).
  const until = Math.ceil((now + CHINA_OFFSET_MS) / spec.unitMs) * spec.unitMs - CHINA_OFFSET_MS;
  const since = until - spec.buckets * spec.unitMs;
  const span = { since, until };
  const totalRow = store.costTotals(span);
  const totals = { ...splitTotals(totalRow), calls: totalRow.calls, turns: totalRow.turns, ...reportCost(totalRow, config) };
  return {
    range: COST_RANGES[range] ? range : '24h', ranges: Object.keys(COST_RANGES),
    unit: spec.unit, unitMs: spec.unitMs, since, until,
    pricing: {
      inputPrice: config.inputPrice ?? null, outputPrice: config.outputPrice ?? null,
      cacheHitPrice: config.cacheHitPrice ?? null, offPeakRatio: config.offPeakRatio ?? 0.5,
    },
    totals: {
      ...totals,
      avgTurnMicro: totals.turns ? Math.round(totals.totalMicro / totals.turns) : 0,
      avgCallMicro: totals.calls ? Math.round(totals.totalMicro / totals.calls) : 0,
    },
    series: series(store.costSeries({ ...span, unitMs: spec.unitMs }), { start: since, ...spec }, config),
    sessions: store.costSessions({ ...span, limit: sessions }).map(row => ({
      session: row.session, calls: row.calls, turns: row.turns, last: row.last,
      ...splitTotals(row), ...reportCost(row, config),
    })),
    recent: store.recentSamples(samples).map(row => ({
      session: row.session, turn: row.turn, seq: row.seq, at: row.at, bucket: row.bucket,
      miss: row.miss, hit: row.hit, out: row.out,
      tokens: row.miss + row.hit + row.out, costMicro: sampleCostMicro(row, config),
    })),
  };
}

export function buildCostTurns({ config, store, session = '', limit = 100 }) {
  return {
    session,
    turns: store.costTurns({ session, limit }).map(row => ({
      turn: row.turn, at: row.at, last: row.last, calls: row.calls,
      ...splitTotals(row), ...reportCost(row, config),
    })),
  };
}

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

// --- QQ Zone posts (I-09) --------------------------------------------------
// One row per evaluation outcome, exactly as `qzone.js` recorded it. Blocked and
// failed rows are described by status plus the reason enum and never carry their
// text: the outbound gate refused that text, so re-publishing it here would be
// the same mistake the gate exists to prevent. `status` is passed through as
// stored — an unknown value is shown as-is rather than relabelled.
const QZONE_HIDDEN = Object.freeze(['blocked', 'failed']);

export function buildQzonePosts({ config, store, now = Date.now(), limit = 50 }) {
  const posts = store.listQzonePosts(limit);
  const day = budgetDay(now);
  // The same window `qzone.js` gate() uses, and the same rows: the daily cap
  // counts drafts as well as published posts (a dry run is a paid evaluation).
  const counted = store.qzonePostsSince(Date.parse(`${day}T00:00:00+08:00`));
  const limitPerDay = Number(config.qzoneMaxPerDay) || 1;
  const sent = posts.filter(row => row.status === 'sent');
  return {
    enabled: Boolean(config.qzoneEnabled),
    dryRun: Boolean(config.qzoneDryRun),
    ugcRight: Number(config.qzoneUgcRight) || 4,
    hours: String(config.qzoneHours ?? ''),
    maxPerDay: limitPerDay,
    minGapHours: Number(config.qzoneMinGapHours) || 6,
    batchMin: Number(config.qzoneBatchMin) || 8,
    day,
    today: {
      sent: counted.filter(row => row.status === 'sent').length,
      drafted: counted.filter(row => row.status === 'drafted').length,
      used: counted.length,
      limit: limitPerDay,
      remaining: Math.max(0, limitPerDay - counted.length),
    },
    lastSentAt: Number(sent[0]?.at ?? 0),
    posts: posts.map(row => ({
      id: String(row.id),
      at: Number(row.at),
      status: String(row.status),
      reason: String(row.reason ?? ''),
      ugcRight: Number(row.ugc_right) || 4,
      // Deletable only when the protocol side confirmed a tid: a draft or a blocked
      // attempt never reached QZone, so there is nothing out there to delete.
      removable: row.status === 'sent' && String(row.tid ?? '') !== '',
      text: QZONE_HIDDEN.includes(row.status) ? '' : String(row.text ?? ''),
    })),
  };
}

// A rejected delete must never look like a success: the row is only marked
// `deleted` after `delete_qzone_msg` came back clean, and every failure carries a
// stable code plus (when the transport has one) the raw message, so the page can
// say what actually went wrong instead of "内部错误".
const DELETE_OFFLINE = Object.freeze(['ONEBOT_NOT_CONNECTED', 'ONEBOT_DISCONNECTED', 'ONEBOT_SEND_FAILED']);
const tagged = (code, detail) => Object.assign(new Error(code), { detail: String(detail ?? '').slice(0, 160) });

export async function deleteQzonePost({ config, store, transport, id, now = Date.now() }) {
  const postId = String(id ?? '');
  const row = postId ? store.listQzonePosts(200).find(item => String(item.id) === postId) : null;
  if (!row) throw new Error('QZONE_POST_NOT_FOUND');
  if (row.status === 'deleted') throw new Error('QZONE_POST_ALREADY_DELETED');
  // No tid means no post on the QZone side: refuse before touching the protocol.
  if (row.status !== 'sent' || !String(row.tid ?? '')) throw new Error('QZONE_POST_NO_TID');
  if (typeof transport?.call !== 'function') throw tagged('QZONE_DELETE_UNAVAILABLE', 'no_transport');
  let response;
  try {
    response = await transport.call('delete_qzone_msg', { tid: String(row.tid) });
  } catch (error) {
    const raw = String(error?.message ?? 'unknown');
    const code = DELETE_OFFLINE.includes(raw)
      ? 'QZONE_DELETE_UNAVAILABLE'
      : raw === 'ONEBOT_TIMEOUT' ? 'QZONE_DELETE_TIMEOUT'
        : raw === 'ONEBOT_ACTION_FAILED' ? 'QZONE_DELETE_REJECTED' : 'QZONE_DELETE_FAILED';
    throw tagged(code, raw);
  }
  // A resolved frame can still carry a non-zero retcode (a fake transport in a
  // test, or a protocol adapter that reports errors inline): that is a failure.
  const retcode = Number(response?.retcode ?? response?.code ?? 0);
  if (retcode !== 0) throw tagged('QZONE_DELETE_REJECTED', `retcode ${retcode}`);
  store.setQzonePostStatus(postId, 'deleted', 'console');
  return { id: postId, deleted: true, ...buildQzonePosts({ config, store, now }) };
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
