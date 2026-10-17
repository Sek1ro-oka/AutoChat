// Autonomous QQ Zone posting (I-09).
//
// One question, asked on the 30s maintenance tick: "did enough interesting
// chatter pile up to be worth one post?" Nothing schedules a post for a time of
// day — the trigger is the material batch (dev plan §3), so a quiet day spends
// nothing and publishes nothing.
//
// Order, and why: material (free rules) → gates (window, daily cap, min gap,
// budget; a day at its cap is not evaluated at all) → one model call that both
// judges and writes → outbound gate (absolute rules) → `send_qzone_msg`, exactly
// once. Publishing is not idempotent, so there is no retry loop: every exit path
// either published or decided not to.
//
// The batch is consumed (cursor advances) on every *decision* — "not worthy",
// "blocked", "the model failed" — because re-judging the same eight messages
// every 30 seconds would burn the budget to reach the same answer. A gate that
// merely says "not now" does not consume: that material belongs to a later tick.
//
// The post text goes to `qzone_posts` for the console and never to a log line:
// `qzone_sent` / `qzone_blocked` carry an enum and a length only (§12.11).
import { randomUUID } from 'node:crypto';
import { budgetDay } from './store.js';
import { costMicro, estimateInput, usageCost } from './model.js';
import { errorDetail } from './logger.js';
import { escapeForPrompt, parseSegments } from './social/quote.js';
import { MAX_BATCH, selectMaterial } from './qzone-material.js';
import { guardPost } from './qzone-guard.js';

export const CURSOR_KEY = 'qzone:cursor';
// NapCat/QZone error codes (research §1.5): one means "slow down for today",
// six mean "this account or this action will not work".
export const RATE_LIMIT_CODES = Object.freeze([-10000]);
export const AUTH_CODES = Object.freeze([-3, -100, -3000, -10001, -10006]);
// Ledger rows read per group per tick. A batch is at most MAX_BATCH anyway.
const MATERIAL_WINDOW = 200;
const TID_FIELDS = ['tid', 't1_tid'];

// What turns a persona into someone writing a short post. Kept next to the
// parser below because the two must agree on the shape of the answer.
export const POST_ADDENDUM = [
  '你在看一段群聊记录。判断里面有没有值得写成一条 QQ 空间说说的事情：一个观察、一点心情、一件小事。',
  '没有就明确说没有——宁可不说，也不要为了发而发。',
  '有就写一条：只写你自己的感受和想法，不要复述任何人的原话，不要出现姓名、昵称、群号、QQ 号、链接或 @。',
  '长度 10~60 字，口语，不要分段，最多 2 个 emoji，不要像广告。',
  '只输出 JSON，不要代码块、不要解释：{"worthy":true,"text":"说说正文"} 或 {"worthy":false}',
].join('\n');

// One balanced `{...}` starting at `start`, or -1. Quotes are honoured so a
// brace inside the post text cannot end the object early.
function matchBrace(source, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { if (quoted) escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// The reply is one JSON object. A chatty preamble or a ``` fence must not be
// mistaken for an answer, so this scans for the first balanced object that
// parses and carries a boolean `worthy` — the same defensive shape as
// social/slang-parse.js, and for the same reason: a greedy regex would happily
// match a sentence that quotes a JSON example. Returns null when nothing is
// parseable, which the caller reports loudly rather than as "not worthy".
export function parseDecision(source) {
  const text = String(source ?? '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchBrace(text, start);
    if (end === -1) continue;
    let value;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
    if (!value || typeof value.worthy !== 'boolean') continue;
    return { worthy: value.worthy, text: typeof value.text === 'string' ? value.text.trim() : '' };
  }
  return null;
}

// Whether a Beijing hour falls inside a `H-H` window such as 9-23. Same rule as
// SOCIAL_IDLE_HOURS; `validHours` in src/social/params.js is a private helper of
// that module, so the check is repeated here rather than exported from it.
export function hourAllowed(hour, spec) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(spec ?? ''));
  if (!match) return false;
  return hour >= Number(match[1]) && hour <= Number(match[2]);
}

