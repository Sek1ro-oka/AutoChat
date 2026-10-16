import { loadConfig } from './config.js';
import { createRuntimeConfig } from './runtime-config.js';
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
import { hardenAll, secretTargets } from './permissions.js';
import { acquireLock, lockPathFor, withTimeout } from './lifecycle.js';

let config;
try { config = loadConfig(); }
catch (error) { console.error(error.message); process.exit(1); }
if (process.argv.includes('--check')) {
  console.log('配置校验通过；尚未测试 NapCat 连接或调用模型。');
  process.exit(0);
}
const startedAt = Date.now();
const log = createLogger();
// Single instance. A second process on the same database file would double-count
// the budget and interleave writes, so it is refused *before* the database is
// opened (fail closed: no lock, no start). The logger moves up with the check so
// a refusal leaves the same kind of trace as any other startup failure.
const lockPath = lockPathFor(config.databasePath);
const lock = acquireLock(lockPath);
if (!lock.ok) {
  if (lock.reason === 'already_running') {
    console.error(`AutoChat 已在运行：${lockPath} 由 pid ${lock.holder.pid}（启动于 ${lock.holder.startedAt ?? '未知'}）持有；`
      + '确认该进程已退出后删除锁文件再启动。');
    log('already_running', { pid: lock.holder.pid, startedAt: lock.holder.startedAt });
  } else {
    console.error(`无法创建单实例锁 ${lockPath}：${lock.error?.code ?? '未知错误'}；请检查该目录的写权限后重试。`);
    log('lock_unwritable', { code: lock.error?.code });
  }
  process.exit(1);
}
// `unlinkSync` is legal in an exit hook, and `release()` is idempotent, so the
// normal shutdown path below can call it a second time.
process.on('exit', () => lock.release());
const store = new Store(config.databasePath);
// Runtime-overridable settings (V2). From here on every component reads
// `config.xxx` through a proxy that resolves the settings table first and the
// `.env` default second, so the console can change knobs without a restart.
config = createRuntimeConfig(config, store);
// Secrets on disk (see docs/security.md). Windows ignores the POSIX mode passed
// at creation, so these are tightened explicitly rather than relying on
// `{ mode: 0o600 }`. Best-effort — a failure is logged, never fatal. The list
// itself lives in `src/permissions.js` `secretTargets()`: `data/`, `logs/`, `.env`
// and `personas/`, plus why `runtime/` is deliberately not tightened as a whole.
const secrets = secretTargets(config);
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
// 30s is a deliberate construction bound, chosen far below Node's timer ceiling
// of 2147483647ms (a larger delay would silently be clamped to 1ms).
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

// Shutdown must be bounded: one stuck component used to make the whole process
// unkillable from a terminal. Every step gets its own budget (~14s worst case,
// unchanged sub-second normal path) and reports itself once when it overruns.
const SHUTDOWN_CONSOLE_TIMEOUT_MS = 2000;
const SHUTDOWN_STEP_TIMEOUT_MS = 3000;
let stopping = false;
async function stop(signal) {
  if (stopping) {
    // Second Ctrl+C: the operator has waited long enough, stop waiting too.
    log('shutdown_forced', { signal });
    process.exit(1);
  }
  stopping = true; clearInterval(timer); transport.stop();
  const step = async (promise, ms, name) => {
    const result = await withTimeout(promise, ms, name);
    // Each step runs at most once per shutdown, so this fires at most once.
    if (!result.ok) log('shutdown_step_slow', { step: name, ms });
  };
  try {
    await step(consoleServer ? consoleServer.stop() : Promise.resolve(), SHUTDOWN_CONSOLE_TIMEOUT_MS, 'console');
    // Wait for in-flight model usage settlement before closing SQLite.
    await step(runtime.drain(), SHUTDOWN_STEP_TIMEOUT_MS, 'runtime');
    await step(Promise.all([bot.tail, bot.antiSpam.tail]), SHUTDOWN_STEP_TIMEOUT_MS, 'tails');
    await step(social.drain(), SHUTDOWN_STEP_TIMEOUT_MS, 'social');
    await step(slangTick, SHUTDOWN_STEP_TIMEOUT_MS, 'slang');
  } finally {
    // Unconditional, even after a step overran or threw.
    try { store.close(); } finally { lock.release(); }
    log('service_stopped');
  }
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
