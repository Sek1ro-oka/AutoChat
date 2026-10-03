const validId = value => /^[1-9]\d{4,14}$/.test(value) && Number.isSafeInteger(Number(value));
const memberMatches = (info, group, user) => info && String(info.group_id) === group
  && String(info.user_id) === user && ['member', 'admin', 'owner'].includes(info.role);

export class AntiSpam {
  constructor(config, store, now, log) {
    this.config = config; this.store = store; this.now = now; this.log = log;
    this.streaks = new Map(); this.tail = Promise.resolve();
    this.queued = 0;
  }
  observe(event, call, alive) {
    const c = this.config, now = this.now();
    if (!c.antiSpamEnabled || event?.post_type !== 'message' || event.message_type !== 'group'
      || String(event.self_id) !== c.botId || !Array.isArray(event.message) || event.message_id == null
      || !Number.isFinite(event.time) || event.time * 1000 < now - 30000 || event.time * 1000 > now + 5000) return null;
    const group = String(event.group_id), user = String(event.user_id);
    if (!validId(user) || !(c.groupIds ?? [c.groupId]).includes(group)) return null;
    if (!this.store.claim(`${c.botId}:anti-spam:${group}:${user}:${event.message_id}`, now)) return null;
    if (user === c.botId) { this.streaks.delete(group); return null; }
    const time = event.time * 1000, previous = this.streaks.get(group);
    // Live ordered consecutive messages only; interrupted and expired streaks reset.
    if (previous && time < previous.last) return null;
    const times = previous?.user === user ? previous.times.filter(t => time - t <= c.antiSpamWindowMs) : [];
    times.push(time);
    this.streaks.set(group, { user, times: times.slice(-c.antiSpamCount), last: time });
    const key = `anti_spam_cooldown:${group}:${user}`;
    if (Number(this.store.setting(key, '0')) > now) return null;
    if (times.length < c.antiSpamCount) return null;
    this.streaks.delete(group);
    if (this.queued >= 20) { this.log('anti_spam_queue_full'); return null; }
    // Persist before submitting: unknown results are not retried, including after restart.
    this.store.set(key, now + Math.max(60000, c.antiSpamMuteSeconds * 1000));
    this.queued++;
    const job = this.tail.then(async () => {
      if (!alive() || this.now() - time > 30000) return false;
      try {
        const bot = await call('get_group_member_info', { group_id: Number(group), user_id: Number(c.botId), no_cache: true });
        if (!alive() || !memberMatches(bot, group, c.botId) || !['admin', 'owner'].includes(bot.role)) {
          this.log('anti_spam_no_permission'); return false;
        }
        const target = await call('get_group_member_info', { group_id: Number(group), user_id: Number(user), no_cache: true });
        if (!alive() || !memberMatches(target, group, user) || target.role !== 'member') return false;
        await call('set_group_ban', { group_id: Number(group), user_id: Number(user), duration: c.antiSpamMuteSeconds });
        this.log('anti_spam_muted');
        if (c.antiSpamReply && alive()) {
          try {
            await call('send_group_msg', { group_id: Number(group), message: [
              { type: 'at', data: { qq: user } }, { type: 'text', data: { text: ` ${c.antiSpamReply}` } },
            ] });
          } catch { this.log('anti_spam_notice_failed'); }
        }
        return true;
      } catch { this.log('anti_spam_failed'); return false; }
    }).catch(() => { this.log('anti_spam_failed'); return false; }).finally(() => { this.queued--; });
    this.tail = job;
    return job;
  }
}
