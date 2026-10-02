import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Model } from './model.js';
import { Bot } from './bot.js';
import { OneBot } from './onebot.js';
import { createLogger } from './logger.js';

let config;
try { config = loadConfig(); }
catch (error) { console.error(error.message); process.exit(1); }
if (process.argv.includes('--check')) {
  console.log('配置校验通过；尚未测试 NapCat 连接或调用模型。');
  process.exit(0);
}
const store = new Store(config.databasePath);
const log = createLogger();
const bot = new Bot(config, store, new Model(config), { log });
const transport = new OneBot(config, { onEvent: (...args) => bot.ingest(...args), log });
const timer = setInterval(() => bot.tick(), 30000);
transport.start();
log('service_started');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer); transport.stop();
  // Wait for in-flight model usage settlement before closing SQLite.
  await bot.tail;
  store.close(); log('service_stopped');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