// The numeric code, from a thrown error or a resolved payload. `transport.call`
// rejects with a message rather than a retcode (src/onebot.js collapses every
// remote rejection into ONEBOT_ACTION_FAILED), so both shapes are read here.
export function codeOf(value) {
  for (const candidate of [value?.code, value?.retcode, value?.errCode, value?.data?.retcode]) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  const match = /(?:^|[^\d-])(-\d{1,6})(?!\d)/.exec(String(value?.message ?? ''));
  return match ? Number(match[1]) : null;
}

export function chinaTime(at) {
  return `${new Date(Number(at) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}`;
}

export class QZone {
  constructor({
    config, store, model, ledger = null, personas = null, log = () => {}, now = Date.now,
  } = {}) {
    this.config = config;
    this.store = store;
    this.model = model;
    this.ledger = ledger;
    this.personas = personas;
    this.log = log;
    this.now = now;
    this.running = false;      // one evaluation at a time
    this.unavailable = false;  // auth is broken: off for the rest of the process
  }

  grouped() { return this.config.groupIds ?? [this.config.groupId]; }

  // Both switches: the QZone switch, and the console's global "bot enabled" row.
  // A bot that has been switched off must not publish anything either.
  enabled() {
    return this.config.qzoneEnabled === true && this.store.setting('enabled', '1') === '1';
  }

  hour(now = this.now()) { return new Date(now + 8 * 3600000).getUTCHours(); }

  cursor() { return Number(this.store.setting(CURSOR_KEY, '0')) || 0; }

  // --- material intake ------------------------------------------------------
  // `messages` is shared with the social simulation, and with SIM off
  // (`SOCIAL_ENABLED=false`, the default) nothing would ever write it — so QZone
  // records whitelisted group messages itself. INSERT OR REPLACE by
  // (group_id, message_id) makes a second writer harmless. Private chats never
  // reach the store: this returns before that for any non-group event.
  observe(event) {
    try {
      if (!this.enabled()) return false;
      if (!event || event.post_type !== 'message' || event.message_type !== 'group') return false;
      if (String(event.self_id ?? '') !== String(this.config.botId)) return false;
      const group = String(event.group_id ?? '');
      if (!this.grouped().includes(group)) return false;
      const user = String(event.user_id ?? '');
      if (!/^\d+$/.test(user) || user === String(this.config.botId)) return false;
      if (event.message_id === null || event.message_id === undefined) return false;
      const parsed = parseSegments(event.message);
      if (!parsed.text) return false;
      const now = this.now();
      const time = Number(event.time);
      // `event.time` is seconds and could be replayed; a timestamp far from now
      // would fall outside every TTL anyway, so clamp instead of trusting it.
      const at = Number.isFinite(time) && Math.abs(now / 1000 - time) <= 300 ? time * 1000 : now;
      this.store.noteMessage({
        groupId: group, messageId: String(event.message_id), userId: user, at,
        text: parsed.text, kind: parsed.hasImage ? 'image' : 'text',
      });
      return true;
    } catch (error) { this.log('qzone_observe_failed', errorDetail(error)); return false; }
  }

  // --- the tick -------------------------------------------------------------
  // Called with the transport's `call`, exactly like `social.idleTick`. Never
  // throws: a broken tick must not take the maintenance timer down with it.
  async tick(call, alive = () => true) {
    if (this.running || this.unavailable || !this.enabled()) return false;
    this.running = true;
    try { return await this.evaluate(call, alive); }
    catch (error) { this.log('qzone_failed', errorDetail(error)); return false; }
    finally { this.running = false; }
  }

