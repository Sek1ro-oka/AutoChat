import { budgetDay } from './store.js';
import { estimateInput, costMicro, prepareMessages, usageCost } from './model.js';
import { containsTerm, findTerm, matchesInputRule, RULE_REPLY } from './terms.js';
import { isGroupManagementCommand, manageGroup } from './group-management.js';

const HELP = '私聊直接发送文本；群聊请@机器人。/帮助 /状态 /清空。消息与当前会话上下文会发送给配置的模型服务商。';
const fmt = micro => (micro / 1e6).toFixed(4);

export function parseEvent(event, config, now = Date.now()) {
  if (!event || event.post_type !== 'message' || String(event.self_id) !== config.botId
      || String(event.user_id) === config.botId || event.message_id == null
      || !Number.isFinite(event.time) || Math.abs(now / 1000 - event.time) > 300
      || !Array.isArray(event.message)) return null;
  const user = String(event.user_id);
  if (!/^\d+$/.test(user)) return null;
  const text = event.message.filter(item => item?.type === 'text' && typeof item.data?.text === 'string')
    .map(item => item.data.text).join('').trim();
  const group = event.message_type === 'group';
  if (group) {
    if (!(config.groupIds ?? [config.groupId]).includes(String(event.group_id))
        || (!event.message.some(item => item?.type === 'at' && String(item.data?.qq) === config.botId)
          && !(config.groupKeywordWithoutAt && matchesInputRule(text, config)))) return null;
  } else if (event.message_type !== 'private'
    || (![...(config.privateUsers ?? [config.privateUser]), config.adminId].includes(user)
      && !(config.groupManagementEnabled && user === config.groupManagerId && isGroupManagementCommand(text)))) return null;
  if (!group && !text) return null;
  const scope = group ? `group:${event.group_id}` : 'private';
  return {
    user, group, text, scope, key: `${scope}:${user}`,
    eventKey: `${config.botId}:${scope}:${user}:${event.message_id}`,
    target: group ? { group_id: Number(event.group_id) } : { user_id: Number(user) },
    action: group ? 'send_group_msg' : 'send_private_msg',
  };
}

