// Poke-poke (戳一戳) — the notice half of the OneBot event stream.
//
// NapCat reports a poke as `post_type=notice, notice_type=notify, sub_type=poke`
// with `user_id` = who poked and `target_id` = who was poked
// (work/program/research/poke-feature.md §3). Sending is a protocol extension
// (`send_poke`) and its reply is `null`, so there is no message id to correlate:
// an echo of our own poke can only be recognised by its shape and by what this
// process just sent.
//
// That echo is the whole risk, so every mode is decided before anything is
// counted or sent:
//   off    — nothing at all, not even a log line;
//   reply  — one text message, never a poke action (the default);
//   active — the same, plus `send_poke` back, still under both limits.
//
// Deliberately a runtime participant instead of a branch in `Bot.ingest`:
// `parseEvent` drops every non-message event and the message pipeline (dedupe
// key, 20-item queue, serial `tail`) is built around messages, so a notice must
// not enter it. `runtime.dispatch` hands the raw event to every participant,
// which is why `src/bot.js` needs no change at all.
import { budgetDay } from './store.js';
import { errorDetail } from './logger.js';

export const POKE_MODES = Object.freeze(['off', 'reply', 'active']);

// How long a poke we sent counts as "may still come back as an echo". Ten
// seconds is far longer than one round trip and far shorter than the default
// 30s cooldown, so a real second poke is never swallowed for long.
const ECHO_MS = 10000;

// Nothing in either map is needed an hour later: the cooldown ceiling is 3600s
// and the echo window is 10s. Dropping older entries on write keeps both maps
// proportional to live traffic instead of to every user ever seen.
const KEEP_MS = 3600000;

