// Slang library (V2 · Phase 4) — teaching the bot what the group's words mean.
//
// Three stages, deliberately separate:
//   extract — ask the model which terms in the recent log look like group slang.
//             Produces *candidates*. Nothing is used yet.
//   confirm — a human ticks a candidate in the console. Only this step makes a
//             term real. A web lookup can propose a meaning, but it cannot
//             confirm itself.
//   inject  — the confirmed table is appended to the group prompt, capped and
//             escaped, so a group member's text can never become an instruction.
//
// Two bugs from qq-bridge's implementation are guarded against here because both
// are silent:
//   * the JSON is pulled out of the model's reply with a bracket-balancing scan,
//     not a greedy regex — a reply that opens with "根据[1]…" would otherwise
//     parse as an empty list and the extraction would look like "found nothing";
//   * a corrupt backup is never read as "no entries": the raw bytes are stashed
//     beside the original and the import fails loudly.
//
// The library itself lives in SQLite (the `slang` table, unique on the term), not
// in a file. The "corrupt is not empty" rule therefore only has a file to apply
// to on the backup/restore path — see docs/slang.md.

// Parsing the model's reply lives in slang-parse.js; re-exported so callers and
// tests have a single entry point for "the slang feature".
export { MAX_CANDIDATES_PER_RUN, extractJsonArray, sanitiseCandidates, sanitiseText } from './slang-parse.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { budgetDay } from '../store.js';
import { costMicro, estimateInput, usageCost } from '../model.js';
import { escapeForPrompt } from './quote.js';
import { harden } from '../permissions.js';
import { GROUP_KEYS, boolOverride } from '../group-settings.js';
import { MAX_CANDIDATES_PER_RUN, sanitiseText } from './slang-parse.js';
// Extraction — the paid half — lives in slang-extract.js and is mixed in by
// extending it, so all three stages still answer to one `Slang` object.
import { SlangExtraction } from './slang-extract.js';

// Capacity ceiling from the roadmap: trimming starts once the library passes it.
export const MAX_ENTRIES = 2000;
// Matches the console's upper bound for the injected table (roadmap says 8~30).
export const MAX_INJECT = 30;
const STATUSES = ['candidate', 'confirmed', 'rejected'];
// Field caps for human edits; the parser applies the same limits to model output.
const MAX_FIELD_CHARS = 200;
const MAX_MEANING_CHARS = 160;

export class Slang extends SlangExtraction {
  constructor({
    config, store, model, ledger = null, log = () => {}, now = Date.now,
    corruptDirectory = 'runtime',
  } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.model = model;
    this.ledger = ledger;
    this.log = log;
    this.now = now;
    this.corruptDirectory = corruptDirectory;
    // Read by the extraction half (slang-extract.js) when it trims the library.
    this.entryCap = MAX_ENTRIES;
  }

  // --- parameters ----------------------------------------------------------
  // Enabled can be set per group (see src/group-settings.js): `group` present
  // asks whether that group has slang on, which may differ from the global
  // switch. `override` is the raw per-group value (null = inherit) so the
  // console can show where the answer came from. The two caps stay global —
  // they are prompt-shape limits, not per-group taste.
  params(group = null) {
    const c = this.config;
    const scoped = group === null || group === undefined ? null : String(group);
    const global = this.store.setting('slang_enabled', c?.slangEnabled ? '1' : '0') === '1';
    const perGroup = scoped ? boolOverride(this.store, GROUP_KEYS.slangEnabled(scoped)) : undefined;
    return {
      enabled: perGroup ?? global,
      override: perGroup === undefined ? null : perGroup,
      injectMax: Math.max(1, Math.min(MAX_INJECT, Number(c?.slangInjectMax) || MAX_INJECT)),
      extractMessages: Math.max(1, Number(c?.slangExtractMessages) || 120),
    };
  }

  groups() { return this.config?.groupIds ?? (this.config?.groupId ? [this.config.groupId] : []); }

