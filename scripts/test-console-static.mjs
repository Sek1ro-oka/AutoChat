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

console.log('## 决策沙盘（#sandbox 视图，原 /demo 页面已内联）');
// 原来独立的 public/stall-watchdog-demo.html 已经整段搬进 console.html 的 #sandbox 视图，文件本身删掉：
// 留着就会有两份各自漂移的拷贝，而这页面本身就是"阈值决策"的唯一说明书。
const demoPath = path.join(ROOT, 'public', 'stall-watchdog-demo.html');
ok(!fs.existsSync(demoPath), 'public/stall-watchdog-demo.html 已删除（内容已内联）');
ok(!html.includes('stall-watchdog-demo.html'), 'console.html 里没有指向已删文件的字样');

ok(/<section class="card" id="sandbox" data-page="sandbox">/.test(html), '存在 #sandbox 视图（data-page="sandbox"）');
ok((html.match(/data-view="sandbox"/g) ?? []).length === 1, '侧栏入口只有一处');
ok(!/href="\/demo"/.test(html), '页面里不再有指向 /demo 的外链（已改成本页视图）');
ok((html.match(/id="sandboxScript"/g) ?? []).length === 1, '沙盘脚本容器 #sandboxScript 只有一处');
ok(/<script type="text\/plain" id="sandboxScript">/.test(html), '沙盘脚本以 text/plain 存放（页面加载时不执行）');
ok(/let sandboxInited = false;/.test(html) && /function initSandbox\(\) \{/.test(html), 'initSandbox 已定义');
ok(/if \(page === 'sandbox'\) initSandbox\(\);/.test(html), 'setConsolePage 切到 #sandbox 时调用 initSandbox');
ok(/currentConsolePage === 'sandbox'/.test(html)
  && /addEventListener\('DOMContentLoaded', \(\) => initSandbox\(\)\)/.test(html), '#sandbox 直达时在 DOM 就绪后补一次');
ok(/sandbox: \['决策沙盘'/.test(html), 'consolePages 里注册了 sandbox（哈希路由才认它）');
// 沙盘自带标题栏、没有 h2：控制台的搜索索引会遍历每个 section 取 h2，取不到就 null.textContent 崩掉整页。
ok(/const heading = section\.querySelector\('h2'\);/.test(html)
  && /heading \? heading\.textContent : consolePages\[page\]\[0\]/.test(html), '搜索索引容忍没有 h2 的视图');

// 样式是机械作用域化的：沙盘 CSS 里的 .card/.brand/.tag 与控制台重名，不挂 #sandbox 就会反向污染整个控制台。
const styleStart = html.indexOf('<style id="sandboxStyle">');
const styleEnd = html.indexOf('</style>', styleStart);
ok(styleStart > -1 && styleEnd > styleStart, '沙盘样式段存在（<style id="sandboxStyle">）');
const sandboxCss = styleStart > -1 && styleEnd > styleStart ? html.slice(styleStart, styleEnd) : '';
const hashCount = (sandboxCss.match(/#sandbox/g) ?? []).length;
ok(/#sandbox \.wrap\{/.test(sandboxCss) && /#sandbox \.brand\{/.test(sandboxCss) && /#sandbox \.card\{/.test(sandboxCss), '沙盘选择器都挂了 #sandbox 前缀');
ok(/#sandbox, #sandbox \*\{box-sizing:border-box\}/.test(sandboxCss), '全局 * 规则被改写成 #sandbox, #sandbox *');
const badTop = sandboxCss.split(/\r?\n/).filter((line) => /^\s*\./.test(line) || /^\s*(?:html|body)\b/.test(line)
  || /^\s*:root\b/.test(line) || /^\s*\*\s*\{/.test(line));
ok(badTop.length === 0, '没有未加 #sandbox 前缀的顶层选择器', badTop.length ? badTop.slice(0, 3).join(' | ') : '#sandbox ×' + hashCount);
ok(hashCount >= 100, '#sandbox 出现次数与规则数相当', '#sandbox ×' + hashCount);
ok(/#sandbox\.card\{[\s\S]{0,160}?border:0/.test(sandboxCss), '中和了控制台 .card 的边框');
ok(/#sandbox\.card\{[\s\S]{0,160}?grid-column:1\/-1/.test(sandboxCss), '沙盘横跨整行（否则会被压进页面网格的一列）');

// 沙盘原本是独立页面、零外链（CSP 是 'self'），搬进来以后这条性质必须保持。
const holder = html.match(/<script type="text\/plain" id="sandboxScript">([\s\S]*?)<\/script>/);
ok(!!holder, '能取出沙盘脚本正文');
const sandboxJs = holder ? holder[1] : '';
const externalPatterns = ['http://', 'https://', 'fetch(', 'XMLHttpRequest', '<link', '<img', '<iframe'];
const externalHits = externalPatterns
  .map((needle) => [needle, (sandboxJs.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length])
  .filter(([, n]) => n > 0);
ok(externalHits.length === 0, '沙盘脚本零外链（http/https/fetch/XHR/link/img/iframe）', externalHits.length ? externalHits.map(([s, n]) => s + '×' + n).join(', ') : externalPatterns.length + ' 项全为 0');
try { new Function(sandboxJs); ok(true, '沙盘脚本语法可解析', sandboxJs.length + ' 字符'); }
catch (e) { ok(false, '沙盘脚本语法', e.message); }

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const gateAt = bridge.indexOf('if (consoleToken && !tokenMatches)');
// 只认"独立路由"那一处：关卡里的判断是多一层括号的 (/ || /demo)，不会被这条正则误命中。
const routeAt = bridge.search(/if \(req\.method === 'GET' && url\.pathname === '\/demo'\)\s*\{/);
ok(routeAt > -1 && gateAt > -1 && routeAt > gateAt, 'bridge.js 存在 /demo 路由且位于令牌关卡之后', '关卡位置 ' + gateAt + ' < 路由位置 ' + routeAt);
ok(routeAt > -1 && /res\.writeHead\(302, \{ Location: '\/#sandbox', 'Cache-Control': 'no-store' \}\)/.test(bridge.slice(routeAt, routeAt + 400)), '/demo 现在是 302 到 /#sandbox（no-store）');
ok(!/stall-watchdog-demo\.html/.test(bridge), 'bridge.js 不再读取已删除的 static Demo 文件');
ok(gateAt > -1 && routeAt > gateAt && bridge.slice(gateAt, routeAt).includes("'/demo'"), '令牌关卡本身认得 /demo（跳转前一样要过令牌）');

console.log('## 开关页（看门狗自动硬清理）');
ok(/data-view="switches"/.test(html) && /data-page="switches"/.test(html), '侧栏入口与新视图都在', 'data-view + data-page');
ok(html.indexOf('data-view="switches"') > 0
  && html.indexOf('data-view="switches"') < html.indexOf('data-view="sandbox"'), '侧栏顺序：开关在决策沙盘之前');
for (const id of ['wdBadge', 'wdRunBadge', 'wdStats', 'wdLastKill', 'wdThresholds', 'wdSuspects', 'wdSuspectCount', 'wdToggle', 'wdMsg']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `开关页元素 ${id}`, `${n} 处`);
}
ok(/getElementById\('wdToggle'\)\.addEventListener\('click', toggleWatchdog\)/.test(html), '开关按钮已绑定 toggleWatchdog');
ok(/api\('\/api\/watchdog', 'POST', \{ enabled: !current \}\)/.test(html), '开关按钮调 POST /api/watchdog');
ok(html.includes('关闭后卡死的会话不会再被自动清理，确定？')
  && html.includes('启用后卡死超过 30 分钟的会话会被自动清理，确定？'), '确认文案写清「会失去什么」');
// 阈值只能从上报的毫秒数换算：任何一天改了阈值，写死的中文就会变成谎话。
ok(/wdSpan\(wd\.softMs, 60000\)/.test(html) && /wdSpan\(wd\.hardMs, 60000\)/.test(html)
  && /wdSpan\(wd\.scanMs, 1000\)/.test(html) && /wd\.confirmRounds/.test(html), '阈值由 softMs/hardMs/scanMs/confirmRounds 换算');
ok(!/软 15 分钟/.test(html), '没有写死「软 15 分钟」');
ok(/currentConsolePage === 'switches'\) renderWatchdog\(lastWatchdog\)/.test(html), 'refresh() 仅在开关页渲染看门狗');
ok(/if \(page === 'switches'\) renderWatchdog\(lastWatchdog\)/.test(html), 'setConsolePage 切页时用缓存快照即时渲染');
ok(/switches: \['开关'/.test(html), 'consolePages 里注册了 switches（切页标题/哈希路由才认它）');
ok(html.includes('当前没有疑似僵死') && html.includes('>0 条<'), '空表占位与 0 条计数都在');

// ── 说说卡（T-007b）：占位换成真卡片，id 全部 qz 前缀，不碰 wd* ──
console.log('## 开关页（说说）');
for (const id of ['qzBadge', 'qzStats', 'qzNext', 'qzScope', 'qzLatest', 'qzToggle', 'qzMsg', 'qzList', 'qzEmpty', 'qzBody']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `说说卡元素 ${id}`, `${n} 处`);
}
ok(/getElementById\('qzToggle'\)\.addEventListener\('click', toggleQzone\)/.test(html), '开关按钮已绑定 toggleQzone');
ok(/api\('\/api\/qzone\/config', 'POST', \{ enabled: !current \}\)/.test(html), '开关按钮调 POST /api/qzone/config');
// 两句确认文案必须逐字在：开关是可逆的，但「关掉之后不能发」这件事要说在点下去之前。
ok(html.includes('开启后机器人可以自己发空间动态，确定？')
  && html.includes('关闭后机器人不能再发说说，确定？'), '开关的两句确认文案逐字在（开/关各一句）');
ok(/api\('\/api\/qzone\/delete', 'POST', \{ tid \}\)/.test(html), '删除按钮调 POST /api/qzone/delete');
ok(html.includes('删除这条说说？QQ 空间里也会一起删掉，确定？'), '删除确认文案逐字在（不可逆要说清代价）');
ok(/api\('\/api\/qzone\/recent'\)/.test(html), '读数来自 GET /api/qzone/recent（/api/status 没有这个字段）');
ok(/currentConsolePage === 'switches'\) await refreshQzone\(\)/.test(html), 'refresh() 仅在开关页拉说说读数');
ok(/if \(page === 'switches'\) \{ renderQzone\(lastQzone\); refreshQzone\(\); \}/.test(html), 'setConsolePage 切到开关页时先渲染缓存再拉');
ok(html.includes("'今日已发 '") && html.includes("' 条'"), '读数行显示 今日已发 N 条（不写死上限）');
ok(html.includes('距下次可发 ') && html.includes('默认可见范围 ') && html.includes('最近一次 '), '四项读数标题都在');
ok(!/软 15 分钟/.test(html) && html.includes('现在可以发'), '倒计时用接口给的 nextAllowedAt 现算');
ok(/QZONE_RIGHT_LABELS = Object\.freeze\(\{ 1: '所有人可见', 4: '好友可见', 64: '仅自己可见' \}\)/.test(html), '可见范围三档与 QZONE_UGC_RIGHTS 语义一致');
ok(html.includes('还没有发过说说。'), '空表占位在');
// 空表文案必须每次渲染都写回：首帧是「读取中…」，不写回去的话删到最后一条以后会一直停在「读取中…」。
ok(/empty\.textContent = '还没有发过说说。';/.test(html), '空表文案在有数据的分支里也写回（不会卡在「读取中…」）');
ok(html.includes('本机记录') && html.includes('不代表空间里的真实状态'), '说清「本机记录」不等于空间里的真实状态');
ok(html.includes('qzone.ugcRight') && html.includes('控制台只读'), '可见范围标注为只读（由 config.json 决定）');
ok(html.includes('已写盘'), '界面明确说了「写盘持久」，不跟只存内存的看门狗开关混着讲');
ok(!/立即发布|马上发一条/.test(html), '没有「立即发一条」之类的按钮');
ok(!html.includes('说说功能尚未接入'), '旧的「尚未接入」占位已删除');
ok(!/<span class="meta">T-006<\/span>/.test(html), 'T-006 角标已摘掉');
ok(!html.includes('这里的开关只影响桥接运行时'), '「开关只影响运行时」这句两义说明已拆开');
ok(/history\.replaceState\(/.test(html), 'URL 里的 ?token= 读完后用 replaceState 抹掉');
ok(!/演示/.test(html), '页面仍无「演示」字样');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
