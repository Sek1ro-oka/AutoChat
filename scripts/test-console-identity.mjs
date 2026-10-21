// 名字映射面板（T-018）的静态校验：不能跑 Playwright 的环境里，用它守住真正会摔人的那几处契约。
//
// 这个文件只读 public/console.html 的文本，不起服务、不发请求。它管的是「接线有没有接错」：
//   - 视图契约：侧栏有 data-view="identity"，页面有 data-page="identity" 的 section，consolePages 里也注册了；
//   - 接口契约：GET /api/socialV2/identity?q=&limit=50 读，POST /api/socialV2/identity/refresh 手动同步；
//   - 交互契约：输入 300ms 防抖、回车立即查、只在停在 #identity 时 15 秒轮询、切走就停；
//   - 展示契约：滑动窗口（固定高度 + sticky 表头）、五列、统计行、空态、同 key 高亮；
//   - 形态契约：这一页只读名字与号码，不许出现 JSON 代码块 / 消息正文 / 写死令牌。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

// 面板本体：这一块没有嵌套 section，切到第一个 </section> 就是它的边界。
const sectionStart = html.indexOf('<section id="section-identity"');
const sectionEnd = html.indexOf('</section>', sectionStart);
const panel = sectionStart > -1 && sectionEnd > sectionStart ? html.slice(sectionStart, sectionEnd) : '';
// 样式切片：从 T-018 注释段到下一段「社交自动化」。只在这段里查面板自己的 CSS。
const cssStart = html.indexOf('/* ===== 名字映射（T-018）');
const cssEnd = html.indexOf('/* ── 社交自动化（T-009）', cssStart);
const identityCss = cssStart > -1 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : '';
// JS 切片：从 T-018 注释段到首屏按 hash 定页那一行。只在这段里查函数与常量。
const jsStart = html.indexOf('// ── 名字映射（T-018）');
const jsEnd = html.indexOf('setConsolePage(location.hash.slice(1)', jsStart);
const identityJs = jsStart > -1 && jsEnd > jsStart ? html.slice(jsStart, jsEnd) : '';

console.log('## 视图与导航');
ok(sectionStart > -1, '存在 section#section-identity', panel ? `${panel.length} 字符` : '切片为空');
ok(/<section id="section-identity" data-page="identity" class="card span-all">/.test(html), 'section 带 data-page="identity" 且整行铺满');
ok((html.match(/data-view="identity"/g) ?? []).length === 1, '侧栏只有一个 data-view="identity"');
const crossAt = html.indexOf('data-view="cross"');
const identityAt = html.indexOf('data-view="identity"');
const manageAt = html.indexOf('<div class="nav-label">管理</div>');
ok(crossAt > -1 && identityAt > crossAt && manageAt > identityAt, '「名字映射」排在「跨渠道互通」之后、「管理」分组之前');
ok(/data-view="identity" class="nav-item"><span class="nav-icon" aria-hidden="true">⌗<\/span>名字映射<\/button>/.test(html), '导航按钮沿用 nav-item / nav-icon 结构');
ok(/<h2 data-note="[^"]*">名字映射<\/h2>/.test(panel), 'section 里有 h2 标题（带 data-note）');
ok(/\n  identity: \['名字映射', '这台机器认识的每一个人和群。', '按名字找人，拿到能直接发消息的 key。'\],/.test(html), 'consolePages 里注册了 identity（哈希路由才认它）');
ok(/document\.getElementById\('breadcrumbPage'\)\.textContent = consolePages\[page\]\[0\]/.test(html), '面包屑/标题仍走 consolePages（新页自动有标题）');
ok(panel.includes('好友、群、群里见过的人。数据来自好友列表/群列表/消息，后台每 6 小时刷新。'), '一行说明讲清数据来源与 6 小时刷新');
ok(!/data-view="identity"[^>]*disabled/.test(html) && !/data-view="identity"[^>]*hidden/.test(html), '导航按钮没有被禁用/隐藏');

