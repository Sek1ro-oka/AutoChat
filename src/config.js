import { resolve } from 'node:path';
import { DEFAULT_PERSONA } from './persona.js';
import { validPersonaName } from './personas.js';
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
  // Two-layer prompts (V2 · Phase 2). `systemPromptOverride` keeps the raw
  // SYSTEM_PROMPT so the loader can tell "explicitly configured" apart from
  // "fell back to the built-in persona"; `systemPrompt` below is unchanged and
  // still serves every caller that has no persona loader attached.
  const systemPromptOverride = env.SYSTEM_PROMPT?.trim() || null;
  const personaDefault = env.PERSONA_DEFAULT?.trim() || null;
  if (personaDefault !== null && !validPersonaName(personaDefault)) {
    throw new Error('PERSONA_DEFAULT 只能使用中英文、数字、空格、点、短横线或间隔号，1~40 字');
  }
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
    systemPromptOverride,
    personaDirectory: resolve(env.PERSONA_DIR || 'personas'),
    personaDefault,
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
    // Social simulation (V2 · Phase 3). Default off: with SOCIAL_ENABLED unset
    // the bot behaves exactly as it did before this phase.
    socialEnabled: (env.SOCIAL_ENABLED || 'false').trim() === 'true',
    socialThreshold: number('SOCIAL_THRESHOLD', 6, 0, 100),
    socialCooldownSeconds: integer('SOCIAL_COOLDOWN_SECONDS', 45, 5, 3600),
    socialDailyLimit: integer('SOCIAL_DAILY_LIMIT', 20, 1, 500),
    socialContextMessages: integer('SOCIAL_CONTEXT_MESSAGES', 12, 1, 50),
    socialMaxChunks: integer('SOCIAL_MAX_CHUNKS', 3, 1, 5),
    socialMinDelayMs: integer('SOCIAL_MIN_DELAY_MS', 900, 0, 10000),
    socialMaxDelayMs: integer('SOCIAL_MAX_DELAY_MS', 2600, 0, 20000),
    socialMessageTtlMs: number('SOCIAL_MESSAGE_TTL_HOURS', 24, 1, 720) * 3600000,
    botName: env.BOT_NAME?.trim() || '',
    botNicknames: Object.freeze((env.BOT_NICKNAMES || '').split(',').map(value => value.trim()).filter(Boolean)),
    // Slang library (V2 · Phase 4). Off by default: with SLANG_ENABLED unset no
    // group message ever reaches the extraction model and no table is injected,
    // so a stock `.env` behaves exactly as it did before this phase.
    slangEnabled: (env.SLANG_ENABLED || 'false').trim() === 'true',
    slangInjectMax: integer('SLANG_INJECT_MAX', 20, 1, 30),
    slangExtractMessages: integer('SLANG_EXTRACT_MESSAGES', 120, 10, 500),
    // Automatic (timer-driven) extraction stays off unless asked for: it spends
    // money without a human pressing anything.
    slangAutoExtract: (env.SLANG_AUTO_EXTRACT || 'false').trim() === 'true',
    slangExtractIntervalHours: number('SLANG_EXTRACT_INTERVAL_HOURS', 12, 1, 168),
    // Sticker library (V2 · Phase 6). Off by default: with STICKER_ENABLED unset
    // no group picture is downloaded or kept. When it is on, rule-based
    // auto-collect keeps a picture once it has been seen STICKER_AUTO_THRESHOLD
    // times; the model may additionally ask to keep one with a `【偷图】` marker.
    stickerEnabled: (env.STICKER_ENABLED || 'false').trim() === 'true',
    stickerAutoCollect: (env.STICKER_AUTO_COLLECT || 'true').trim() === 'true',
    stickerAutoThreshold: integer('STICKER_AUTO_THRESHOLD', 2, 1, 20),
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
  if (!['true', 'false'].includes((env.SOCIAL_ENABLED || 'false').trim())) {
    throw new Error('SOCIAL_ENABLED 必须是 true 或 false');
  }
  if (config.socialMinDelayMs > config.socialMaxDelayMs) {
    throw new Error('SOCIAL_MIN_DELAY_MS 不能大于 SOCIAL_MAX_DELAY_MS');
  }
  if (config.botName.length > 24 || config.botNicknames.some(name => name.length > 24)) {
    throw new Error('BOT_NAME 与 BOT_NICKNAMES 每项最多 24 字');
  }
  if (!['true', 'false'].includes((env.SLANG_ENABLED || 'false').trim())) {
    throw new Error('SLANG_ENABLED 必须是 true 或 false');
  }
  if (!['true', 'false'].includes((env.SLANG_AUTO_EXTRACT || 'false').trim())) {
    throw new Error('SLANG_AUTO_EXTRACT 必须是 true 或 false');
  }
  if (!['true', 'false'].includes((env.STICKER_ENABLED || 'false').trim())) {
    throw new Error('STICKER_ENABLED 必须是 true 或 false');
  }
  if (!['true', 'false'].includes((env.STICKER_AUTO_COLLECT || 'true').trim())) {
    throw new Error('STICKER_AUTO_COLLECT 必须是 true 或 false');
  }
  config.modelProfiles = loadModelProfiles(env, config);
  config.sendThinking = config.modelProfiles[0].sendThinking;
  return Object.freeze(config);
}
