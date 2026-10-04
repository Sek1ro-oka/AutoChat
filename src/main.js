import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Model } from './model.js';
import { Bot } from './bot.js';
import { OneBot } from './onebot.js';
import { Runtime } from './runtime.js';
import { Ledger } from './ledger.js';
import { Personas } from './personas.js';
import { Social } from './social/engine.js';
import { Slang } from './social/slang.js';
import { StickerLib } from './sticker-lib.js';
import { DEFAULT_PERSONA } from './persona.js';
import { createLogger } from './logger.js';
import { createConsole } from './console/server.js';
import { hardenAll } from './permissions.js';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

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
// Secrets on disk (see docs/security.md). Windows ignores the POSIX mode passed
// at creation, so these are tightened explicitly rather than relying on
// `{ mode: 0o600 }`. Best-effort — a failure is logged, never fatal.
//   data/   the chat log and the ledger;
//   .env    the API key, which is the most valuable secret in the tree.
// Deliberately not applied to `runtime/`, which holds the Node runtime, the
// NapCat install and a >120 MB download cache (icacls would walk all of it).
const secrets = [{ path: dirname(config.databasePath), directory: true, label: 'data' }];
if (existsSync(resolve('.env'))) secrets.push({ path: resolve('.env'), label: 'env' });
hardenAll(secrets, { log });
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
const model = new Model(config);
// Slang library (Phase 4). Always constructed so the console can read and review
// it; extraction and injection are both gated on the enable switch, and automatic
// extraction additionally needs SLANG_AUTO_EXTRACT. Confirmed terms are appended
// to group prompts by Bot and Social — see docs/slang.md.
const slang = new Slang({ config, store, model, ledger, log });
// Sticker library (Phase 6). Always constructed so the console can read and
// review it; collection and sending are both gated on the enable switch. A
// confirmed sticker may be sent by either the answering bot or the simulation.
const stickers = new StickerLib({ config, store, log });
const bot = new Bot(config, store, model, { log, ledger, personas, slang, stickers });
// Social simulation (Phase 3). Always constructed, even when disabled, so the
// console can turn it on at runtime; `observe` returns immediately while off and
// writes nothing, so a stock `.env` keeps group messages out of the database.
const social = new Social({ config, store, model, ledger, personas, slang, stickers, log });
// Every OneBot event fans out through the runtime. The answering bot handles what
// addresses it; the simulation handles everything else in the same groups.
const runtime = new Runtime({ log });
runtime.use('core', (event, send, alive) => bot.ingest(event, send, alive));
runtime.use('social', (event, send, alive) => social.observe(event, send, alive));
const transport = new OneBot(config, { onEvent: (...args) => runtime.dispatch(...args), log });
// The maintenance tick also gives the slang library its periodic chance to
// extract. Off unless SLANG_AUTO_EXTRACT is set; the promise is kept so shutdown
// can wait for a paid call that is already in flight.
let slangTick = Promise.resolve();
const timer = setInterval(() => {
  bot.tick();
  social.maintain();
  // Idle-initiated speech rides the same 30s tick; off unless SOCIAL_IDLE_ENABLED.
  social.idleTick((action, params) => transport.call(action, params), () => transport.ready);
  slangTick = slangTick.then(() => slang.maybeExtract()).catch(() => log('slang_auto_extract_failed'));
}, 30000);
transport.start();
log('service_started');

let consoleServer = null;
if (config.consoleEnabled) {
  consoleServer = createConsole({ config, store, bot, transport, runtime, personas, social, slang, stickers, log, startedAt });
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
  await slangTick;
  store.close(); log('service_stopped');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
