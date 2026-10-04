import { resolve } from 'node:path';
import { DEFAULT_PERSONA } from './persona.js';
import { loadModelProfiles } from './model-profiles.js';

export function loadConfig(env = process.env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`缺少配置：${name}`);
    return value;
  };
  const id = name => {
    const value = required(name);
    if (!/^[1-9]\d{4,14}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`QQ 标识格式不正确：${name}`);
    }
    return value;
  };
  const number = (name, fallback, min, max) => {
    const raw = env[name]?.trim() || String(fallback ?? '');
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`数值配置不正确：${name}`);
    }
    return value;
  };
  const integer = (name, fallback, min, max) => {
    const value = number(name, fallback, min, max);
    if (!Number.isInteger(value)) throw new Error(`需要整数：${name}`);
    return value;
  };
  const wsUrl = new URL(env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001');
  if (wsUrl.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(wsUrl.hostname)
      || wsUrl.username || wsUrl.password || wsUrl.search || wsUrl.hash) {
    throw new Error('ONEBOT_WS_URL 必须为无凭据、无查询参数的本机回环 ws 地址');
  }
  const baseUrl = new URL(env.MODEL_BASE_URL || 'https://api.deepseek.com');
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('MODEL_BASE_URL 必须为无凭据的 HTTPS 地址');
  }
  const priceDate = required('PRICE_VERIFIED_DATE');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate) || Number.isNaN(Date.parse(priceDate))) {
    throw new Error('PRICE_VERIFIED_DATE 必须是 YYYY-MM-DD');
  }
  const privateUsers = env.PRIVATE_USER_QQS?.trim()
    ? [...new Set(env.PRIVATE_USER_QQS.split(',').map(value => value.trim()).filter(Boolean))]
    : [id('PRIVATE_USER_QQ')];
  for (const value of privateUsers) {
    if (!/^[1-9]\d{4,14}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error('QQ 标识格式不正确：PRIVATE_USER_QQS');
    }
  }
  if (!privateUsers.length) throw new Error('PRIVATE_USER_QQS 不能为空');
  const groupIds = env.GROUP_QQS?.trim()
    ? [...new Set(env.GROUP_QQS.split(',').map(value => value.trim()).filter(Boolean))]
    : [id('GROUP_QQ')];
  if (!groupIds.length || groupIds.some(value => !/^[1-9]\d{4,14}$/.test(value)
      || !Number.isSafeInteger(Number(value)))) {
    throw new Error('QQ 标识格式不正确：GROUP_QQS');
  }
  const privateUser = privateUsers[0];
  const inputPrice = number('PRICE_INPUT_CNY_PER_MILLION', null, 0.000001, 10000);
  const outputPrice = number('PRICE_OUTPUT_CNY_PER_MILLION', null, 0.000001, 10000);
  // Reporting-only prices (Phase 5). Leaving the cache price empty means "use the
  // DeepSeek ratio" (see ledger.js). The budget reservation keeps charging the
  // peak, uncached price regardless, so these can never loosen the daily cap.
  const cacheHitPrice = env.PRICE_CACHE_HIT_CNY_PER_MILLION?.trim()
    ? number('PRICE_CACHE_HIT_CNY_PER_MILLION', null, 0.000001, 10000)
    : null;
  const costHolidays = (env.COST_HOLIDAYS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (costHolidays.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)))) {
    throw new Error('COST_HOLIDAYS 必须是逗号分隔的 YYYY-MM-DD');
  }
  const config = {
    botId: id('BOT_QQ'), privateUser, privateUsers: Object.freeze(privateUsers),
    groupId: groupIds[0], groupIds: Object.freeze(groupIds),
    groupManagerId: env.PRIVATE_USER_QQ?.trim() ? id('PRIVATE_USER_QQ') : privateUser,
    groupManagementEnabled: (env.GROUP_MANAGEMENT_ENABLED || 'false').trim() === 'true',
    groupAdminCommandsEnabled: (env.GROUP_ADMIN_COMMANDS_ENABLED || 'false').trim() === 'true',
    adminId: env.ADMIN_QQ?.trim() ? id('ADMIN_QQ') : privateUser,
    wsUrl: wsUrl.href, onebotToken: required('ONEBOT_ACCESS_TOKEN'),
    apiKey: required('DEEPSEEK_API_KEY'), baseUrl: baseUrl.href.replace(/\/$/, ''),
    model: env.MODEL_NAME?.trim() || 'deepseek-flash',
    budgetMicro: Math.floor(number('DAILY_BUDGET_CNY', 1, 0.000001, 100) * 1e6),
    inputPrice,
    outputPrice,
    priceDate,
    cacheHitPrice,
    offPeakRatio: number('PRICE_OFFPEAK_RATIO', 0.5, 0.01, 1),
    costHolidays: Object.freeze(costHolidays),
    maxOutput: integer('MAX_OUTPUT_TOKENS', 1024, 1, 8192),
    contextTokens: integer('CONTEXT_INPUT_TOKENS', 16000, 256, 1000000),
    timeoutMs: integer('MODEL_TIMEOUT_MS', 60000, 1000, 120000),
    clearMs: number('GROUP_CLEAR_HOURS', 72, 1, 8760) * 3600000,
    databasePath: resolve(env.DATABASE_PATH || 'data/autochat.sqlite'),
    systemPrompt: env.SYSTEM_PROMPT?.trim() || DEFAULT_PERSONA,
    blockTerms: (env.BLOCK_TERMS || '').split(',').map(x => x.trim()).filter(Boolean),
    triggerTerms: (env.TRIGGER_TERMS || '').split(',').map(x => x.trim()).filter(Boolean),
    groupKeywordWithoutAt: (env.GROUP_KEYWORD_WITHOUT_AT || 'false').trim() === 'true',
    webSearchEnabled: (env.WEB_SEARCH_ENABLED || 'false').trim() === 'true',
    webSearchAutoEnabled: (env.WEB_SEARCH_AUTO_ENABLED || 'false').trim() === 'true',
    searchInputReserve: integer('WEB_SEARCH_INPUT_RESERVE_TOKENS', 64000, 16000, 1000000),
    searchDailyLimit: integer('WEB_SEARCH_DAILY_LIMIT', 50, 1, 1000),
    visionEnabled: (env.VISION_ENABLED || 'false').trim() === 'true',
    visionDetail: (env.VISION_DETAIL || 'original').trim(),
    antiSpamEnabled: (env.GROUP_ANTI_SPAM_ENABLED || 'false').trim() === 'true',
    antiSpamCount: integer('GROUP_ANTI_SPAM_COUNT', 5, 2, 100),
    antiSpamWindowMs: integer('GROUP_ANTI_SPAM_WINDOW_SECONDS', 10, 1, 300) * 1000,
    antiSpamMuteSeconds: integer('GROUP_ANTI_SPAM_MUTE_MINUTES', 5, 1, 43200) * 60,
    antiSpamReply: env.GROUP_ANTI_SPAM_REPLY === undefined ? '你话太多了！' : env.GROUP_ANTI_SPAM_REPLY.trim(),
    consoleEnabled: (env.CONSOLE_ENABLED || 'false').trim() === 'true',
    consolePort: integer('CONSOLE_PORT', 3200, 1024, 65535),
    consoleToken: env.CONSOLE_TOKEN?.trim() || null,
  };
  if (!['true', 'false'].includes((env.CONSOLE_ENABLED || 'false').trim())) {
    throw new Error('CONSOLE_ENABLED 必须是 true 或 false');
  }
  if (config.consoleToken !== null && (config.consoleToken.length < 16 || !/^[\x21-\x7e]+$/.test(config.consoleToken))) {
    throw new Error('CONSOLE_TOKEN 至少 16 位且只能使用可见 ASCII 字符');
  }
  if (!['true', 'false'].includes((env.WEB_SEARCH_AUTO_ENABLED || 'false').trim())) throw new Error('WEB_SEARCH_AUTO_ENABLED 必须是 true 或 false');
  if (!['true', 'false'].includes((env.GROUP_ADMIN_COMMANDS_ENABLED || 'false').trim())) throw new Error('GROUP_ADMIN_COMMANDS_ENABLED 必须是 true 或 false');
  if (!['true', 'false'].includes((env.GROUP_ANTI_SPAM_ENABLED || 'false').trim())) throw new Error('GROUP_ANTI_SPAM_ENABLED 必须是 true 或 false');
  if (Array.from(config.antiSpamReply).length > 200) throw new Error('GROUP_ANTI_SPAM_REPLY 最多200字');
  if (!['true', 'false'].includes((env.VISION_ENABLED || 'false').trim())) throw new Error('VISION_ENABLED 必须是 true 或 false');
  if (!['low', 'original'].includes(config.visionDetail)) throw new Error('VISION_DETAIL 必须是 low 或 original');
  if (!['true', 'false'].includes((env.WEB_SEARCH_ENABLED || 'false').trim())) {
    throw new Error('WEB_SEARCH_ENABLED 必须是 true 或 false');
  }
  if (!['true', 'false'].includes((env.GROUP_KEYWORD_WITHOUT_AT || 'false').trim())) {
    throw new Error('GROUP_KEYWORD_WITHOUT_AT 必须是 true 或 false');
  }
  if (!['true', 'false'].includes((env.GROUP_MANAGEMENT_ENABLED || 'false').trim())) {
    throw new Error('GROUP_MANAGEMENT_ENABLED 必须是 true 或 false');
  }
  if (config.groupManagerId === config.botId) throw new Error('群管理控制者不能是机器人自身');
  if (privateUsers.includes(config.botId) || config.botId === config.adminId) {
    throw new Error('机器人与私聊用户／管理员 QQ 号不能相同');
  }
  config.modelProfiles = loadModelProfiles(env, config);
  config.sendThinking = config.modelProfiles[0].sendThinking;
  return Object.freeze(config);
}