  async evaluate(call, alive) {
    const now = this.now();
    const day = budgetDay(now);
    // A rate-limited day stops before any material is read: the flag exists so
    // that later ticks cost nothing at all (dev plan §9).
    if (this.store.setting(`qzone:blocked:${day}`, '0') === '1') return false;
    const batch = this.batch(now);
    if (!batch.length) return false;
    const refused = this.gate(now);
    if (refused) { this.log(refused); return false; }

    const messages = this.request(batch);
    const sessionKey = `qzone:${day}`;
    const estimate = costMicro(estimateInput(messages), Number(this.config.qzoneModelOutputTokens), this.config);
    const reservation = this.store.reserve(day, estimate, this.config.budgetMicro, now, { sessionKey });
    if (!reservation) { this.log('qzone_budget_short'); return false; }

    const client = this.client();
    let result;
    try { result = await client.complete(messages); }
    catch (error) {
      this.store.uncertain(reservation);
      this.log('qzone_model_failed', errorDetail(error));
      this.consume(batch);
      return false;
    }
    if (!alive()) { this.store.settle(reservation, 0); return false; }
    const actual = usageCost(result?.usage, this.config);
    if (actual === null) this.store.uncertain(reservation);
    else { this.store.settle(reservation, actual); this.sample(sessionKey, result?.usage); }

    const decision = parseDecision(result?.text);
    if (!decision) { this.log('qzone_skipped', { reason: 'unparsed' }); this.consume(batch); return false; }
    if (!decision.worthy) { this.log('qzone_skipped', { reason: 'unworthy' }); this.consume(batch); return false; }
    if (!decision.text) { this.log('qzone_skipped', { reason: 'empty' }); this.consume(batch); return false; }

    const text = decision.text;
    const verdict = guardPost(text, {
      groupIds: this.grouped(),
      blockTerms: this.config.blockTerms ?? [],
      recent: this.store.qzoneRecentTexts(3),
    });
    if (!verdict.ok) {
      this.record({ text, status: 'blocked', reason: verdict.reason });
      this.log('qzone_blocked', { reason: verdict.reason, len: verdict.len });
      this.consume(batch);
      return false;
    }
    if (this.config.qzoneDryRun) {
      this.record({ text, status: 'drafted', reason: 'dry_run' });
      this.log('qzone_drafted', { len: verdict.len });
      this.consume(batch);
      return true;
    }
    return this.publish(call, text, verdict, batch, now);
  }

  // --- publishing (exactly once) -------------------------------------------
  async publish(call, text, verdict, batch) {
    const ugcRight = Number(this.config.qzoneUgcRight) || 4;
    let response;
    try { response = await call('send_qzone_msg', { content: text, ugc_right: ugcRight }); }
    catch (error) { this.failed(text, error); this.consume(batch); return false; }
    const code = codeOf(response);
    const trip = this.tripFor(code);
    if (trip) { this.trip(trip, code, text); this.consume(batch); return false; }
    const tid = TID_FIELDS.map(field => response?.[field]).find(value => value !== undefined && value !== null);
    const tidText = tid === undefined ? '' : String(tid).trim();
    // No tid means NapCat could not confirm a post: treat it as a failure and
    // never re-send, because the post may well exist (research §1.5).
    if (!tidText) {
      this.record({ text, status: 'failed', reason: 'no_tid' });
      this.log('qzone_send_failed', { reason: 'no_tid' });
      this.consume(batch);
      return false;
    }
    this.record({ text, status: 'sent', tid: tidText });
    this.log('qzone_sent', { len: verdict.len, ugc_right: ugcRight });
    this.consume(batch);
    await this.notify(call, text);
    return true;
  }

  // "发完再告诉我" (I-09 D3): the admin gets the text and its time by DM. A
  // failure here never touches the post — it is published, and the row in
  // `qzone_posts` is the record of that.
  async notify(call, text) {
    try {
      await call('send_private_msg', {
        user_id: String(this.config.adminId),
        message: `刚发了一条空间说说（${chinaTime(this.now())}）：\n${text}`,
      });
    } catch (error) { this.log('qzone_notify_failed', errorDetail(error)); }
  }

  // A trip disables further attempts: for the rest of the day on a rate limit,
  // for the rest of the process on an auth failure (dev plan §9). Both are
  // recorded once, and neither retries.
  tripFor(code) {
    if (code === null) return null;
    if (RATE_LIMIT_CODES.includes(code)) return 'rate';
    if (AUTH_CODES.includes(code)) return 'auth';
    return null;
  }

  trip(kind, code, text) {
    if (kind === 'rate') {
      this.store.set(`qzone:blocked:${budgetDay(this.now())}`, '1');
      this.record({ text, status: 'failed', reason: 'rate_limited' });
      this.log('qzone_rate_limited');
      return;
    }
    this.unavailable = true;
    this.record({ text, status: 'failed', reason: 'unavailable' });
    this.log('qzone_unavailable', code === null ? {} : { code });
  }

