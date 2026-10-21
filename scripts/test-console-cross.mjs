// 跨渠道互通面板（T-016）的静态校验：不能跑 Playwright 的环境里，用它守住真正会摔人的那几处契约。
//
// 这个文件只读 public/console.html 的文本，不起服务、不发请求。它管的是「接线有没有接错」：
//   - 视图契约：侧栏有 data-view="cross"，页面有 data-page="cross" 的 section，consolePages 里也注册了；
//   - 接口契约：GET/POST 都打 /api/socialV2/cross，POST 的 body 是 { groups: { key: gid } }；
//   - 展示契约：滑动窗口（固定高度 + sticky 表头）、四列、统计行、空态、缓冲上限都有落点；
//   - 刷新契约：只有停在 #cross 才拉数据，保存后强拉一次，读失败会 toast 而不是吞掉；
//   - 形态契约：这一页只有元数据，不许出现 JSON 代码块 / 消息正文预览。
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
const sectionStart = html.indexOf('<section id="section-cross"');
const sectionEnd = html.indexOf('</section>', sectionStart);
const panel = sectionStart > -1 && sectionEnd > sectionStart ? html.slice(sectionStart, sectionEnd) : '';
// 样式切片：从 T-016 注释段到下一段「社交自动化」。只在这段里查面板自己的 CSS。
const cssStart = html.indexOf('/* ===== 跨渠道互通（T-016）');
const cssEnd = html.indexOf('/* ── 社交自动化（T-009）', cssStart);
const crossCss = cssStart > -1 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : '';

console.log('## 视图与导航');
ok(sectionStart > -1, '存在 section#section-cross', panel ? `${panel.length} 字符` : '切片为空');
ok(/<section id="section-cross" data-page="cross" class="card span-all">/.test(html), 'section 带 data-page="cross" 且整行铺满');
ok((html.match(/data-view="cross"/g) ?? []).length === 1, '侧栏只有一个 data-view="cross"');
const affectAt = html.indexOf('data-view="affect"');
const crossAt = html.indexOf('data-view="cross"');
const usageAt = html.indexOf('data-view="usage"');
ok(affectAt > -1 && crossAt > affectAt && usageAt > crossAt, '「跨渠道互通」排在「情绪」之后、「令牌与花费」之前');
ok(/data-view="cross" class="nav-item"><span class="nav-icon" aria-hidden="true">⇄<\/span>跨渠道互通<\/button>/.test(html), '导航按钮沿用 nav-item / nav-icon 结构');
ok(/<h2 data-note="[^"]*">跨渠道互通<\/h2>/.test(panel), 'section 里有 h2 标题');
ok(/\n  cross: \['跨渠道互通', '同一个编号，就是同一个圈子。', '把群和私聊分进同一组，让 AI 记得住你在别处说过的话。'\],/.test(html), 'consolePages 里注册了 cross（哈希路由才认它）');
ok(panel.includes('同一个编号 = 同一个圈子：编号相同的会话可以互相回忆对方说过的话；0 = 不共享。'), '一行说明讲清「同一个编号 = 同一个圈子」与 0 的含义');
ok(/document\.getElementById\('breadcrumbPage'\)\.textContent = consolePages\[page\]\[0\]/.test(html), '面包屑/标题仍走 consolePages（新页自动有标题）');

console.log('## 面板元素');
for (const id of ['crossList', 'crossSave', 'crossStats', 'crossBufferNote']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `元素 ${id}`, `${n} 处`);
}
ok(/<div class="cross-head" aria-hidden="true"><span>会话<\/span><span>编号<\/span><span>缓冲<\/span><span>最后一条<\/span><\/div>/.test(panel), '表头四列：会话 / 编号 / 缓冲 / 最后一条');
ok(/<button id="crossSave" class="primary" type="button">保存分组<\/button>/.test(panel), '保存按钮是 primary 且显式 type="button"');
ok(panel.includes('保存后立刻生效，不需要重启桥接。'), '一行提示：保存后立刻生效，不需要重启桥接');
ok(panel.includes('每个会话最多保留 — 条'), '缓冲上限先占位（拿到数据后填真值）');
ok(panel.includes('会话 — · 互通组 — · 已共享 —'), '统计行先占位');
ok(html.includes('还没有任何会话记录；等 AI 收发过消息后再来看。'), '空列表有明确空态');

