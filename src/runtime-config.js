// Runtime-configurable settings (V2).
//
// Most non-secret, non-startup knobs used to live only in `.env`, so changing
// them meant editing a file and restarting. This module turns the ones worth
// touching at runtime into `settings` rows, the same pattern the social
// simulation and the slang library already use: the `.env` value stays the
// default, and a stored row overrides it until it is cleared again.
//
// The single source of truth is `FIELDS` below. Two callers must agree on it:
// the readers (every component that reads `config.xxx` through the proxy) and
// the writer (the console's settings page). A drift would be silent — the page
// would "save" a value nothing ever reads — so the proxy resolves every field
// through this one table instead of ad-hoc `store.setting` calls.
//
// Secrets (`apiKey`, `onebotToken`, `consoleToken`) and startup-only values
// (`botId`, `wsUrl`, `baseUrl`, `databasePath`, `consoleEnabled`, `consolePort`,
// `modelProfiles`, `personaDirectory`) are deliberately absent: they must stay
// in `.env` and cannot be changed without a restart.

const QQ = /^[1-9]\d{4,14}$/;
const validQQ = value => QQ.test(String(value)) && Number.isSafeInteger(Number(value));
const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const listOf = text => String(text ?? '').split(',').map(item => item.trim()).filter(Boolean);

// Display order; the console renders one section per group.
export const GROUPS = Object.freeze([
  ['budget', '预算与价格'],
  ['model', '模型'],
  ['whitelist', '白名单'],
  ['search', '联网搜索'],
  ['vision', '图片识别'],
  ['group', '群管理'],
  ['antispam', '防刷屏'],
  ['terms', '触发与屏蔽词'],
  ['bot', '机器人身份'],
]);

