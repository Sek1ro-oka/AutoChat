import { loadConfig } from '../src/config.js';
import { Model, costMicro, usageCost } from '../src/model.js';
import { Store, budgetDay } from '../src/store.js';
import { activeProfile } from '../src/model-profiles.js';

const baseConfig = loadConfig();
const store = new Store(baseConfig.databasePath), day = budgetDay(), key = `search_count:${day}`;
const config = { ...baseConfig, ...activeProfile(baseConfig, store) };
try {
  if (!config.webSearchEnabled || !config.supportsSearch) throw new Error('SEARCH_NOT_ENABLED_OR_SUPPORTED');
  if (Number(store.setting(key, '0')) >= config.searchDailyLimit) throw new Error('SEARCH_LIMIT_REACHED');
  const reservation = store.reserve(day, costMicro(config.searchInputReserve + 1024, config.maxOutput, config), config.budgetMicro, Date.now());
  if (!reservation) throw new Error('BUDGET_EXHAUSTED');
  store.set(key, Number(store.setting(key, '0')) + 1);
  try {
    // Public fixed query only; no private history or account data.
    const result = await new Model(config).search('请搜索 DeepSeek API 官方文档的网址，给出来源。');
    const actual = usageCost(result.usage, config);
    if (actual === null) store.uncertain(reservation); else store.settle(reservation, actual);
    console.log(JSON.stringify({ verified: result.searchVerified, sourceCount: result.sources.length,
      answerCharacters: result.text.length, usage: result.usage, conservativeCostCny: actual === null ? null : actual / 1e6 }));
    if (!result.searchVerified || !result.text) process.exitCode = 1;
  } catch {
    store.uncertain(reservation); throw new Error('SEARCH_DIAGNOSTIC_FAILED');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