console.log('## 读写接口');
ok(/api\('\/api\/socialV2\/cross'\)/.test(html), 'GET /api/socialV2/cross（读会话列表）');
ok(/api\('\/api\/socialV2\/cross', 'POST', \{ groups \}\)/.test(html), 'POST /api/socialV2/cross，body 是 { groups }');
ok(/groups\[input\.dataset\.key\] = gid;/.test(html), '提交前从每个输入框的 data-key 收编号');
ok(/showConsoleToast\('已保存'\)/.test(html), '保存成功 toast「已保存」');
ok(/await refreshCross\(true\);/.test(html), '保存成功后立即强拉一次列表');
ok(/showConsoleToast\('保存失败：'/.test(html), '保存失败 toast 错误信息');
ok(/const CROSS_SAVE_REASONS = \{/.test(html) && /config_write_failed: '写 config\.json 失败，详情见桥接日志'/.test(html), '写盘失败也有人话说明');
ok(/bad_key: '会话 key 不合法'/.test(html) && /bad_gid: '编号必须是非负整数'/.test(html), '400 的 bad_key / bad_gid 各有说明');

console.log('## 每行怎么画');
ok(/type="number" class="cross-num" min="0" step="1"/.test(html), '编号框是 number、min=0、step=1');
ok(/data-key="' \+ esc\(key\) \+ '"/.test(html), '输入框带 data-key（key 来自接口）');
ok(/inputmode="numeric"/.test(html), '编号框在手机上弹数字键盘');
ok(/function crossGid\(value\)/.test(html) && /return Math\.floor\(n\);/.test(html), '小数/字符串统一夹成非负整数');
ok(/\(group \? 'g' : 'p'\)/.test(html) && /\(group \? '群' : '私聊'\)/.test(html), '渠道标签：群 / 私聊，带不同颜色类');
ok(/crossCountText\(conversation\.count\)/.test(html) && /' 条'/.test(html), '每行显示缓冲条数');
ok(/function crossAgo\(lastAt\)/.test(html) && /分钟前/.test(html) && /昨天/.test(html) && /return '—'/.test(html), '最后一条时间：分钟前 / 昨天 / —');
ok(/lastCross\.bufferPerConversation/.test(html), '缓冲上限读 bufferPerConversation');
ok(/lastCross\.enabled === false/.test(html), '互通开关关闭时统计行会标出来');
ok(/esc\(label\)/.test(html) && /esc\(key\)/.test(html), 'label / key 都经过 esc 再进 DOM');
ok(/\.cross-row\.is-shared \{ box-shadow:inset 3px 0 0 var\(--accent\) \}/.test(crossCss), '同组会话有左侧强调线');
ok(/row\.classList\.toggle\('is-shared'/.test(html), '强调线按当前编号实时切换');

console.log('## 滑动窗口');
ok(/\.cross-window \{[^}]*max-height:340px/.test(crossCss), '外层容器固定高度 340px');
ok(/\.cross-window \{[^}]*overflow-y:auto/.test(crossCss), '外层容器纵向滚动');
ok(/\.cross-head \{[^}]*position:sticky; top:0/.test(crossCss), '表头 sticky 在窗口顶部');
ok(/grid-template-columns:minmax\(0,1fr\) 78px 62px 88px/.test(crossCss), '表头与行共用四列网格');
ok(/#section-cross input\.cross-num \{/.test(crossCss) && /#section-cross input\.cross-num \{[^}]*width:100%/.test(crossCss), '编号框宽度被面板样式管住（不被全局 width:100% 撑爆）');
ok(!/<pre/.test(panel), '面板里没有代码块');

console.log('## 刷新接线');
ok(/if \(currentConsolePage === 'cross'\) refreshCross\(\);/.test(html), 'refresh() 里按当前视图守着跨渠道页');
ok(/if \(page === 'cross'\) \{ crossDraft\.clear\(\); crossRenderedSig = null; paintCross\(\); refreshCross\(true\); \}/.test(html), '切到这一页先清草稿、画缓存、再强拉一次');
ok(/function paintCross\(\)/.test(html) && /async function refreshCross\(force = false\)/.test(html), 'paintCross / refreshCross 都定义了');
ok(/if \(!force && crossFetchedAt > 0 && Date\.now\(\) - crossFetchedAt < 5000\)/.test(html), '5 秒节流（3 秒轮询不会每拍都打接口）');
ok(/if \(crossLoading\) \{ if \(force\) crossAgain = true; return; \}/.test(html), '并发守卫：保存后的强拉不会被在途请求吞掉');
ok(/showConsoleToast\('跨渠道互通读取失败：' \+ failure\)/.test(html), '读失败弹 toast，不静默吞异常');
ok(/if \(failure && failure !== crossErrorShown\)/.test(html), '同一条读错误只弹一次，不刷屏');
ok(/setConsolePage\(location\.hash\.slice\(1\)/.test(html), '首屏仍按 hash 定页（带 #cross 直接打开可用）');

console.log('## 形态与安全');
ok(!/crossJson|JSON\.stringify\((?:lastCross|r)\)/.test(panel) && !panel.includes('crossJson'), '面板里没有 JSON 预览（没有 crossJson 之类）');
ok(!/JSON/.test(panel), '面板文案里不出现 JSON');
ok(!/演示/.test(panel), '面板文案里没有内部术语「演示」');
ok(!/<script[^>]+src=/.test(panel) && !/<link[^>]+href="http/.test(panel), '面板没有引入外部脚本/样式');
ok(!/x-console-token['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html) && !/consoleToken['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html), 'HTML 里没有写死控制台令牌');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }
const crossJsStart = html.indexOf('// ── 跨渠道互通（T-016）');
const crossJsEnd = html.indexOf('setConsolePage(location.hash.slice(1)', crossJsStart);
const crossJs = crossJsStart > -1 && crossJsEnd > crossJsStart ? html.slice(crossJsStart, crossJsEnd) : '';
try { new Function(crossJs); ok(crossJs.length > 0, '新增的跨渠道段语法可解析', `${crossJs.length} 字符`); }
catch (e) { ok(false, '新增的跨渠道段语法', e.message); }

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
