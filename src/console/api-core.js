// Console data builders: the overview dashboard, the session/charge lists, the
// effective config view and the runtime settings table.

import { budgetDay } from '../store.js';
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

// --- Instance hub ----------------------------------------------------------
// The hub is injected, never imported here: routes stay pure over their inputs, and
// a console started without one still answers (`server.js` builds the default).
export function buildInstances({ hub }) {
  if (!hub) throw new Error('HUB_UNAVAILABLE');
  return hub.list();
}
