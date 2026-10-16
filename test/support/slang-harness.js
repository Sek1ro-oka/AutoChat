// Shared fixtures for the slang tests (I-08 split): the frozen clock, the
// config builder, the log lines every library starts from, and the store +
// `Slang` pair. Lives in test/support/ so neither collection glob picks it up.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { Ledger } from '../../src/ledger.js';
import { Slang } from '../../src/social/slang.js';

// 2027-01-15 16:00 北京时间：白天、非节假日，时段只影响计价不影响这里的行为。
export const CLOCK = 1800000000000;

export const makeConfig = overrides => ({
  botId: '10000', groupId: '20000', groupIds: ['20000'],
  slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
  slangAutoExtract: false, slangExtractIntervalHours: 12,
  webSearchEnabled: false, searchDailyLimit: 50, searchInputReserve: 64000,
  budgetMicro: 1000000, maxOutput: 1024, inputPrice: 2, outputPrice: 8,
  cacheHitPrice: null, offPeakRatio: 0.5, costHolidays: [], systemPrompt: '内置人设',
  clearMs: 72 * 3600000,
  ...overrides,
});

export const LOG_LINES = ['这波 666 啊', 'awsl，这题我也不会', 'yyds'];

export function harness({ config = {}, reply = '[]', model = null, ledger = false, corruptDirectory = null } = {}) {
  const store = new Store();
  const clock = { value: CLOCK };
  const calls = [];
  const fake = model ?? {
    calls,
    complete: async messages => {
      calls.push(messages);
      return { text: reply, usage: { prompt_tokens: 500, completion_tokens: 30 } };
    },
  };
  const slang = new Slang({
    config: makeConfig(config), store, model: fake, log: () => {},
    ledger: ledger ? new Ledger({ store }) : null,
    now: () => clock.value,
    corruptDirectory: corruptDirectory ?? join(tmpdir(), 'autochat-slang-test'),
  });
  let seq = 0;
  for (const text of LOG_LINES) {
    seq += 1;
    store.noteMessage({ groupId: '20000', messageId: `m${seq}`, userId: '30001', at: CLOCK - (10 - seq) * 1000, text });
  }
  return { store, slang, calls, clock };
}
