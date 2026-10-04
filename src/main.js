import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Model } from './model.js';
import { Bot } from './bot.js';
import { OneBot } from './onebot.js';
import { Runtime } from './runtime.js';
import { Ledger } from './ledger.js';
import { Personas } from './personas.js';
import { Social } from './social/engine.js';
import { DEFAULT_PERSONA } from './persona.js';
import { createLogger } from './logger.js';
import { createConsole } from './console/server.js';

let config;
try { config = loadConfig(); }
catch (error) { console.error(error.message); process.exit(1); }
if (process.argv.includes('--check')) {
  console.log('配置校验通过；尚未测试 NapCat 连接或调用模型。');
  process.exit(0);
}
const startedAt = Date.now();
const store = new Store(config.databasePath);
const log = createLogger();
const ledger = new Ledger({ store, log });
// Two-layer prompts (Phase 2). Always constructed, even with the console off:
// `PERSONA_DEFAULT` and hand-written `personas/characters/*.md` must work
// headless. With no card active and no SYSTEM_PROMPT this resolves to the
// built-in persona, so a stock `.env` behaves exactly as before.
const personas = new Personas({
  directory: config.personaDirectory, store, log,
  envPrompt: config.systemPromptOverride, fallback: DEFAULT_PERSONA,
  defaultName: config.personaDefault,
});
const bot = new Bot(config, store, new Model(config), { log, ledger, personas });
// Social simulation (Phase 3). Always constructed, even when disabled, so the
// console can turn it on at runtime; `observe` returns immediately while off and
// writes nothing, so a stock `.env` keeps group messages out of the database.
const social = new Social({ config, store, model: bot.model, ledger, personas, log });
// Every OneBot event fans out through the runtime. The answering bot handles what
// addresses it; the simulation handles everything else in the same groups.
const runtime = new Runtime({ log });
runtime.use('core', (event, send, alive) => bot.ingest(event, send, alive));
runtime.use('social', (event, send, alive) => social.observe(event, send, alive));
const transport = new OneBot(config, { onEvent: (...args) => runtime.dispatch(...args), log });
const timer = setInterval(() => { bot.tick(); social.maintain(); }, 30000);
transport.start();
log('service_started');

let consoleServer = null;
if (config.consoleEnabled) {
  consoleServer = createConsole({ config, store, bot, transport, runtime, personas, social, log, startedAt });
  consoleServer.start()
    .then(() => console.log(`AutoChat 控制台：${consoleServer.url()}`))
    .catch(error => { console.error(`控制台启动失败：${error.message}`); consoleServer = null; });
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer); transport.stop();
  if (consoleServer) await consoleServer.stop().catch(() => {});
  // Wait for in-flight model usage settlement before closing SQLite.
  await runtime.drain();
  await bot.tail;
  await bot.antiSpam.tail;
  await social.drain();
  store.close(); log('service_stopped');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
