export function loadModelProfiles(env, legacy) {
  const boolean = (name, fallback) => {
    const value = env[name]?.trim() || String(fallback);
    if (!['true', 'false'].includes(value)) throw new Error(`${name} 必须是 true 或 false`);
    return value === 'true';
  };
  const native = new URL(legacy.baseUrl).hostname === 'api.deepseek.com' && legacy.model === 'deepseek-flash';
  const profiles = [{ id: 'default', model: legacy.model, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey,
    inputPrice: legacy.inputPrice, outputPrice: legacy.outputPrice, priceDate: legacy.priceDate,
    cacheHitPrice: legacy.cacheHitPrice ?? null,
    maxOutput: legacy.maxOutput, contextTokens: legacy.contextTokens,
    supportsVision: boolean('MODEL_SUPPORTS_VISION', native), supportsSearch: boolean('MODEL_SUPPORTS_SEARCH', native),
    imageInputReserve: 2048, sendThinking: boolean('MODEL_SEND_THINKING', native) }];
  const ids = (env.MODEL_PROFILES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length > 10 || new Set(ids).size !== ids.length) throw new Error('MODEL_PROFILES 最多10个，且不能重复');
  for (const id of ids) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(id) || id === 'default') throw new Error('MODEL_PROFILES 标识只能使用小写英文、数字和下划线，且不能是default');
    const prefix = `MODEL_${id.toUpperCase()}_`;
    const required = suffix => {
      const value = env[prefix + suffix]?.trim();
      if (!value) throw new Error(`缺少配置：${prefix + suffix}`);
      return value;
    };
    const number = (suffix, fallback, min, max, integer = false) => {
      const raw = env[prefix + suffix]?.trim() || (fallback === null ? required(suffix) : String(fallback));
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`数值配置不正确：${prefix + suffix}`);
      return value;
    };
    let url;
    try { url = new URL(required('BASE_URL')); } catch { throw new Error(`${prefix}BASE_URL 必须是有效HTTPS地址`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${prefix}BASE_URL 必须是无凭据的HTTPS地址`);
    const model = required('NAME');
    if (!/^[a-zA-Z0-9][\w./:@+-]{0,119}$/.test(model)) throw new Error(`${prefix}NAME 格式不正确`);
    const priceDate = required('PRICE_VERIFIED_DATE');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate) || Number.isNaN(Date.parse(priceDate))) throw new Error(`${prefix}PRICE_VERIFIED_DATE 格式不正确`);
    const supportsVision = boolean(prefix + 'SUPPORTS_VISION', false);
    profiles.push({ id, model, baseUrl: url.href.replace(/\/$/, ''), apiKey: required('API_KEY'), priceDate,
      inputPrice: number('PRICE_INPUT_CNY_PER_MILLION', null, 0.000001, 10000),
      outputPrice: number('PRICE_OUTPUT_CNY_PER_MILLION', null, 0.000001, 10000),
      cacheHitPrice: env[prefix + 'PRICE_CACHE_HIT_CNY_PER_MILLION']?.trim()
        ? number('PRICE_CACHE_HIT_CNY_PER_MILLION', null, 0.000001, 10000)
        : legacy.cacheHitPrice ?? null,
      maxOutput: number('MAX_OUTPUT_TOKENS', legacy.maxOutput, 1, 8192, true),
      contextTokens: number('CONTEXT_INPUT_TOKENS', legacy.contextTokens, 256, 1000000, true),
      supportsVision, supportsSearch: boolean(prefix + 'SUPPORTS_SEARCH', false),
      imageInputReserve: supportsVision ? number('IMAGE_INPUT_RESERVE_TOKENS', null, 1, 1000000, true) : 2048,
      sendThinking: boolean(prefix + 'SEND_THINKING', false) });
  }
  return Object.freeze(profiles.map(profile => Object.freeze(profile)));
}

export function activeProfile(config, store) {
  return config.modelProfiles?.find(p => p.id === store.setting('active_model', 'default'))
    ?? config.modelProfiles?.[0];
}
export const profileSessionKey = (key, profile) => !profile || profile.id === 'default' ? key : `${key}:model:${profile.id}`;
