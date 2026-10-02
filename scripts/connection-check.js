import { loadConfig } from '../src/config.js';
import { OneBot } from '../src/onebot.js';

const config = loadConfig();
const transport = new OneBot(config, { log: event => {
  if (event === 'account_mismatch') console.error('登录 QQ 与 BOT_QQ 不匹配。');
} });
transport.start();
const deadline = Date.now() + 12000;
while (!transport.ready && !transport.stopped && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (transport.ready) {
  console.log('NapCat 连接和账号校验通过。此检查没有发送 QQ 消息或调用模型。');
} else {
  console.error('NapCat 尚未连接：检查登录、端口和 Token。');
  process.exitCode = 1;
}
transport.stop();