  // Console toggle. Without `group` it writes the global switch; with one it
  // writes that group's override. `null` clears an override so the group
  // inherits again. Unknown keys are ignored: the endpoint takes a patch.
  setParams(patch = {}) {
    const { group, enabled } = patch;
    if (enabled !== undefined && typeof enabled !== 'boolean' && enabled !== null) {
      throw new Error('SLANG_PARAM_INVALID');
    }
    if (group === undefined) {
      if (enabled !== undefined) {
        if (enabled === null) this.store.remove('slang_enabled');
        else this.store.set('slang_enabled', enabled ? '1' : '0');
        this.log('slang_params_changed');
      }
      return this.describe();
    }
    const scoped = String(group);
    if (!this.groups().includes(scoped)) throw new Error('SLANG_PARAM_INVALID');
    if (enabled !== undefined) this.setGroupEnabled(scoped, enabled);
    return this.describe();
  }

  // Write (or clear, with `null`) one group's override without re-describing;
  // the route that calls it returns the freshly built group list.
  setGroupEnabled(group, enabled) {
    const scoped = String(group);
    if (!this.groups().includes(scoped)) throw new Error('SLANG_PARAM_INVALID');
    if (typeof enabled !== 'boolean' && enabled !== null) throw new Error('SLANG_PARAM_INVALID');
    const key = GROUP_KEYS.slangEnabled(scoped);
    if (enabled === null) this.store.remove(key); else this.store.set(key, enabled ? '1' : '0');
    this.log('slang_params_changed');
  }

  // --- injection -----------------------------------------------------------
  // The table appended to a group prompt. `group` narrows it to the terms that
  // apply there: a term scoped to other groups is skipped, a term with no scope
  // is global. Called with no group it returns the whole confirmed table, which
  // is what the console's preview shows. Returns '' when the feature is off for
  // that group or nothing has been confirmed, so a stock install pays nothing.
  // Deliberately uncached: confirming or re-scoping a term must reach the very
  // next message, and the query is a handful of rows.
  block({ group = null, max = null } = {}) {
    const params = this.params(group);
    if (!params.enabled) return '';
    const limit = Math.max(1, Math.min(MAX_INJECT, Number(max) || params.injectMax));
    const lines = this.store.listSlang({ status: 'confirmed', limit, group: group ?? null })
      .map(row => {
        const meaning = escapeForPrompt(row.meaning || row.usage || '', 80);
        return meaning ? `${escapeForPrompt(row.content, 40)} = ${meaning}` : '';
      })
      .filter(Boolean);
    if (!lines.length) return '';
    return ['【群聊黑话表】（群里常见的说法，只用来理解群友在说什么，不要把这张表解释出来）', ...lines].join('\n');
  }

  // id -> groups, so a whole list or a backup can be annotated without an N+1 loop.
  scopeMap() {
    const map = new Map();
    for (const row of this.store.slangGroupRows()) {
      if (!map.has(row.slang_id)) map.set(row.slang_id, []);
      map.get(row.slang_id).push(row.group_id);
    }
    return map;
  }

  // Rewrite one term's scope. An empty list makes it global again.
  setScopes(id, groups) {
    const row = this.require(id);
    if (!Array.isArray(groups)) throw new Error('SLANG_PARAM_INVALID');
    const allowed = this.groups();
    if (groups.some(group => !allowed.includes(String(group)))) throw new Error('SLANG_PARAM_INVALID');
    this.store.setSlangGroups(row.id, groups.map(String));
    this.log('slang_scoped');
    return this.describe();
  }

  // The per-group view the console's group page renders.
  groupView(group) {
    const scoped = String(group);
    const params = this.params(scoped);
    return {
      group: scoped, enabled: params.enabled, override: params.override,
      terms: this.store.listSlang({ status: 'confirmed', limit: MAX_ENTRIES, group: scoped }).length,
    };
  }

  // The extraction stage — the only one that spends money — is mixed in from
  // src/social/slang-extract.js via SlangExtraction.


