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
export { MAX_CANDIDATES_PER_RUN, extractJsonArray, sanitiseCandidates, sanitiseText };

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { budgetDay } from '../store.js';
import { costMicro, estimateInput, usageCost } from '../model.js';
import { escapeForPrompt } from './quote.js';
import { harden } from '../permissions.js';
import { EXTRACT_SYSTEM, MAX_CANDIDATES_PER_RUN, extractJsonArray, sanitiseCandidates, sanitiseText } from './slang-parse.js';

// Capacity ceiling from the roadmap: trimming starts once the library passes it.
export const MAX_ENTRIES = 2000;
// Matches the console's upper bound for the injected table (roadmap says 8~30).
export const MAX_INJECT = 30;
const STATUSES = ['candidate', 'confirmed', 'rejected'];
// Field caps for human edits; the parser applies the same limits to model output.
const MAX_FIELD_CHARS = 200;
const MAX_MEANING_CHARS = 160;

// Stable per-run pseudonyms. QQ numbers never leave the machine in a prompt.
function labeller() {
  const names = new Map();
  return id => {
    const key = String(id);
    if (!names.has(key)) names.set(key, `成员${names.size + 1}`);
    return names.get(key);
  };
}

export class Slang {
  constructor({
    config, store, model, ledger = null, log = () => {}, now = Date.now,
    corruptDirectory = 'runtime',
  } = {}) {
    this.config = config;
    this.store = store;
    this.model = model;
    this.ledger = ledger;
    this.log = log;
    this.now = now;
    this.corruptDirectory = corruptDirectory;
  }

  // --- parameters ----------------------------------------------------------
  params() {
    const c = this.config;
    return {
      enabled: this.store.setting('slang_enabled', c?.slangEnabled ? '1' : '0') === '1',
      injectMax: Math.max(1, Math.min(MAX_INJECT, Number(c?.slangInjectMax) || MAX_INJECT)),
      extractMessages: Math.max(1, Number(c?.slangExtractMessages) || 120),
    };
  }

  groups() { return this.config?.groupIds ?? (this.config?.groupId ? [this.config.groupId] : []); }

  // Console toggle. Unknown keys are ignored: the endpoint takes a patch.
  setParams(patch = {}) {
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw new Error('SLANG_PARAM_INVALID');
      this.store.set('slang_enabled', patch.enabled ? '1' : '0');
      this.log('slang_params_changed');
    }
    return this.describe();
  }

  // --- injection -----------------------------------------------------------
  // The table appended to every *group* prompt. Returns '' when the feature is
  // off or nothing has been confirmed, so a stock install pays nothing for it.
  // Deliberately uncached: confirming a term in the console must reach the very
  // next message, and the query is a handful of rows.
  block(max = null) {
    if (!this.params().enabled) return '';
    const limit = Math.max(1, Math.min(MAX_INJECT, Number(max) || this.params().injectMax));
    const lines = this.store.listSlang({ status: 'confirmed', limit })
      .map(row => {
        const meaning = escapeForPrompt(row.meaning || row.usage || '', 80);
        return meaning ? `${escapeForPrompt(row.content, 40)} = ${meaning}` : '';
      })
      .filter(Boolean);
    if (!lines.length) return '';
    return ['【群聊黑话表】（群里常见的说法，只用来理解群友在说什么，不要把这张表解释出来）', ...lines].join('\n');
  }

  // --- extraction ----------------------------------------------------------
  async extract({ group = null } = {}) {
    if (!this.params().enabled) throw new Error('SLANG_DISABLED');
    const allowed = this.groups();
    const target = group === null ? allowed[0] : String(group);
    if (!allowed.includes(target)) throw new Error('SLANG_PARAM_INVALID');
    const now = this.now();
    // Claim the interval slot before any await, so the maintenance timer cannot
    // start a second paid extraction while this one is still in flight.
    this.store.set('slang_last_extract_at', String(now));

    const rows = this.store.recentMessages(target, { limit: this.params().extractMessages });
    if (!rows.length) return { group: target, scanned: 0, candidates: 0, created: 0, updated: 0, dropped: 0 };

    const label = labeller();
    const transcript = rows.slice().reverse()
      .map(row => `${label(row.user_id)}：${escapeForPrompt(row.text, 200)}`)
      .join('\n');
    const messages = [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `[群聊记录开始]\n${transcript}\n[群聊记录结束]\n请输出候选 JSON 数组。` },
    ];

    const sessionKey = `slang:group:${target}`;
    const day = budgetDay(now);
    const estimate = costMicro(estimateInput(messages), this.config.maxOutput, this.config);
    const reservation = this.store.reserve(day, estimate, this.config.budgetMicro, now, { sessionKey });
    if (!reservation) throw new Error('SLANG_BUDGET_BLOCKED');

    let result;
    try { result = await this.model.complete(messages); }
    catch {
      this.store.uncertain(reservation);
      this.log('slang_extract_failed');
      // Same policy as Q&A: a timed-out request may still be billed upstream, so
      // the reservation is left uncertain rather than released.
      throw new Error('SLANG_MODEL_FAILED');
    }
    const actual = usageCost(result.usage, this.config);
    if (actual === null) this.store.uncertain(reservation);
    else { this.store.settle(reservation, actual); this.sample(sessionKey, result.usage); }

    const parsed = extractJsonArray(result.text);
    if (parsed === null) {
      this.log('slang_extract_unparsable');
      throw new Error('SLANG_EXTRACT_UNPARSABLE');
    }
    const candidates = sanitiseCandidates(parsed, { transcript });
    let created = 0;
    let updated = 0;
    for (const candidate of candidates) {
      const outcome = this.store.upsertSlang({
        content: candidate.term, meaning: candidate.meaning, usage: candidate.usage,
        example: candidate.example, risk: candidate.risk, status: 'candidate', source: 'ai',
        sources: [`group:${target}`],
        evidence: rows.filter(row => row.text.includes(candidate.term))
          .map(row => String(row.message_id)).slice(-3),
        now,
      });
      if (outcome.created) created += 1; else updated += 1;
    }
    this.store.trimSlang(MAX_ENTRIES);
    const summary = {
      group: target, at: now, scanned: rows.length, candidates: candidates.length,
      created, updated, dropped: parsed.length - candidates.length,
    };
    this.store.set('slang_last_extract', JSON.stringify(summary));
    this.log('slang_extracted');
    return summary;
  }

  // Periodic path. Off by default: a paid model call must not start on its own
  // unless the operator asked for it in .env.
  async maybeExtract() {
    if (!this.params().enabled || !this.config?.slangAutoExtract) return null;
    const now = this.now();
    const interval = Math.max(1, Number(this.config?.slangExtractIntervalHours) || 12) * 3600000;
    const last = Number(this.store.setting('slang_last_extract_at', '0')) || 0;
    if (last && now - last < interval) return null;
    const group = this.groups()[0];
    if (!group) return null;
    try { return await this.extract({ group }); }
    catch (error) { this.log('slang_auto_extract_failed'); return { error: String(error?.message ?? error) }; }
  }

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
    return { version: 1, exportedAt: this.now(), entries: this.store.exportSlang() };
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
        created: row.created, updated: row.updated,
      })),
    };
  }

  // One entry, with the verbatim quote behind it. Explicit click only.
  entry(id) {
    const row = this.require(id);
    return { entry: { ...row, term: row.content } };
  }
}