export class Poke {
  constructor({ config, store, log = () => {}, now = Date.now }) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.now = now;
    // In-process state only. A cooldown is one timestamp per user, it expires by
    // itself, and a restart is an operator action rather than something a poke
    // flood can trigger. The *daily cap* is the limiter that has to survive a
    // restart, and it lives in `settings` rows via `store.bump`.
    this.cooldowns = new Map();
    this.outgoing = new Map();
  }

  // Three readers need "are we doing anything at all": `observe`, the console's
  // controls, and the tests. `store.setting('enabled','1')` is the console's
  // global bot switch — a bot that has been stopped must not answer a poke either,
  // the same rule QZone applies. `POKE_ENABLED` is the master switch and
  // `POKE_MODE` says what "on" means, so both are required; `off` is kept as a
  // mode because it silences the feature while leaving the other knobs in place.
  enabled() {
    return this.config.pokeEnabled === true
      && this.mode() !== 'off'
      && this.store.setting('enabled', '1') === '1';
  }

  mode() {
    const mode = String(this.config.pokeMode ?? '').trim();
    return POKE_MODES.includes(mode) ? mode : 'reply';
  }

  cooldownMs() {
    const seconds = Number(this.config.pokeCooldownSeconds);
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 30) * 1000;
  }

  dailyLimit() {
    const limit = Number(this.config.pokeDailyLimit);
    return Number.isFinite(limit) && limit >= 0 ? limit : 20;
  }

  // One quota bucket per group, one per user in private chat: the cap exists so a
  // single noisy scope cannot spend the bot's whole poke budget, and a private
  // chat has no group to be counted against. Same shape as
  // `social_count:${day}:${group}` in src/social/gates.js.
  bucketOf(poke, now) {
    const scope = poke.groupPoke ? `group:${poke.group}` : `private:${poke.from}`;
    return `poke_count:${budgetDay(now)}:${scope}`;
  }

  // The key of "we poked this peer here", used both to record an outgoing poke and
  // to recognise its echo. Group ids are digits, so they cannot collide with the
  // literal `private`.
  peerKey(poke, user) {
    return poke.groupPoke ? `${poke.group}:${user}` : `private:${user}`;
  }

  // Logs carry a category, never an id: docs/security.md §3.3 restricts `detail`
  // to labels, reasons, counts and error summaries.
  kindOf(poke) { return poke.groupPoke ? 'group' : 'private'; }

  // `null` = "not a poke we have any business with". Pure: no logging, no writes,
  // so it is cheap enough to be the first thing `observe` calls.
  parse(event) {
    if (!event || typeof event !== 'object') return null;
    if (event.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'poke') return null;
    const self = String(this.config.botId ?? '');
    if (!self || String(event.self_id ?? '') !== self) return null;
    const group = event.group_id === undefined || event.group_id === null ? '' : String(event.group_id);
    const from = String(event.user_id ?? '');
    // In private chat the target is the bot by definition, and some protocol
    // layers omit `target_id` there, so fall back to the bot rather than drop it.
    const to = String(event.target_id ?? (group ? '' : self));
    if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return null;
    return { self, group, from, to, groupPoke: group !== '' };
  }

  prune(now) {
    for (const [user, at] of this.cooldowns) if (now - at >= KEEP_MS) this.cooldowns.delete(user);
    for (const [key, at] of this.outgoing) if (now - at >= ECHO_MS) this.outgoing.delete(key);
  }

  // True when the event is our own poke coming back. Two shapes are in the wild:
  //   (a) `user_id === self_id` — the bot is the poker, which is what the
  //       CyberGroupmate fix filters on (research §3, PR #97);
  //   (b) `target_id === self_id` with the peer as `user_id` — the shape the
  //       research records for NapCat's echo of an outgoing poke.
  // (a) is decided by the id alone. (b) cannot be: "the bot was poked" is also the
  // normal, wanted case, so it only counts as an echo when this process poked that
  // same peer moments ago and the record is still inside ECHO_MS.
  echo(poke, now) {
    if (poke.from === poke.self) {
      this.log('poke_self_echo', { shape: 'poker' });
      return true;
    }
    const at = this.outgoing.get(this.peerKey(poke, poke.from));
    if (poke.to === poke.self && at !== undefined && now - at < ECHO_MS) {
      this.log('poke_self_echo', { shape: 'target' });
      return true;
    }
    return false;
  }

  // The participant. Everything up to the first `await` is synchronous, which is
  // what makes "read the counter, then bump it" safe: one event loop, and a second
  // instance on the same database is excluded by the single-instance lock. `bump`
  // runs its own transaction for the same reason.
  async observe(event, send, alive = () => true) {
    try {
      if (!this.enabled()) return false;
      const poke = this.parse(event);
      if (!poke) return false;
      const now = this.now();
      this.prune(now);
      if (this.echo(poke, now)) return false;
      // In a group only a poke aimed at the bot is our business: members poking
      // each other is their conversation, not ours.
      if (poke.groupPoke && poke.to !== poke.self) return false;
      const text = String(this.config.pokeReplyText ?? '').trim();
      const pokeBack = this.mode() === 'active';
      // An empty reply text in `reply` mode is a configured silence: return before
      // the cooldown and the counter, so a bot that says nothing does not spend a
      // group's budget on nothing.
      if (!text && !pokeBack) return false;
      const kind = this.kindOf(poke);
      const last = this.cooldowns.get(poke.from);
      if (last !== undefined && now - last < this.cooldownMs()) {
        this.log('poke_rate_limited', { reason: 'cooldown', scope: kind });
        return false;
      }
      const key = this.bucketOf(poke, now);
      if ((Number(this.store.setting(key, '0')) || 0) >= this.dailyLimit()) {
        this.log('poke_rate_limited', { reason: 'daily', scope: kind });
        return false;
      }
      if (typeof alive === 'function' && !alive()) {
        this.log('poke_skipped_offline', { scope: kind });
        return false;
      }
      // Charge the quota before the first `await`: a request that fails still left
      // the process, and "failures are free" is exactly what would let a loop burn
      // the connection this cap protects. The cooldown starts here too, so a
      // retry-shaped echo cannot slip in between the decision and the send.
      this.store.bump(key, 1);
      this.cooldowns.set(poke.from, now);
      await this.reply(poke, text, send);
      if (pokeBack) await this.pokeBack(poke, send);
      this.log('poke_handled', { mode: this.mode(), scope: kind });
      return true;
    } catch (error) {
      this.log('poke_failed', errorDetail(error));
      return false;
    }
  }

  // Text only, on the message path the answering bot already uses. Never retried:
  // a poke is not important enough to double-send into a broken connection.
  async reply(poke, text, send) {
    if (!text) return false;
    const message = [{ type: 'text', data: { text } }];
    const action = poke.groupPoke ? 'send_group_msg' : 'send_private_msg';
    const target = poke.groupPoke ? { group_id: Number(poke.group) } : { user_id: Number(poke.from) };
    try { await send(action, { ...target, message }); return true; }
    catch (error) { this.log('poke_reply_failed', errorDetail(error)); return false; }
  }

  // `send_poke` is the generic NapCat action; `group_id` decides which packet goes
  // out (`group_poke`) and its absence the private one (`friend_poke`) — research
  // §2.2. Only `user_id` is passed: the schema falls back to it when `target_id`
  // is missing, so that is one field fewer to get wrong. The record is written
  // *before* the call because the echo can arrive before the action resolves.
  async pokeBack(poke, send) {
    const params = poke.groupPoke
      ? { group_id: Number(poke.group), user_id: Number(poke.from) }
      : { user_id: Number(poke.from) };
    this.outgoing.set(this.peerKey(poke, poke.from), this.now());
    try { await send('send_poke', params); return true; }
    catch (error) { this.log('poke_action_failed', errorDetail(error)); return false; }
  }
}