console.log('## 面板元素');
for (const id of ['identityQuery', 'identityRefresh', 'identityStats', 'identityList']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `元素 ${id}`, `${n} 处`);
}
ok(/<input id="identityQuery" class="identity-query" type="search" placeholder="输入名字、群名、QQ 号或群号…" autocomplete="off"/.test(panel), '搜索框是 search 类型，placeholder 讲清能搜名字/群名/QQ 号/群号');
ok(/<button id="identityRefresh" class="primary" type="button">刷新名字表<\/button>/.test(panel), '刷新按钮是 primary 且显式 type="button"');
ok(/<div class="identity-head" aria-hidden="true"><span>类型<\/span><span>名字<\/span><span>号码<\/span><span>key<\/span><span>最后活跃<\/span><\/div>/.test(panel), '表头五列：类型 / 名字 / 号码 / key / 最后活跃');
ok(panel.includes('好友 — · 群 — · 成员 —'), '统计行先占位（好友 / 群 / 成员）');
ok(panel.includes('读取中…'), '首屏列表先显示「读取中…」而不是空白');
ok(/<div class="identity-stats" id="identityStats" role="status" aria-live="polite">/.test(panel), '统计行带 role="status"，读屏能播报');
ok(/class="identity-window"/.test(panel) && /id="identityList"/.test(panel), '列表装在滑动窗口里（表头固定、列表滚动）');

console.log('## 读写接口');
ok(/api\(identityUrl\(\)\)/.test(identityJs) && /'\/api\/socialV2\/identity\?' \+ params\.toString\(\)/.test(identityJs), 'GET /api/socialV2/identity?q=&limit= 读名字表');
ok(/const IDENTITY_LIMIT = 50;/.test(identityJs) && /params\.set\('limit', String\(IDENTITY_LIMIT\)\)/.test(identityJs), '每页上限 50（limit 由常量带）');
ok(/params\.set\('q', query\)/.test(identityJs) && /const query = identityQuery\.trim\(\);/.test(identityJs), '查询词先 trim 再进 q，空词不带 q');
ok(/api\('\/api\/socialV2\/identity\/refresh', 'POST'\)/.test(identityJs), 'POST /api/socialV2/identity/refresh 手动同步一次');
ok(/showConsoleToast\('名字表已刷新'\)/.test(identityJs), '刷新成功 toast「名字表已刷新」');
ok(/identityFetchedAt = 0;\s*\n\s*await refreshIdentity\(true\);/.test(identityJs), '刷新成功后立刻强拉当前搜索词');
ok(/if \(button\) button\.disabled = true;/.test(identityJs) && /if \(button\) button\.disabled = false;/.test(identityJs), '刷新按钮在请求期间 disabled，结束后恢复');
ok(/showConsoleToast\('刷新失败：'/.test(identityJs), '刷新失败 toast 错误信息');
ok(/if \(r && r\.ok === true\) lastIdentity = r;/.test(identityJs), '只认 { ok:true } 的响应，坏响应不覆盖上一份数据');

console.log('## 交互接线');
ok(/const IDENTITY_DEBOUNCE_MS = 300;/.test(identityJs) && /\}, IDENTITY_DEBOUNCE_MS\);/.test(identityJs), '输入 300ms 防抖');
ok(/clearTimeout\(identityTimer\);/.test(identityJs), '新输入/切页会清掉还没到点的防抖');
ok(/event\.key === 'Enter'\) identitySearchNow\(event\);/.test(identityJs) && /if \(event\) event\.preventDefault\(\);/.test(identityJs), '回车立即查（不提交表单）');
ok(/if \(event && event\.isComposing\) return;/.test(identityJs), '中文输入法组字期间不查');
ok(/function identityViewActive\(\) \{\s*\n\s*return currentConsolePage === 'identity';/.test(identityJs), 'identityViewActive() 就是当前视图判断');
ok(/if \(!force && !identityViewActive\(\)\) return;/.test(identityJs), '不在这一页时读取直接返回（切走即停）');
ok(/if \(currentConsolePage === 'identity'\) refreshIdentity\(\);/.test(html), 'refresh() 的 3 秒轮询里按当前视图守着名字表');
ok(/const IDENTITY_POLL_MS = 15000;/.test(identityJs) && /Date\.now\(\) - identityFetchedAt < IDENTITY_POLL_MS\)/.test(identityJs), '15 秒节流（3 秒轮询不会每拍都打接口）');
ok(/if \(page === 'identity'\) \{ identityRenderedSig = null; paintIdentity\(\); refreshIdentity\(true\); \}/.test(html), '切到这一页先画缓存、再强拉一次');
ok(/else if \(identityTimer\) \{ clearTimeout\(identityTimer\); identityTimer = 0; \}/.test(html), '切走时清掉防抖计时器');
ok(/if \(identityLoading\) \{ if \(force\) identityAgain = true; return; \}/.test(identityJs), '并发守卫：「立刻刷新」不会被在途请求吞掉');