  failed(text, error) {
    const code = codeOf(error);
    const trip = this.tripFor(code);
    if (trip) { this.trip(trip, code, text); return; }
    // Every remote rejection the transport cannot classify arrives as
    // ONEBOT_ACTION_FAILED. Treating it as the auth case is the conservative
    // reading: a rejected action must not be attempted again in this process.
    if (String(error?.message ?? '') === 'ONEBOT_ACTION_FAILED') { this.trip('auth', null, text); return; }
    this.record({ text, status: 'failed', reason: 'send_failed' });
    this.log('qzone_send_failed', errorDetail(error));
  }

  // --- material, gates, cost -----------------------------------------------
  batch(now) {
    const ttlMs = Number(this.config.qzoneMaterialTtlHours) * 3600000;
    const rows = [];
    for (const group of this.grouped()) {
      rows.push(...this.store.recentMessages(group, { since: now - ttlMs, limit: MATERIAL_WINDOW }));
    }
    const material = selectMaterial(rows, {
      now, ttlMs, groupIds: this.grouped(), botId: this.config.botId,
      blockTerms: this.config.blockTerms ?? [], cursor: this.cursor(),
    });
    if (material.length < Number(this.config.qzoneBatchMin)) return [];
    return material.slice(0, MAX_BATCH);
  }

  // The two frequency gates and the hour window (dev plan §6). The cap counts
  // drafts as well as published posts: a dry run must not become an unbounded
  // money pump on a day when nothing is published.
  gate(now) {
    const day = budgetDay(now);
    const posts = this.store.qzonePostsSince(Date.parse(`${day}T00:00:00+08:00`));
    if (posts.length >= Number(this.config.qzoneMaxPerDay)) return 'qzone_daily_cap';
    const last = Number(posts[0]?.at ?? 0);
    if (last && now - last < Number(this.config.qzoneMinGapHours) * 3600000) return 'qzone_min_gap';
    if (!hourAllowed(this.hour(now), this.config.qzoneHours)) return 'qzone_window';
    return null;
  }

  // The cursor is the highest `at` that has been evaluated. Messages arriving in
  // the same millisecond as the upper bound are skipped by it — a millisecond of
  // chatter is a fair price for never evaluating the same batch twice.
  consume(batch) {
    const last = Number(batch?.[batch.length - 1]?.at);
    if (!Number.isFinite(last) || last <= this.cursor()) return;
    this.store.set(CURSOR_KEY, last);
  }

  record({ text, status, reason = '', tid = '' }) {
    try {
      this.store.noteQzonePost({
        id: randomUUID(), at: this.now(), text, status, reason, tid,
        ugcRight: Number(this.config.qzoneUgcRight) || 4,
      });
    } catch (error) { this.log('qzone_record_failed', errorDetail(error)); }
  }

  // QZONE_MODEL_OUTPUT_TOKENS caps generation, so the reservation above is an
  // upper bound rather than a guess. A model without `forProfile` (a test stub)
  // is used as it is.
  client() {
    const tokens = Number(this.config.qzoneModelOutputTokens);
    return typeof this.model?.forProfile === 'function' ? this.model.forProfile({ maxOutput: tokens }) : this.model;
  }

  sample(sessionKey, usage) {
    if (!this.ledger) return null;
    return this.ledger.sample(this.ledger.begin(sessionKey), usage, this.config, this.now());
  }

  // The prompt: the persona (behaviour layer + card), then the material with
  // members relabelled — a QQ number or a nickname never enters it. Group text
  // is flattened and escaped by social/quote.js, so a member cannot forge our
  // markers or smuggle instructions in.
  request(batch) {
    const labels = new Map();
    const name = user => {
      if (!labels.has(user)) labels.set(user, `群友${labels.size + 1}`);
      return labels.get(user);
    };
    const lines = batch.map(row => `${name(row.userId)}：${escapeForPrompt(row.text, 120)}`);
    return [
      { role: 'system', content: `${this.systemPrompt()}\n\n${POST_ADDENDUM}` },
      { role: 'user', content: ['[群聊素材开始]', ...lines, '[群聊素材结束]', '请只输出 JSON，不要代码块。'].join('\n') },
    ];
  }

  systemPrompt() {
    if (!this.personas) return this.config.systemPrompt;
    try { return this.personas.resolve(); }
    catch { this.log('qzone_persona_failed'); return this.config.systemPrompt; }
  }
}
