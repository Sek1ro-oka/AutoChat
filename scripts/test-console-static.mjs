// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages), 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(tools.includes('sendVoice'), 'sendVoice 开关存在', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');

console.log('## 语音面板接线');
ok(/id="voiceRefreshBtn"/.test(html) && /getElementById\('voiceRefreshBtn'\)\.addEventListener/.test(html), '刷新按钮已绑定事件');
ok(/getElementById\('voiceSendBtn'\)\.addEventListener/.test(html), '试发按钮已绑定事件');
ok(/api\('\/api\/voice\/list/.test(html), '面板调用 /api/voice/list（操作者通道，无需 key）');
ok(/api\('\/api\/voice\/send'/.test(html), '面板调用 /api/voice/send');
ok(/typeof loadVoiceLibrary === 'function'|async function loadVoiceLibrary/.test(html), 'loadVoiceLibrary 已定义');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/socialV2/voices'"), 'fixture mock 了 /api/socialV2/voices');
ok(fixture.includes("case '/api/voice/send'"), 'fixture mock 了 /api/voice/send');

console.log('## 看门狗 Demo（/demo）');
// T-002 的 Demo 是用户已确认的产物：进仓库时是逐字节复制，不重排版/不压缩/不改文案，
// 所以这里把字节数钉死；一旦有人"顺手优化"了它，这条会立刻失败。
const demoPath = path.join(ROOT, 'public', 'stall-watchdog-demo.html');
const demoExists = fs.existsSync(demoPath);
const demoBytes = demoExists ? fs.statSync(demoPath).size : -1;
ok(demoBytes === 29205, 'Demo 已挂到 public/ 且字节数 = 29205', demoExists ? `${demoBytes} 字节` : '文件不存在');
const demo = demoExists ? fs.readFileSync(demoPath, 'utf8') : '';
// Demo 必须保持零外链：CSP 是 default-src/script-src/style-src 'self'，任何外部资源都会静默失败。
const externalPatterns = ['http://', 'https://', 'fetch(', 'XMLHttpRequest', '<link', '<img', '<iframe'];
const externalHits = externalPatterns
  .map((needle) => [needle, (demo.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length])
  .filter(([, n]) => n > 0);
ok(externalHits.length === 0, 'Demo 零外链（http/https/fetch/XHR/link/img/iframe）', externalHits.length ? externalHits.map(([s, n]) => `${s}×${n}`).join(', ') : `${externalPatterns.length} 项全为 0`);

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const gateAt = bridge.indexOf('if (consoleToken && !tokenMatches)');
// 只认"独立路由"那一处：关卡里的判断是多一层括号的 (/ || /demo)，不会被这条正则误命中。
const routeAt = bridge.search(/if \(req\.method === 'GET' && url\.pathname === '\/demo'\)\s*\{/);
ok(routeAt > -1 && gateAt > -1 && routeAt > gateAt, 'bridge.js 存在 /demo 路由且位于令牌关卡之后', `关卡位置 ${gateAt} < 路由位置 ${routeAt}`);
ok(gateAt > -1 && routeAt > gateAt && bridge.slice(gateAt, routeAt).includes("'/demo'"), '令牌关卡本身认得 /demo（401 回跳 /demo 而非控制台首页）');

ok(/id="demoLink"[^>]*href="\/demo"/.test(html), '控制台存在指向 /demo 的入口链接');
ok(/const saved = localStorage\.getItem\('consoleToken'\)/.test(html) && /demoLink\.href = saved \? '\/demo\?token='/.test(html), '入口按已有令牌拼 /demo?token=（不写死令牌）');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
