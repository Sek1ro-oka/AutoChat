// Slang extraction (V2 · Phase 4), split out of slang.js when per-group scoping
// pushed that file past the project's size ceiling.
//
// This is the half of the feature that *spends money*: it asks the model which
// terms in a recent group log look like local vocabulary and files them as
// candidates. Nothing here confirms anything — a human still has to tick the
// term in the console (see docs/slang.md).
//
// `Slang` extends this class, so the methods run with the same `this` — the
// store, the model, the ledger and the per-group parameter resolver all reach
// them unchanged.

import { budgetDay } from '../store.js';
import { costMicro, estimateInput, usageCost } from '../model.js';
import { escapeForPrompt } from './quote.js';
import { EXTRACT_SYSTEM, extractJsonArray, sanitiseCandidates } from './slang-parse.js';

// Stable per-run pseudonyms. QQ numbers never leave the machine in a prompt.
function labeller() {
  const names = new Map();
  return id => {
    const key = String(id);
    if (!names.has(key)) names.set(key, `成员${names.size + 1}`);
    return names.get(key);
  };
}

export class SlangExtraction {
  async extract({ group = null } = {}) {
    const allowed = this.groups();
    const target = group === null ? allowed[0] : String(group);
    if (!allowed.includes(target)) throw new Error('SLANG_PARAM_INVALID');
    // The switch is per group, so it is checked against the target rather than
    // globally: one group can be learning while another is left alone.
    if (!this.params(target).enabled) throw new Error('SLANG_DISABLED');
    const now = this.now();
    // Claim the interval slot before any await, so the maintenance timer cannot
    // start a second paid extraction while this one is still in flight.
    this.store.set('slang_last_extract_at', String(now));

    const rows = this.store.recentMessages(target, { limit: this.params(target).extractMessages });
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
        // A term learned in one group starts scoped to that group, so the
        // vocabulary does not leak into groups that never used it. The operator
        // can widen or clear the scope in the console.
        groups: [target],
        evidence: rows.filter(row => row.text.includes(candidate.term))
          .map(row => String(row.message_id)).slice(-3),
        now,
      });
      if (outcome.created) created += 1; else updated += 1;
    }
    this.store.trimSlang(this.entryCap);
    const summary = {
      group: target, at: now, scanned: rows.length, candidates: candidates.length,
      created, updated, dropped: parsed.length - candidates.length,
    };
    this.store.set('slang_last_extract', JSON.stringify(summary));
    this.log('slang_extracted');
    return summary;
  }

  // Periodic path. Off by default: a paid model call must not start on its own
  // unless the operator asked for it in .env. It picks the first group that has
  // the feature on, so a group with slang disabled is never scanned.
  async maybeExtract() {
    if (!this.config?.slangAutoExtract) return null;
    const group = this.groups().find(id => this.params(id).enabled);
    if (!group) return null;
    const now = this.now();
    const interval = Math.max(1, Number(this.config?.slangExtractIntervalHours) || 12) * 3600000;
    const last = Number(this.store.setting('slang_last_extract_at', '0')) || 0;
    if (last && now - last < interval) return null;
    try { return await this.extract({ group }); }
    catch (error) { this.log('slang_auto_extract_failed'); return { error: String(error?.message ?? error) }; }
  }
}