// One entry per configurable field. `name` is the `config` property, `key` the
// `settings` row. `toText`/`fromText` translate between the config's internal
// unit and the human unit stored in the row (defaults are per-`kind`).
const FIELDS = Object.freeze([
  // --- budget & pricing -----------------------------------------------------
  { name: 'budgetMicro', key: 'cfg:budget_cny', kind: 'number', group: 'budget', label: '每日预算（元）', hint: '问答与仿真共用；保守估算，改大才可能放行更多调用。',
    min: 0.000001, max: 100, toText: v => String(v / 1e6), fromText: t => Math.round(Number(t) * 1e6) },
  { name: 'inputPrice', key: 'cfg:input_price', kind: 'number', group: 'budget', label: '输入价（元/百万 token）', min: 0.000001, max: 10000 },
  { name: 'outputPrice', key: 'cfg:output_price', kind: 'number', group: 'budget', label: '输出价（元/百万 token）', min: 0.000001, max: 10000 },
  { name: 'cacheHitPrice', key: 'cfg:cache_hit_price', kind: 'number', group: 'budget', label: '缓存命中价（元/百万 token）', hint: '留空 = 沿用 DeepSeek 官方比例；只影响报表，不影响预算预留。',
    min: 0.000001, max: 10000, toText: v => (v === null || v === undefined ? '' : String(v)), fromText: t => (t === '' ? null : Number(t)) },
  { name: 'offPeakRatio', key: 'cfg:offpeak_ratio', kind: 'number', group: 'budget', label: '空闲时段折扣比', min: 0.01, max: 1 },
  { name: 'priceDate', key: 'cfg:price_date', kind: 'date', group: 'budget', label: '价格核实日期' },
  { name: 'costHolidays', key: 'cfg:cost_holidays', kind: 'datelist', group: 'budget', label: '计费节假日', hint: '逗号分隔的 YYYY-MM-DD；空表示无额外节假日。' },
  // --- model ----------------------------------------------------------------
  { name: 'model', key: 'cfg:model', kind: 'string', group: 'model', label: '模型名', max: 64 },
  { name: 'maxOutput', key: 'cfg:max_output', kind: 'integer', group: 'model', label: '最大输出 token', min: 1, max: 8192 },
  { name: 'contextTokens', key: 'cfg:context_tokens', kind: 'integer', group: 'model', label: '上下文输入 token', min: 256, max: 1000000 },
  { name: 'timeoutMs', key: 'cfg:timeout_ms', kind: 'integer', group: 'model', label: '模型超时（毫秒）', min: 1000, max: 120000 },
  // --- whitelist ------------------------------------------------------------
  { name: 'privateUsers', key: 'cfg:private_users', kind: 'qqlist', group: 'whitelist', label: '私聊白名单（QQ 号，逗号分隔）' },
  { name: 'groupIds', key: 'cfg:group_ids', kind: 'qqlist', group: 'whitelist', label: '群白名单（群号，逗号分隔）', hint: '改动即对下一条消息生效。' },
  // --- search ---------------------------------------------------------------
  { name: 'webSearchEnabled', key: 'cfg:web_search_enabled', kind: 'boolean', group: 'search', label: '联网搜索' },
  { name: 'webSearchAutoEnabled', key: 'cfg:web_search_auto_enabled', kind: 'boolean', group: 'search', label: '自动联网搜索' },
  { name: 'searchInputReserve', key: 'cfg:search_input_reserve', kind: 'integer', group: 'search', label: '搜索输入预留 token', min: 16000, max: 1000000 },
  { name: 'searchDailyLimit', key: 'cfg:search_daily_limit', kind: 'integer', group: 'search', label: '每日搜索次数上限', min: 1, max: 1000 },
  // --- vision ---------------------------------------------------------------
  { name: 'visionEnabled', key: 'cfg:vision_enabled', kind: 'boolean', group: 'vision', label: '图片识别' },
  { name: 'visionDetail', key: 'cfg:vision_detail', kind: 'enum', group: 'vision', label: '图片识别细节', options: ['low', 'original'] },
  // --- group management -----------------------------------------------------
  { name: 'groupManagementEnabled', key: 'cfg:group_management_enabled', kind: 'boolean', group: 'group', label: '群管理' },
  { name: 'groupAdminCommandsEnabled', key: 'cfg:group_admin_commands_enabled', kind: 'boolean', group: 'group', label: '群管理命令' },
  { name: 'groupKeywordWithoutAt', key: 'cfg:group_keyword_without_at', kind: 'boolean', group: 'group', label: '免 @ 关键词触发' },
  { name: 'clearMs', key: 'cfg:group_clear_hours', kind: 'number', group: 'group', label: '群会话清理（小时）', min: 1, max: 8760, toText: v => String(v / 3600000), fromText: t => Number(t) * 3600000 },
  // --- anti-spam ------------------------------------------------------------
  { name: 'antiSpamEnabled', key: 'cfg:anti_spam_enabled', kind: 'boolean', group: 'antispam', label: '防刷屏' },
  { name: 'antiSpamCount', key: 'cfg:anti_spam_count', kind: 'integer', group: 'antispam', label: '刷屏阈值（条）', min: 2, max: 100 },
  { name: 'antiSpamWindowMs', key: 'cfg:anti_spam_window_seconds', kind: 'integer', group: 'antispam', label: '刷屏窗口（秒）', min: 1, max: 300, toText: v => String(v / 1000), fromText: t => Number(t) * 1000 },
  { name: 'antiSpamMuteSeconds', key: 'cfg:anti_spam_mute_minutes', kind: 'integer', group: 'antispam', label: '禁言时长（分钟）', min: 1, max: 43200, toText: v => String(v / 60000), fromText: t => Number(t) * 60000 },
  { name: 'antiSpamReply', key: 'cfg:anti_spam_reply', kind: 'string', group: 'antispam', label: '刷屏回复', max: 200 },
  // --- terms ----------------------------------------------------------------
  { name: 'triggerTerms', key: 'cfg:trigger_terms', kind: 'list', group: 'terms', label: '触发词（逗号分隔）' },
  { name: 'blockTerms', key: 'cfg:block_terms', kind: 'list', group: 'terms', label: '屏蔽词（逗号分隔）' },
  // --- bot identity ---------------------------------------------------------
  { name: 'botName', key: 'cfg:bot_name', kind: 'string', group: 'bot', label: '机器人名', max: 24 },
  { name: 'botNicknames', key: 'cfg:bot_nicknames', kind: 'list', group: 'bot', label: '机器人别名（逗号分隔）', hint: '仿真据此判断是否被点名；每项最多 24 字。' },
]);

const FIELDS_BY_NAME = new Map(FIELDS.map(field => [field.name, field]));

const toText = (field, value) => {
  if (field.toText) return field.toText(value);
  switch (field.kind) {
    case 'boolean': return value ? 'true' : 'false';
    case 'list': case 'qqlist': case 'datelist': return (value ?? []).join(',');
    default: return String(value ?? '');
  }
};

const fromText = (field, text) => {
  if (field.fromText) return field.fromText(text);
  switch (field.kind) {
    case 'boolean': return text === 'true';
    case 'number': case 'integer': return Number(text);
    case 'list': case 'qqlist': case 'datelist': return listOf(text);
    default: return text;
  }
};

