// Shared fixtures for the console tests (I-08 split). Both collection globs —
// `npm test` (`test/*.test.js`) and `test/*.js` — deliberately skip this
// subdirectory, so this file is only ever loaded through an explicit import.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { Personas } from '../../src/personas.js';
import { Social } from '../../src/social/engine.js';
import { Slang } from '../../src/social/slang.js';
import { createConsole } from '../../src/console/server.js';

// Re-exported so a split file never needs its own path to the engine module:
// the reference count across src/ + test/ is what it was before the split.
export { Social };

export const TOKEN = 'test-console-token-1234';

export function fixture(t, overrides = {}) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, apiKey: 'sk-supersecret-key',
    onebotToken: 'onebot-supersecret', consoleToken: TOKEN, consolePort: 0,
    webSearchEnabled: true, visionEnabled: false, antiSpamEnabled: true, groupManagementEnabled: false,
    ...overrides,
  };
  const bot = { queued: 0, sendFailures: 0 };
  const transport = { ready: true, retry: 0 };
  const runtime = { stats: () => [{ name: 'core', failures: 0, lastError: null }] };
  const server = createConsole({ config, store, bot, transport, runtime, log: () => {}, port: 0 });
  return { store, config, server };
}

// A console wired to a real persona directory, for the Phase 2 write paths.
export function personaFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-personas-'));
  const store = new Store();
  const personas = new Personas({ directory: root, store, log: () => {} });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0 };
  const server = createConsole({ config, store, personas, log: () => {}, port: 0 });
  return { store, personas, server };
}

// A console wired to a real Social engine, for the Phase 3 read/write paths.
export function socialFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    socialEnabled: false, socialThreshold: 6, socialCooldownSeconds: 45, socialDailyLimit: 20,
    socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
    socialMessageTtlMs: 24 * 3600000, botName: '', botNicknames: [],
    blockTerms: [], maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = { complete: async () => ({ text: '好', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  const social = new Social({ config, store, model, log: () => {}, now: () => 1800000000000 });
  const server = createConsole({ config, store, social, log: () => {}, port: 0 });
  return { store, social, server };
}

// A console wired to a real Slang library, for the Phase 4 read/write paths.
export function slangFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
    slangAutoExtract: false, slangExtractIntervalHours: 12, webSearchEnabled: false,
    maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = {
    complete: async () => ({
      text: '[{"term":"yyds","meaning":"永远的神","example":"这才是 yyds"}]',
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
  };
  store.noteMessage({ groupId: '20000', messageId: 'm1', userId: '30001', at: Date.now() - 1000, text: '这才是 yyds' });
  const slang = new Slang({ config, store, model, log: () => {} });
  const server = createConsole({ config, store, slang, log: () => {}, port: 0 });
  return { store, slang, server };
}

export const auth = { 'x-console-token': TOKEN };
export const jsonPost = (base, path, body, extra = {}) => fetch(base + path, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});