export class Bot {
  constructor(config, store, model, { now = Date.now, log = () => {} } = {}) {
    this.config = config; this.store = store; this.model = model;
    this.now = now; this.log = log; this.tail = Promise.resolve(); this.queued = 0;
    this.limits = new Map(); this.lastNotice = new Map(); this.sendFailures = 0;
    for (const id of config.groupIds ?? [config.groupId]) store.ensureGroup(id, now(), config.clearMs);
    this.maintenance();
  }
  maintenance() {
    this.store.cleanupGroups(this.now(), this.config.clearMs);
    this.store.pruneEvents(this.now());
  }
  tick() {
    // At most one maintenance job pending; it runs between complete turns.
    if (this.tickPending) return;
    this.tickPending = true;
    this.tail = this.tail.then(() => this.maintenance()).catch(() => this.log('maintenance_failed'))
      .finally(() => { this.tickPending = false; });
  }
  ingest(event, send, alive = () => true) {
    const message = parseEvent(event, this.config, this.now());
    if (!message) return Promise.resolve(false);
    if (!this.store.claim(message.eventKey, this.now())) return Promise.resolve(false);
    if (this.queued >= 20) {
      this.log('queue_full');
      if (this.now() - (this.lastNotice.get(message.key) ?? -Infinity) >= 60000) {
        this.lastNotice.set(message.key, this.now());
        return this.reply(message, '当前排队较多，请稍后再试。', send, alive).then(() => false);
      }
      return Promise.resolve(false);
    }
    this.queued++;
    const job = this.tail.then(async () => {
      if (!alive()) return false;
      this.maintenance();
      await this.handle(message, send, alive);
      return true;
    }).catch(() => { this.log('turn_failed'); return false; }).finally(() => { this.queued--; });
    this.tail = job;
    return job;
  }
  limited(message) {
    const now = this.now();
    const keys = [[`user:${message.user}`, 3]];
    if (message.group) keys.push([message.scope, 10]);
    for (const [key] of keys) this.limits.set(key, (this.limits.get(key) || []).filter(x => now - x < 60000));
    if (keys.some(([key, max]) => this.limits.get(key).length >= max)) return true;
    for (const [key] of keys) this.limits.get(key).push(now);
    return false;
  }
  blocked(text) { return containsTerm(text, this.config.blockTerms); }
  async reply(message, text, send, alive) {
    if (!alive()) return false;
    try {
      await send(message.action, { ...message.target, message: [{ type: 'text', data: { text } }] });
      this.sendFailures = 0;
      return true;
    } catch {
      this.sendFailures++;
      if (this.sendFailures >= 3) this.store.set('enabled', '0');
      this.log('send_failed');
      return false;
    }
  }
  async handle(message, send, alive) {
    const { config, store } = this;
    const reply = text => this.reply(message, text, send, alive);
    const text = message.text;
    const admin = !message.group && message.user === config.adminId;
    const adminCommands = new Map([
      ['/停止', ['enabled', '0', '已停止模型回复。']], ['/启动', ['enabled', '1', '已启用模型回复。']],
      ['/群关闭', ['groupEnabled', '0', '已关闭群回复。']], ['/群开启', ['groupEnabled', '1', '已启用群回复。']],
    ]);
    if (adminCommands.has(text)) {
      if (!admin) return reply('此命令仅限管理员私聊使用。');
      const [key, value, notice] = adminCommands.get(text);
      store.set(key, value); this.sendFailures = 0;
      return reply(notice);
    }
    if (this.limited(message)) {
      if (this.now() - (this.lastNotice.get(message.key) ?? -Infinity) >= 60000) {
        this.lastNotice.set(message.key, this.now()); await reply('请求较频繁，请稍后再试。');
      }
      return;
    }
    if (isGroupManagementCommand(text)) {
      const notice = await manageGroup(message, config, send, alive, this.log);
      if (notice) await reply(notice);
      return;
    }
    if (text === '/状态') {
      if (!admin) return reply('运行状态仅限管理员私聊查看。');
      const balance = store.balance(budgetDay(this.now()), config.budgetMicro);
      const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong',
        dateStyle: 'short', timeStyle: 'medium' });
      const due = (config.groupIds ?? [config.groupId]).map(id =>
        `${id}：${formatter.format(store.groupDue(id))}`).join('\n');
      return reply(`模型：${config.model}\n回复：${store.setting('enabled', '1') === '1' ? '启用' : '停止'}\n群回复：${store.setting('groupEnabled', '1') === '1' ? '启用' : '关闭'}\n今日保守计费 ¥${fmt(balance.used)}／预留 ¥${fmt(balance.held)}／剩余 ¥${fmt(balance.remaining)}\n下次群清理：${due}（香港时间）`);
    }
    if (text === '/清空') { store.clear(message.key); return reply('已清空当前会话。'); }
    if (store.setting('enabled', '1') !== '1' || (message.group && store.setting('groupEnabled', '1') !== '1')) return;
    if (this.blocked(text)) return reply(RULE_REPLY);
    const trigger = findTerm(text, config.triggerTerms);
    if (trigger !== undefined) return reply(trigger);
    if (!text || text === '/帮助') return reply(HELP);
    if (text.startsWith('/')) return reply('未知命令。发送 /帮助 查看用法。');
    let messages;
    try { messages = prepareMessages(store.history(message.key), text, config); }
    catch { return reply('这条消息太长，请缩短后重试。'); }
    const day = budgetDay(this.now());
    const estimate = () => costMicro(estimateInput(messages), config.maxOutput, config);
    // Shrink prior history further when the monetary budget is tighter than context capacity.
    const available = store.balance(day, config.budgetMicro).remaining;
    while (messages.length > 2 && estimate() > available) messages.splice(1, 2);
    const reservation = store.reserve(day, estimate(), config.budgetMicro, this.now());
    if (!reservation) return reply('今日模型预算不足或已停止，明日恢复；可使用 /清空。');
    let result;
    try {
      result = await this.model.complete(messages);
      const actual = usageCost(result.usage, config);
      if (actual === null) store.uncertain(reservation); else store.settle(reservation, actual);
    } catch {
      store.uncertain(reservation);
      this.log('model_failed');
      return reply('模型暂时不可用，请稍后再试。此次费用预留暂不释放。');
    }
    if (!result.text) return reply('模型没有返回可用文本，请稍后再试。');
    if (this.blocked(result.text)) return reply(RULE_REPLY);
    const output = Array.from(result.text).slice(0, 3500).join('');
    const answer = output.length < result.text.length ? `${output}\n（回复过长，已截断）` : output;
    if (await reply(answer)) {
      store.save(message.key, message.scope, [...messages.slice(1), { role: 'assistant', content: answer }]);
    }
  }
}