const validateField = (field, text) => {
  if (field.validate) return field.validate(text);
  switch (field.kind) {
    case 'boolean':
      return ['true', 'false'].includes(text) ? null : '必须是 true 或 false';
    case 'number': case 'integer': {
      if (text === '' || !Number.isFinite(Number(text))) return '需要数字';
      const value = Number(text);
      if (field.min !== undefined && value < field.min) return `不能小于 ${field.min}`;
      if (field.max !== undefined && value > field.max) return `不能大于 ${field.max}`;
      if (field.kind === 'integer' && !Number.isInteger(value)) return '需要整数';
      return null;
    }
    case 'string':
      if (field.max !== undefined && Array.from(text).length > field.max) return `最多 ${field.max} 字`;
      return null;
    case 'enum':
      return (field.options ?? []).includes(text) ? null : `必须是 ${(field.options ?? []).join(' / ')}`;
    case 'list': case 'qqlist': {
      const items = listOf(text);
      if (!items.length) return '至少一项';
      if (field.kind === 'qqlist' && !items.every(validQQ)) return 'QQ 号格式不正确';
      return null;
    }
    case 'date':
      return isDate(text) ? null : '必须是 YYYY-MM-DD';
    case 'datelist':
      return listOf(text).every(isDate) ? null : '必须是逗号分隔的 YYYY-MM-DD';
    default: return null;
  }
};

const valueOf = (config, store, name) => {
  const field = FIELDS_BY_NAME.get(name);
  if (!field) return config[name];
  const text = store.setting(field.key, null);
  return text === null ? config[name] : fromText(field, text);
};

// Maps a proxy back to the frozen `.env` config it wraps, so the console can
// still show the *default* beside the *effective* value.
const ORIGINAL = new WeakMap();

// Wrap `config` so every `config.xxx` read resolves through the settings table
// for the fields above and falls back to the `.env` default otherwise.
//
// The proxy target is a **writable shallow copy**, not `config` itself. `config`
// arrives frozen, and a proxy is forbidden from reporting a different value for
// a non-writable, non-configurable data property — the moment an override was
// stored, every `{ ...config }` (Bot.handle does one per turn, as does
// Model.forProfile) threw `TypeError: 'get' on proxy` and the bot answered
// nothing at all. A copy keeps the invariants satisfiable. Writes stay rejected
// so only the console (via `applyRuntimeValue`) can move an effective value.
export function createRuntimeConfig(config, store) {
  const effective = name => valueOf(config, store, name);
  const target = { ...config };
  const proxy = new Proxy(target, {
    get(holder, prop, receiver) {
      if (prop === 'privateUser') {
        const users = effective('privateUsers');
        return (Array.isArray(users) ? users : listOf(users))[0] ?? Reflect.get(holder, prop, receiver);
      }
      if (prop === 'groupId') {
        const groups = effective('groupIds');
        return (Array.isArray(groups) ? groups : listOf(groups))[0] ?? Reflect.get(holder, prop, receiver);
      }
      if (FIELDS_BY_NAME.has(prop)) return effective(prop);
      return Reflect.get(holder, prop, receiver);
    },
    set() { throw new TypeError('CONFIG_READ_ONLY'); },
    deleteProperty() { throw new TypeError('CONFIG_READ_ONLY'); },
  });
  ORIGINAL.set(proxy, config);
  return proxy;
}

// What the console's settings page renders: one entry per field with its current
// effective value, its `.env` default, and the bounds the inputs need. The
// default comes from the frozen source config (via `ORIGINAL`), never from the
// proxy, so an override never masquerades as "the default".
export function runtimeValues(config, store) {
  const original = ORIGINAL.get(config) ?? config;
  return {
    groups: GROUPS.map(([id, label]) => ({ id, label })),
    fields: FIELDS.map(field => ({
      name: field.name, key: field.key, kind: field.kind, group: field.group,
      label: field.label, hint: field.hint ?? '',
      value: toText(field, valueOf(config, store, field.name)),
      defaultValue: toText(field, original[field.name]),
      min: field.min, max: field.max, options: field.options ?? null,
    })),
  };
}

// Persist one edit from the console. An empty value clears the row, which makes
// the field inherit its `.env` default again. Returns the new effective value.
export function applyRuntimeValue(config, store, name, raw) {
  const field = FIELDS_BY_NAME.get(name);
  if (!field) throw new Error('CONFIG_PARAM_INVALID');
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (text === '') {
    if (!store?.remove) throw new Error('CONFIG_PARAM_INVALID');
    store.remove(field.key);
    return null;
  }
  if (validateField(field, text)) throw new Error('CONFIG_PARAM_INVALID');
  if (!store?.set) throw new Error('CONFIG_PARAM_INVALID');
  store.set(field.key, text);
  return fromText(field, text);
}

export { FIELDS, FIELDS_BY_NAME };