console.log('## 每行怎么画');
ok(/<span class="identity-tag ' \+ IDENTITY_KIND_CLASS\[kind\] \+ '">' \+ IDENTITY_KIND_LABEL\[kind\] \+ '<\/span>/.test(identityJs), '类型列画成彩色标签（好友 / 群 / 群成员）');
ok(/const IDENTITY_KIND_LABEL = \{ private: '好友', group: '群', member: '群成员' \};/.test(identityJs), '三种类型的人话标签齐全');
ok(/identity-number">' \+ esc\(number === '' \? '—' : number\)/.test(identityJs), '号码列空值画破折号，非空走 esc');
ok(/identity-key">' \+ esc\(key === '' \? '—' : key\)/.test(identityJs), 'key 列用于直接发消息，空值画破折号');
ok(/identity-time">' \+ esc\(identityAgo\(identitySeenAt\(row\)\)\)/.test(identityJs), '最后活跃列按相对时间画');
ok(/for \(const value of \[row\.lastSeenAt, row\.lastAt, row\.updatedAt\]\)/.test(identityJs), '最后活跃容错：lastSeenAt / lastAt / updatedAt 都认');
ok(/return crossAgo\(lastAt\);/.test(identityJs), '相对时间口径复用跨渠道面板的 crossAgo（刚刚 / 分钟前 / 昨天）');
ok(/esc\(name\)/.test(identityJs) && /esc\(key\)/.test(identityJs) && /esc\(groupName\)/.test(identityJs), '名字 / key / 群名都经过 esc 再进 DOM');
ok(/kind === 'member' && groupName !== ''/.test(identityJs), '群成员额外显示「在 群名」');
ok(/'没有匹配，换个名字、群名或号码试试'/.test(identityJs), '空态文案包含「没有匹配」');
ok(/function identitySharedKeys\(rows\)/.test(identityJs) && /shared\.has\(identityKeyOf\(row\)\)/.test(identityJs), '同一个 key 出现多行时标记出来');
ok(/' is-dupe' : ''/.test(identityJs), '同 key 的行加 is-dupe 类（左侧强调线）');
ok(/'<div class="identity-row'/.test(identityJs) && /identity-kind/.test(identityJs), '行结构是五格网格');

console.log('## 样式与安全');
ok(/\.identity-window \{[^}]*max-height:340px/.test(identityCss), '外层容器固定高度 340px');
ok(/\.identity-window \{[^}]*overflow-y:auto/.test(identityCss), '外层容器纵向滚动');
ok(/\.identity-head \{[^}]*position:sticky; top:0/.test(identityCss), '表头 sticky 在窗口顶部');
ok(/grid-template-columns:64px minmax\(0,1fr\) 108px minmax\(0,150px\) 88px/.test(identityCss), '表头与行共用五列网格');
ok(/\.identity-row\.is-dupe \{ box-shadow:inset 3px 0 0 var\(--accent\) \}/.test(identityCss), '同 key 行有左侧强调线');
ok(/input\.identity-query \{[^}]*min-width:0/.test(identityCss), '搜索框宽度被面板样式管住（不被全局 width:100% 撑爆）');
ok(!/\.cross-[a-z]/.test(identityCss), '新样式没有改/复用既有 cross-* 类');
ok(!/<pre/.test(panel) && !/JSON/.test(panel), '面板里没有 JSON / 代码块');
ok(!/演示/.test(panel), '面板文案里没有内部术语「演示」');
ok(!/<script[^>]+src=/.test(panel) && !/<link[^>]+href="http/.test(panel), '面板没有引入外部脚本/样式');
ok(!/x-console-token['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html), 'HTML 里没有写死控制台令牌');

console.log('## 标签闭合');
const openDiv = (panel.match(/<div\b/g) ?? []).length;
const closeDiv = (panel.match(/<\/div>/g) ?? []).length;
ok(panel !== '' && openDiv === closeDiv, '面板内 <div> 与 </div> 数量相等', `${openDiv} / ${closeDiv}`);
ok((panel.match(/<section\b/g) ?? []).length === 1 && (panel.match(/<\/section>/g) ?? []).length === 0, 'section 切片止于自身结束标签之前');
ok((html.match(/<section id="section-identity"/g) ?? []).length === 1, 'section#section-identity 只出现一次');
ok((html.match(/data-page="identity"/g) ?? []).length === 1, 'data-page="identity" 只有一处');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }
try { new Function(identityJs); ok(identityJs.length > 0, '新增的名字映射段语法可解析', `${identityJs.length} 字符`); }
catch (e) { ok(false, '新增的名字映射段语法', e.message); }

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
