import { loadConfig } from '../src/config.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const config = loadConfig();
const directory = resolve('runtime/napcat/config');
mkdirSync(directory, { recursive: true });
const socket = new URL(config.wsUrl);
const onebot = {
  network: { httpServers: [], httpClients: [], websocketClients: [], websocketServers: [{
    name: 'AutoChatLocal', enable: true, host: '127.0.0.1', port: Number(socket.port || 80),
    messagePostFormat: 'array', reportSelfMessage: false, token: config.onebotToken,
    enableForcePushEvent: true, debug: false, heartInterval: 30000,
  }] }, musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
};
const onebotPath = join(directory, `onebot11_${config.botId}.json`);
// Account-specific file only; do not overwrite another account's configuration.
writeFileSync(onebotPath, JSON.stringify(onebot, null, 2));
const webuiPath = join(directory, 'webui.json');
const webui = existsSync(webuiPath) ? JSON.parse(readFileSync(webuiPath, 'utf8')) : {};
writeFileSync(webuiPath, JSON.stringify({ ...webui, host: '127.0.0.1', port: 6099,
  token: webui.token || randomBytes(32).toString('hex'), loginRate: 3 }, null, 2));
console.log('NapCat 本机配置已写入；接口 Token 已同步，未显示密钥。');
