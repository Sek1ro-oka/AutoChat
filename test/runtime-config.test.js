import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createRuntimeConfig, runtimeValues, applyRuntimeValue } from '../src/runtime-config.js';

const makeConfig = () => ({
  botId: '10000', apiKey: 'sk-secret',
  budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, cacheHitPrice: null, offPeakRatio: 0.5,
  priceDate: '2027-01-01', costHolidays: [],
  model: 'deepseek-flash', maxOutput: 1024, contextTokens: 16000, timeoutMs: 60000,
  privateUsers: ['11111', '22222'], privateUser: '11111', groupIds: ['30000'], groupId: '30000',
  webSearchEnabled: false, webSearchAutoEnabled: false, searchInputReserve: 64000, searchDailyLimit: 50,
  visionEnabled: false, visionDetail: 'original',
  groupManagementEnabled: false, groupAdminCommandsEnabled: false, groupKeywordWithoutAt: false,
  clearMs: 72 * 3600000,
  antiSpamEnabled: false, antiSpamCount: 5, antiSpamWindowMs: 10000, antiSpamMuteSeconds: 300,
  antiSpamReply: '你话太多了！',
  triggerTerms: [], blockTerms: [],
  botName: '小助手', botNicknames: [],
});

const harness = () => {
  const store = new Store();
  const config = createRuntimeConfig(makeConfig(), store);
  return { store, config };
};

test('non-configurable fields pass straight through', () => {
  const { config } = harness();
  assert.equal(config.botId, '10000');
  assert.equal(config.apiKey, 'sk-secret');
});

test('configurable fields fall back to the .env default until overridden', () => {
  const { config } = harness();
  assert.equal(config.webSearchEnabled, false);
  assert.equal(config.budgetMicro, 1000000);
  assert.deepEqual(config.privateUsers, ['11111', '22222']);
});

test('applyRuntimeValue persists an override that the proxy then resolves', () => {
  const { store, config } = harness();
  applyRuntimeValue(config, store, 'webSearchEnabled', 'true');
  assert.equal(config.webSearchEnabled, true);
  applyRuntimeValue(config, store, 'budgetMicro', '2');
  assert.equal(config.budgetMicro, 2000000, 'stored as yuan, read back as micro');
});

test('an empty value clears the row and restores the default', () => {
  const { store, config } = harness();
  applyRuntimeValue(config, store, 'webSearchEnabled', 'true');
  assert.equal(config.webSearchEnabled, true);
  applyRuntimeValue(config, store, 'webSearchEnabled', '');
  assert.equal(config.webSearchEnabled, false);
  assert.equal(store.setting('cfg:web_search_enabled', null), null);
});

test('invalid values throw CONFIG_PARAM_INVALID and change nothing', () => {
  const { store, config } = harness();
  assert.throws(() => applyRuntimeValue(config, store, 'webSearchEnabled', 'yes'), /CONFIG_PARAM_INVALID/);
  assert.throws(() => applyRuntimeValue(config, store, 'budgetMicro', '-1'), /CONFIG_PARAM_INVALID/);
  assert.throws(() => applyRuntimeValue(config, store, 'privateUsers', 'abc'), /CONFIG_PARAM_INVALID/);
  assert.throws(() => applyRuntimeValue(config, store, 'visionDetail', 'high'), /CONFIG_PARAM_INVALID/);
  assert.throws(() => applyRuntimeValue(config, store, 'nope', '1'), /CONFIG_PARAM_INVALID/);
  assert.equal(store.setting('cfg:budget_cny', null), null);
});

test('the whitelist override also drives the derived privateUser and groupId', () => {
  const { store, config } = harness();
  applyRuntimeValue(config, store, 'privateUsers', '99999,88888');
  assert.deepEqual(config.privateUsers, ['99999', '88888']);
  assert.equal(config.privateUser, '99999');
  applyRuntimeValue(config, store, 'groupIds', '77777');
  assert.equal(config.groupId, '77777');
});

test('human units round-trip through their internal units', () => {
  const { store, config } = harness();
  applyRuntimeValue(config, store, 'antiSpamWindowMs', '20'); // seconds
  assert.equal(config.antiSpamWindowMs, 20000);
  applyRuntimeValue(config, store, 'antiSpamMuteSeconds', '10'); // minutes
  assert.equal(config.antiSpamMuteSeconds, 600000);
  applyRuntimeValue(config, store, 'clearMs', '48'); // hours
  assert.equal(config.clearMs, 48 * 3600000);
});

test('a frozen source config with overrides still spreads and reads', () => {
  // Regression: the proxy used to target the frozen config itself, so the first
  // `{ ...config }` after any override threw "TypeError: 'get' on proxy:
  // property 'botName' is a read-only and non-configurable data property on the
  // proxy target but the proxy did not return its actual value". Bot.handle
  // spreads the config once per turn, so every message died and the bot answered
  // nothing. The target must stay a writable copy.
  const store = new Store();
  const config = createRuntimeConfig(Object.freeze(makeConfig()), store);
  applyRuntimeValue(config, store, 'botName', 'DeepSleep');
  applyRuntimeValue(config, store, 'groupIds', '77777');
  const spread = { ...config };
  assert.equal(spread.botName, 'DeepSleep', 'the override survives the spread');
  assert.equal(spread.botId, '10000', 'untouched fields pass through');
  assert.equal(spread.groupId, '77777', 'the derived id follows the overridden list');
  assert.equal(Object.keys(spread).length, Object.keys(makeConfig()).length);
});

test('the proxy rejects writes from in-process code', () => {
  const { config } = harness();
  assert.throws(() => { config.model = 'other'; }, /CONFIG_READ_ONLY/);
});

test('runtimeValues exposes one entry per field with value and default', () => {
  const { store, config } = harness();
  const view = runtimeValues(config, store);
  assert.ok(view.fields.length >= 20);
  const budget = view.fields.find(field => field.name === 'budgetMicro');
  assert.equal(budget.value, '1');
  assert.equal(budget.defaultValue, '1');
  applyRuntimeValue(config, store, 'budgetMicro', '3');
  const after = runtimeValues(config, store).fields.find(field => field.name === 'budgetMicro');
  assert.equal(after.value, '3');
  assert.equal(after.defaultValue, '1', 'the default stays the .env value');
});
