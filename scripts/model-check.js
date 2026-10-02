import { loadConfig } from '../src/config.js';
import { Store, budgetDay } from '../src/store.js';
import { Model, costMicro, estimateInput, usageCost } from '../src/model.js';

// A small real request, accounted in the same daily ledger as production.
const config = { ...loadConfig(), maxOutput: 16 };
const store = new Store(config.databasePath);
try {
  const messages = [{ role: 'user', content: '请只回复OK。' }];
  const id = store.reserve(budgetDay(), costMicro(estimateInput(messages), config.maxOutput, config),
    config.budgetMicro, Date.now());
  if (!id) throw new Error('DAILY_BUDGET_INSUFFICIENT');
  try {
    const result = await new Model(config).complete(messages);
    const cost = usageCost(result.usage, config);
    if (cost === null) store.uncertain(id); else store.settle(id, cost);
    if (!result.text) throw new Error('MODEL_EMPTY_ANSWER');
    console.log(JSON.stringify({ status: 'ok', model: config.model,
      promptTokens: result.usage?.prompt_tokens, completionTokens: result.usage?.completion_tokens,
      conservativeCostCny: cost === null ? null : cost / 1e6 }));
  } catch (error) {
    store.uncertain(id);
    console.error(['MODEL_EMPTY_ANSWER', 'MODEL_HTTP_401', 'MODEL_HTTP_402', 'MODEL_HTTP_403',
      'MODEL_HTTP_404', 'MODEL_HTTP_429'].includes(error.message) ? error.message : 'MODEL_CHECK_FAILED');
    process.exitCode = 1;
  }
} finally { store.close(); }