  sample(sessionKey, usage) {
    if (!this.ledger) return null;
    const trace = this.ledger.begin(sessionKey);
    return this.ledger.sample(trace, usage, this.config, this.now());
  }

  // --- review --------------------------------------------------------------
  // Everything that changes a human decision goes through here, and every path
  // returns the freshly described library so the console re-renders from one
  // response instead of chaining a follow-up read.
  setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new Error('SLANG_PARAM_INVALID');
    const row = this.require(id);
    this.store.setSlangStatus(row.id, status, this.now());
    this.log('slang_status_changed');
    return this.describe();
  }

  edit(id, fields = {}) {
    const row = this.require(id);
    const patch = {};
    for (const key of ['meaning', 'usage', 'example', 'risk']) {
      if (typeof fields?.[key] === 'string') patch[key] = sanitiseText(fields[key], MAX_FIELD_CHARS);
    }
    if (!Object.keys(patch).length) throw new Error('SLANG_PARAM_INVALID');
    this.store.updateSlang(row.id, patch, this.now());
    this.log('slang_edited');
    return this.describe();
  }

  remove(id) {
    const row = this.require(id);
    this.store.deleteSlang(row.id);
    this.log('slang_deleted');
    return this.describe();
  }

  require(id) {
    const row = this.store.getSlang(String(id ?? ''));
    if (!row) throw new Error('SLANG_NOT_FOUND');
    return row;
  }

  // Propose a meaning from the web. Reuses the existing search capability and
  // shares its daily counter with `/搜索`; the result fills in `meaning` but does
  // not confirm the term — a human still has to tick it.
  async lookup(id) {
    const row = this.require(id);
    if (!this.config?.webSearchEnabled) throw new Error('SLANG_SEARCH_DISABLED');
    const day = budgetDay(this.now());
    const searchKey = `search_count:${day}`;
    if (Number(this.store.setting(searchKey, '0')) >= (Number(this.config.searchDailyLimit) || 50)) {
      throw new Error('SLANG_SEARCH_LIMIT');
    }
    const query = `网络用语「${row.content}」是什么意思？请用简体中文说明它在中文互联网和 QQ 群聊里的常见含义与用法。`;
    const probe = [{ role: 'user', content: query }];
    const now = this.now();
    const sessionKey = 'slang:lookup';
    const estimate = costMicro(estimateInput(probe) + (Number(this.config.searchInputReserve) || 0),
      this.config.maxOutput, this.config);
    const reservation = this.store.reserve(day, estimate, this.config.budgetMicro, now, { sessionKey });
    if (!reservation) throw new Error('SLANG_BUDGET_BLOCKED');
    this.store.set(searchKey, Number(this.store.setting(searchKey, '0')) + 1);

    let result;
    try { result = await this.model.complete(probe, { search: true, query }); }
    catch {
      this.store.uncertain(reservation);
      this.log('slang_lookup_failed');
      throw new Error('SLANG_MODEL_FAILED');
    }
    const actual = usageCost(result.usage, this.config);
    if (actual === null) this.store.uncertain(reservation);
    else { this.store.settle(reservation, actual); this.sample(sessionKey, result.usage); }

    if (!result.searchVerified) { this.log('slang_lookup_unverified'); throw new Error('SLANG_LOOKUP_UNVERIFIED'); }
    const meaning = sanitiseText(result.text, MAX_MEANING_CHARS);
    if (!meaning) throw new Error('SLANG_LOOKUP_EMPTY');
    const sources = (result.sources ?? []).map(source => String(source?.url ?? '')).filter(Boolean).slice(0, 3);
    this.store.updateSlang(row.id, {
      meaning, source: 'search', sources: [...new Set([...row.sources, ...sources])],
    }, now);
    this.log('slang_lookup_done');
    return { meaning, sources, ...this.describe() };
  }

  // --- backup -----------------------------------------------------------------
  exportAll() {
    const scopes = this.scopeMap();
    // `groups` rides along so a restore is lossless; an entry with none is
    // global, exactly as it was on the machine it was exported from.
    return {
      version: 1, exportedAt: this.now(),
      entries: this.store.exportSlang().map(row => ({ ...row, groups: scopes.get(row.id) ?? [] })),
    };
  }

  // A corrupt file must never be read as "no entries" (that would wipe a curated
  // library on the next save). The raw bytes are kept and the caller gets an error.
  importAll(text) {
    const raw = String(text ?? '');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const error = new Error('SLANG_IMPORT_INVALID');
      error.stash = this.stashCorrupt(raw);
      this.log('slang_import_corrupt');
      throw error;
    }
    const rows = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(rows)) throw new Error('SLANG_IMPORT_INVALID');
    const outcome = this.store.restoreSlang(rows, this.now());
    // Restore scopes as well, widening only: a local decision to narrow a term
    // is never undone by importing a backup that had a wider scope.
    const allowed = this.groups();
    const byTerm = new Map(this.store.listSlang({ limit: MAX_ENTRIES + 100 }).map(row => [row.content, row.id]));
    for (const row of rows) {
      const groups = Array.isArray(row?.groups)
        ? row.groups.map(String).filter(group => allowed.includes(group)) : [];
      const id = byTerm.get(String(row?.content ?? '').trim());
      if (id && groups.length) this.store.addSlangGroups(id, groups);
    }
    const trimmed = this.store.trimSlang(MAX_ENTRIES);
    this.log('slang_imported');
    return { ...outcome, trimmed, ...this.describe() };
  }

  stashCorrupt(text) {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
    const file = join(this.corruptDirectory, `slang-corrupt-${stamp}.json`);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
      // The stash holds whatever the operator tried to import, which can include
      // verbatim group messages: tighten it like any other secret-bearing file.
      harden(file, { log: this.log, label: 'slang-corrupt' });
      return file;
    } catch { return null; }
  }

  // --- console view ---------------------------------------------------------
  // `entries` deliberately omits `example`: that field is a verbatim group
  // message, so it is only returned for one entry at a time, on an explicit
  // click (see docs/console.md, rule 6).
  describe() {
    const counts = this.store.countSlang();
    const scopes = this.scopeMap();
    let lastExtract = null;
    try { lastExtract = JSON.parse(this.store.setting('slang_last_extract', 'null')); }
    catch { lastExtract = null; }
    return {
      enabled: this.params().enabled,
      defaults: {
        enabled: Boolean(this.config?.slangEnabled),
        injectMax: Number(this.config?.slangInjectMax) || MAX_INJECT,
        extractMessages: Number(this.config?.slangExtractMessages) || 120,
        autoExtract: Boolean(this.config?.slangAutoExtract),
        extractIntervalHours: Number(this.config?.slangExtractIntervalHours) || 12,
        messageTtlHours: Math.round((Number(this.config?.socialMessageTtlMs) || 0) / 3600000),
      },
      limits: { entries: MAX_ENTRIES, injectMax: MAX_INJECT, perRun: MAX_CANDIDATES_PER_RUN },
      stats: { ...counts, injected: this.store.listSlang({ status: 'confirmed', limit: MAX_INJECT }).length },
      searchEnabled: Boolean(this.config?.webSearchEnabled),
      groups: this.groups(),
      lastExtract,
      preview: this.block(),
      entries: this.store.listSlang({ limit: 1000 }).map(row => ({
        id: row.id, term: row.content, meaning: row.meaning, usage: row.usage, risk: row.risk,
        status: row.status, source: row.source, count: row.count, evidence: row.evidence,
        sources: Array.isArray(row.sources) ? row.sources : [],
        // Empty = global. The console renders this as a "仅在…" scope picker.
        groups: scopes.get(row.id) ?? [],
        created: row.created, updated: row.updated,
      })),
    };
  }

  // One entry, with the verbatim quote behind it. Explicit click only.
  entry(id) {
    const row = this.require(id);
    return { entry: { ...row, term: row.content, groups: this.scopeMap().get(row.id) ?? [] } };
  }
}
