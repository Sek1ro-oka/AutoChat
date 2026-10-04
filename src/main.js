import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Model } from './model.js';
import { Bot } from './bot.js';
import { OneBot } from './onebot.js';
import { Runtime } from './runtime.js';
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
const bot = new Bot(config, store, new Model(config), { log });
// Every OneBot event fans out through the runtime. V2 adds more participants
// (social simulation, message ledger); the answering bot is simply the first.
const runtime = new Runtime({ log });
runtime.use('core', (event, send, alive) => bot.ingest(event, send, alive));
const transport = new OneBot(config, { onEvent: (...args) => runtime.dispatch(...args), log });
const timer = setInterval(() => bot.tick(), 30000);
transport.start();
log('service_started');

let consoleServer = null;
if (config.consoleEnabled) {
  consoleServer = createConsole({ config, store, bot, transport, runtime, log, startedAt });
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
  store.close(); log('service_stopped');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
