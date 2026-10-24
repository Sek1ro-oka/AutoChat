// 跨渠道互通面板（T-016 + T-035 C4「互通组人格」）的静态校验：
// 不能跑 Playwright 的环境里，用它守住真正会摔人的那几处契约。
//
// 这个文件只读 public/console.html 的文本，不起服务、不发请求。它管的是「接线有没有接错」：
//   - 视图契约：侧栏有 data-view="cross"，页面有 data-page="cross" 的 section，consolePages 里也注册了；
//   - 组总览契约：吸顶 + 独立滚动（position:sticky; max-height:42vh; overflow:auto）、五列表头、
//     三态人格下拉（继承 / 不使用人格卡 / 卡）、新增组（max+1）与清除闲置绑定；
//   - 会话契约：编号列是 <select data-key>，选项 0（不共享）+ 各组；
//   - 接口契约：读 /api/socialV2/cross 与 /api/roles/bindings；预演打 /plan；保存**一次** apply
//     提交 groups + gids + bindings 并带 baseRevision；合并冲突用 mergeChoice 带选择；
//     409（旧 revision）只提示刷新、500（写盘失败）保留草稿；
//   - 展示契约：未保存变更 N 项、预览计数（将重建 / 只改绑法 / 卡缺失）、滑动窗口、统计行、空态、缓冲上限；
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

// 面板本体：这一块没有嵌套 section，切到第一个 </section> 就是它的边界（<details> 不影响）。
const sectionStart = html.indexOf('<section id="section-cross"');
const sectionEnd = html.indexOf('</section>', sectionStart);
const panel = sectionStart > -1 && sectionEnd > sectionStart ? html.slice(sectionStart, sectionEnd) : '';
// 样式切片 1：T-016 的会话表样式；切片 2：T-035 新增的组总览 / 人格卡样式。
const cssStart = html.indexOf('/* ===== 跨渠道互通（T-016）');
const cssEnd = html.indexOf('/* ===== 名字映射（T-018）', cssStart);
const crossCss = cssStart > -1 && cssEnd > cssStart ? html.slice(cssStart, cssEnd) : '';
const groupsCssStart = html.indexOf('/* ===== 互通组人格（T-035 C4）');
const groupsCss = groupsCssStart > -1 && cssEnd > groupsCssStart ? html.slice(groupsCssStart, cssEnd) : '';
// 脚本切片：整段跨渠道互通（含新增的绑定读写）。
const jsStart = html.indexOf('// ── 跨渠道互通（T-016）');
const jsEnd = html.indexOf('// ── 名字映射（T-018）', jsStart);
const crossJs = jsStart > -1 && jsEnd > jsStart ? html.slice(jsStart, jsEnd) : '';
// 保存函数切片：断言「一次 apply + baseRevision」时只看这一段，别被别处的字符串蒙混过去。
const saveStart = crossJs.indexOf('async function crossSave()');
const saveEnd = crossJs.indexOf('// 用桥接返回的真实值回填限流输入框', saveStart);
const saveJs = saveStart > -1 && saveEnd > saveStart ? crossJs.slice(saveStart, saveEnd) : '';

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
ok(panel.includes('编号 0 = 不共享（独立会话）'), '一行说明讲清 0 = 不共享（独立会话）');
ok(panel.includes('同一个编号 = 同一个圈子'), '一行说明讲清「同一个编号 = 同一个圈子」');
ok(/document\.getElementById\('breadcrumbPage'\)\.textContent = consolePages\[page\]\[0\]/.test(html), '面包屑/标题仍走 consolePages（新页自动有标题）');

console.log('## 面板元素');
for (const id of [
  'crossGroups', 'crossGroupRows', 'crossGroupAdd', 'crossIdleClear',
  'crossList', 'crossSave', 'crossPreview', 'crossReset', 'crossDirty', 'crossRevision', 'crossImpact',
  'crossStats', 'crossBufferNote', 'crossRecallMax', 'crossRecallWindow',
  'crossCardsGroup', 'crossCardList', 'crossCardCount', 'crossInjectMax'
]) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `元素 ${id}`, `${n} 处`);
}
ok(/<div class="cross-head" aria-hidden="true"><span>会话<\/span><span>编号<\/span><span>人格<\/span><span>缓冲<\/span><span>最后一条<\/span><\/div>/.test(panel), '会话表头五列：会话 / 编号 / 人格 / 缓冲 / 最后一条');
ok(/<div class="cross-groups-head" aria-hidden="true"><span>编号<\/span><span>成员<\/span><span>生效人格<\/span><span>内容版本<\/span><span>状态<\/span><\/div>/.test(panel), '组总览表头五列：编号 / 成员 / 生效人格 / 内容版本 / 状态');
ok(/<button id="crossSave" class="primary" type="button">保存<\/button>/.test(panel), '保存按钮是 primary 且显式 type="button"');
ok(/<button id="crossPreview" class="small" type="button">预览影响<\/button>/.test(panel), '预览影响按钮在');
ok(/<button id="crossReset" class="small" type="button">重置<\/button>/.test(panel), '重置按钮在');
ok(/<span class="meta" id="crossDirty" role="status" aria-live="polite">未保存变更 0 项<\/span>/.test(panel), '未保存变更先占位（0 项）');
ok(panel.includes('保存后立刻生效，不需要重启桥接。'), '一行提示：保存后立刻生效，不需要重启桥接');
ok(panel.includes('每个会话最多保留 — 条'), '缓冲上限先占位（拿到数据后填真值）');
ok(panel.includes('会话 — · 互通组 — · 已共享 —'), '统计行先占位');
ok(html.includes('还没有任何会话记录；等 AI 收发过消息后再来看。'), '空列表有明确空态');
ok(panel.includes('编号升序，不补空号'), '组总览脚注讲清「编号升序，不补空号」');
ok(panel.includes('data-scenario="group-overview-sticky"') && panel.includes('data-scenario="new-group"')
  && panel.includes('data-scenario="idle-group"'), '组总览沿用 Demo 的 data-scenario 锚点（吸顶 / 新增组 / 闲置组）');
ok(panel.includes('未保存变更') && panel.includes('预览影响'), '底部操作条三段：未保存变更 / 预览影响 / 保存');
ok(/<div id="crossImpact" class="meta" role="status" aria-live="polite"><\/div>/.test(panel), '预览结果 / 409 / 500 的落点是 #crossImpact');

console.log('## 组总览：吸顶 + 独立滚动');
ok(/\.cross-groups \{[^}]*position:sticky/.test(crossCss + groupsCss), '组总览 position:sticky（会话列表滚动时仍可见）');
ok(/\.cross-groups \{[^}]*max-height:42vh/.test(groupsCss), '组总览最高 42vh');
ok(/\.cross-groups \{[^}]*overflow:auto/.test(groupsCss), '组总览自己滚（独立滚动区）');
ok(/\.cross-groups-head \{[^}]*position:sticky; top:0/.test(groupsCss), '组总览表头 sticky 在容器顶部');
ok(/#section-cross select\.cross-pick \{/.test(groupsCss), '行内下拉有面板自己的宽度规则（不被全局 width:100% 撑爆）');
ok(/\.cross-group-row[\s\S]{0,80}grid-template-columns:52px/.test(groupsCss), '组行与表头共用五列网格');
ok(/\.cross-tag\.dirty/.test(groupsCss) && /\.cross-tag\.idle/.test(groupsCss), '状态标签有「待保存 / 闲置组」两种样式');

console.log('## 组行：三态人格下拉');
ok(/function crossPersonaOptions\(current, withCurrent\)/.test(crossJs), '三态下拉由一个函数生成（组行与会话行同一套文案）');
ok(/<option value="inherit"/.test(crossJs) && /继承默认人格/.test(crossJs), '第一态：继承默认人格（无记录）');
ok(/<option value="none"/.test(crossJs) && /不使用人格卡/.test(crossJs), '第二态：不使用人格卡（mode:"none"）');
ok(/const value = 'card:' \+ String\(card\.name\)/.test(crossJs) && /人格卡：/.test(crossJs), '第三态：人格库里的每一张卡');
ok(/if \(current\.startsWith\('card:'\) && !matched\)/.test(crossJs), '绑定的卡已从库里消失时下拉仍显示真实值（卡缺失）');
ok(/const record = value === 'inherit' \? null/.test(crossJs), '选「继承」= 删记录，不写一条 inherit');
ok(/const record = value === 'none' \? \{ mode: 'none' \}/.test(crossJs), '选「不用人格」= 一条 mode:"none"');
ok(/data-scope="' \+ esc\(scope\) \+ '"/.test(crossJs), '组行的下拉带 data-scope（key 来自接口）');
ok(/crossGroupIsIdle\(gid\)/.test(crossJs) && /待保存/.test(crossJs) && /已保存/.test(crossJs), '状态列三态：已保存 / 待保存 / 闲置组');
ok(/members\.length \+ ' 条会话/.test(crossJs) && /闲置组（编号保留）/.test(crossJs), '成员列显示「N 条会话」与名单，0 条标闲置组');
ok(/\+ 新增互通组（编号 ' \+ crossNextGid\(\) \+ '）'/.test(crossJs), '新增组按钮上直接写将新增的号');
ok(/function crossNextGid\(\)/.test(crossJs) && /Math\.max\(serverNext > 0 \? serverNext : 1, max \+ 1\)/.test(crossJs), '新增组编号 = 后端 nextGid 与「现有最大 +1」取大（升序、不补空号）');
ok(/function crossIdleClear\(\)/.test(crossJs) && /crossGroupHasBinding\(gid\)/.test(crossJs), '清除闲置绑定只清「有绑定、没成员」的号');
ok(/已把闲置组 ' \+ idle\.join\('、'\)/.test(crossJs) && /编号保留/.test(crossJs), '清除后如实说明「编号保留、可人工指回」');

console.log('## 会话行：编号是下拉框');
ok(/<select class="cross-pick" data-key="' \+ esc\(key\) \+ '"/.test(crossJs), '会话行的编号是 <select data-key>');
ok(/const nums = \[0\]\.concat\(crossGidsEffective\(\)\);/.test(crossJs), '选项 = 0 + 所有生效组号');
ok(/'0（不共享）'/.test(crossJs) && /'组 ' \+ n/.test(crossJs), '选项里 0 写成「0（不共享）」，其余是「组 N」');
ok(/if \(nums\.indexOf\(gid\) < 0\) nums\.push\(gid\);/.test(crossJs), '当前号不在列表里也补进选项（配置被手改时仍能看见真实值）');
ok(/const persona = crossPersona\(scope\);/.test(crossJs) && /sourceLabel/.test(crossJs), '每行给出生效人格与来源');
ok(/aria-label="' \+ esc\(label \+ ' 的互通组编号'\)/.test(crossJs), '下拉带读屏可读的 aria-label');
ok(/\(group \? 'g' : 'p'\)/.test(crossJs) && /\(group \? '群' : '私聊'\)/.test(crossJs), '渠道标签：群 / 私聊，带不同颜色类');
ok(/crossCountText\(conversation\.count\)/.test(crossJs) && /' 条'/.test(crossJs), '每行显示缓冲条数');
ok(/function crossAgo\(lastAt\)/.test(crossJs) && /分钟前/.test(crossJs) && /昨天/.test(crossJs) && /return '—'/.test(crossJs), '最后一条时间：分钟前 / 昨天 / —');
ok(/lastCross\.bufferPerConversation/.test(crossJs), '缓冲上限读 bufferPerConversation');
ok(/lastCross\.enabled === false/.test(crossJs), '互通开关关闭时统计行会标出来');
ok(/esc\(label\)/.test(crossJs) && /esc\(key\)/.test(crossJs), 'label / key 都经过 esc 再进 DOM');
ok(/\.cross-row\.is-shared \{ box-shadow:inset 3px 0 0 var\(--accent\) \}/.test(crossCss), '同组会话有左侧强调线');
ok(/row\.classList\.toggle\('is-shared'/.test(crossJs), '强调线按当前编号实时切换');

console.log('## 会话行：编号 0 可以单独设人格');
// 人格格的分支切片：证明「有组 → 只读 chip」「编号 0 → 可编辑下拉」不是两处各写一半。
const personaStart = crossJs.indexOf('let personaCell;');
const personaEnd = crossJs.indexOf("return '<div class=\"cross-row\"", personaStart);
const personaJs = personaStart > -1 && personaEnd > personaStart ? crossJs.slice(personaStart, personaEnd) : '';
ok(personaJs.length > 0, '人格格由 personaCell 分支生成', `${personaJs.length} 字符`);
ok(/if \(gid > 0\) \{/.test(personaJs), '编号 >0：走只读 chip 分支');
ok(/由互通组 ' \+ gid \+ ' 统一设置（这条会话不能单独改）/.test(personaJs), '编号 >0 的 chip 带 title「由互通组 N 统一设置」');
ok(personaJs.indexOf('data-session') > personaJs.indexOf('统一设置'), 'data-session 下拉只出现在 else（编号 0）分支里');
ok(/class="cross-pick cross-persona" data-session="' \+ esc\(key\)/.test(crossJs), '编号 0 的行给出 data-session 人格下拉');
ok(/crossPersonaOptions\(current, true\)/.test(crossJs), '会话下拉用「继承默认人格（当前：X）」的措辞');
ok(/withCurrent \? '（当前：' \+ esc\(defaultRole\) \+ '）'/.test(crossJs), 'withCurrent 分支拼出「（当前：默认人格）」');
ok(/const scope = 'isolated:' \+ key;/.test(crossJs) && /bindDraft\.set\(scope, record\)/.test(crossJs), '改会话人格写的是 isolated:<会话key> 作用域的草稿');
ok(/function crossSessionPersonaChange\(select\)/.test(crossJs) && /closest\('select\[data-session\]'\)/.test(crossJs), '会话人格下拉有自己的 change 处理（与编号下拉分流）');
ok(/const record = value === 'inherit' \? null/.test(crossJs) && /value === 'none' \? \{ mode: 'none' \}/.test(crossJs), '三态语义与组人格一致（继承=删记录 / none / card）');
ok(/crossBindingText\(record\)\]\.join\('\\u0001'\)/.test(crossJs), '每行生效人格进渲染签名（改卡后下拉会重画，不会停在旧值）');
ok(/function crossParkedIsolatedLines\(\)/.test(crossJs), '「切回 0 会恢复」有专门的计算函数');
ok(/切回 0 时恢复/.test(crossJs), '提示文案写明切回 0 恢复');
ok(/crossParkedIsolatedLines\(\),/.test(crossJs), '预览影响里带上这条提示');
ok(/concat\(notes, parkedLines\)/.test(crossJs), '保存成功的回执里也带上这条提示');
ok(/before === 0 && gid > 0/.test(crossJs), '从 0 挪进组时当场提示「独立人格已保存但不生效」');

console.log('## 读写接口');
ok(/api\('\/api\/socialV2\/cross'\)/.test(crossJs), 'GET /api/socialV2/cross（读会话列表与限额）');
ok(/api\('\/api\/roles\/bindings'\)/.test(crossJs), 'GET /api/roles/bindings（读组总览 / 三态绑定 / 卡清单 / revision）');
ok(/api\('\/api\/roles\/bindings\/plan', 'POST', payload\)/.test(crossJs), '预览影响打 POST /api/roles/bindings/plan（只读）');
ok(/apiWithStatus\('\/api\/roles\/bindings\/apply', 'POST', payload\)/.test(saveJs), '保存打 POST /api/roles/bindings/apply');
ok(/Object\.assign\(\{ baseRevision: String\(lastBind\.revision \|\| ''\) \}, crossPayload\(\)\)/.test(saveJs), 'apply 带 baseRevision（与读取时同一份 revision）');
ok(/function crossPayload\(\) \{\n  return \{ groups: crossGroupsEffective\(\), gids: crossGidsEffective\(\), bindings: crossBindingsBulk\(\) \};/.test(crossJs)
  || /return \{ groups: crossGroupsEffective\(\), gids: crossGidsEffective\(\), bindings: crossBindingsBulk\(\) \};/.test(crossJs), '一次提交 groups + gids + bindings（整块替换）');
ok(!/api\('\/api\/socialV2\/cross', 'POST', payload\)[\s\S]{0,200}groups/.test(saveJs), '保存不再走「先 POST 分组再存人格」的老路（中间态）');
ok(/if \(Object\.keys\(choice\)\.length > 0\) payload\.mergeChoice = choice;/.test(saveJs), '合并冲突的选择作为 mergeChoice 一起提交');
ok(/function crossMergeChoicePayload\(\)/.test(crossJs) && /mergeDraft/.test(crossJs), 'mergeChoice 的值来自冲突面板里用户的选择');
ok(/const conflicts = data && Array\.isArray\(data\.conflicts\) \? data\.conflicts : \[\];/.test(saveJs)
  && /if \(conflicts\.length > 0\)/.test(saveJs), 'apply 返回冲突（409 / 400）时先让用户选最终人格，零修改');
ok(/409 配置已被其他页面修改，请刷新后重试/.test(saveJs), '409（旧 revision）有明确文案');
ok(/本次没有写入，也没有覆盖对方的改动/.test(saveJs) && /crossNotice\.stale = true|stale: true/.test(saveJs), '409 只提示刷新，不自动重试覆盖');
ok(/data-cross-action="reload"/.test(crossJs) && /刷新（丢弃本地草稿，重新读取）/.test(crossJs), '409 给一个显式的「刷新」按钮');
ok(/result\.status === 500/.test(saveJs) && /写盘失败：/.test(saveJs) && /草稿保留在页面上，可以直接重试/.test(saveJs), '500（写盘失败）提示失败 + 草稿保留 + 可重试');
ok(/const applied = data\.applied && typeof data\.applied === 'object'/.test(saveJs) && /旧会话停止中/.test(saveJs), '成功回执分「已保存 / 旧会话停止中 / 下次唤醒用新人格」');
ok(/const payload = \{ recallMaxPerWindow: limits\.max, recallWindowMs: limits\.minutes \* 60000 \};/.test(saveJs), 'qq_recall 限额仍走原来的 POST body');
ok(/api\('\/api\/socialV2\/cross', 'POST', payload\)/.test(saveJs) && !/recallMaxPerWindow[\s\S]{0,120}groups/.test(saveJs), '限额提交只带两个旋钮（分组已由 apply 提交）');
ok(/function paintCrossLimits\(\)/.test(crossJs) && /lastCross\.recallMaxPerWindow/.test(crossJs)
  && /lastCross\.recallWindowMs/.test(crossJs), '限流输入框用桥接返回值回填');
ok(/qq_recall 次数上限要填 0–100 的整数/.test(crossJs) && /限流窗口要填 1–60 分钟/.test(crossJs), '前端先挡住越界值');
ok(/showConsoleToast\('已保存'\)/.test(saveJs), '保存成功 toast「已保存」');
ok(/await refreshCrossBoard\(true\);/.test(saveJs), '保存成功后立即强拉两个来源');
ok(/showConsoleToast\('保存失败：'/.test(saveJs), '保存失败 toast 错误信息');
ok(/未保存变更 ' \+ crossDirtyCount\(\) \+ ' 项'/.test(crossJs), '#crossDirty 显示「未保存变更 N 项」');
ok(/function crossDirtyCount\(\)/.test(crossJs) && /crossDraft\.size \+ bindDraft\.size/.test(crossJs), '脏数把会话编号、组人格、组号增删都算进去');
ok(/将重建 ' \+ rebuild\.length \+ ' 条 \/ 只改绑法 ' \+ rebindOnly\.length \+ ' 条 \/ 卡缺失 ' \+ missing\.length/.test(crossJs), '预览文案：将重建 X 条 / 只改绑法 Y 条 / 卡缺失 Z');
ok(/const CROSS_SAVE_REASONS = \{/.test(crossJs) && /config_write_failed: '写 config\.json 失败，详情见桥接日志'/.test(crossJs), '写盘失败也有人话说明');
ok(/bad_key: '会话 key 不合法'/.test(crossJs) && /bad_gid: '编号必须是非负整数'/.test(crossJs), '400 的 bad_key / bad_gid 各有说明');

console.log('## 人格卡（折叠区）');
ok(/<details class="settings-group" id="crossCardsGroup">/.test(panel), '人格卡是一块折叠区（<details>）');
ok(/<span>名称<\/span><span>字数<\/span><span>内容版本<\/span><span>被哪些组引用<\/span><span>操作<\/span>/.test(panel), '卡片表头：名称 / 字数 / 内容版本 / 被哪些组引用 / 操作');
ok(/data-card-action="view"/.test(crossJs) && /data-card-action="copy"/.test(crossJs)
  && /data-card-action="edit"/.test(crossJs) && /data-card-action="delete"/.test(crossJs), '四类操作：查看 / 复制到组 / 编辑原卡 / 删除');
ok(/409 拒绝删除：卡片「' \+ name \+ '」仍被 /.test(crossJs), '删除被引用的卡给 409 文案');
ok(/refs\.map\(crossPrettyScope\)\.join\('、'\)/.test(crossJs), '409 里列出引用清单（哪个组在用）');
ok(/if \(refs\.length\) \{[\s\S]{0,600}?return;/.test(crossJs), '被引用时直接返回，不发删除请求（不静默换人格）');
ok(/api\('\/api\/roles\/content\?name=' \+ encodeURIComponent\(name\)\)/.test(crossJs), '查看 / 复制前先读原卡内容');
ok(/api\('\/api\/roles\/create', 'POST', \{ name: copyName, content: String\(content\.content \?\? ''\) \}\)/.test(crossJs), '复制到组 = 用 POST /api/roles/create 建副本');
ok(/const copyName = name \+ '-组' \+ gid;/.test(crossJs), '副本命名 <原名>-组N');
ok(/bindings\['cross:' \+ gid\] = \{ mode: 'card', name: copyName \};/.test(crossJs), '复制后原子切换该组绑定（原卡与其它组不变）');
ok(/副本「' \+ copyName \+ '」已经创建好/.test(crossJs), '两步之间失败会如实说明副本可能已创建（不伪造成功）');
ok(/data-card-action="goto-persona"/.test(crossJs) && /openRoleForEdit\(name\)/.test(crossJs), '编辑原卡跳到「人格与角色」页并载入该卡');
ok(/setConsolePage\('persona'\)/.test(crossJs), '编辑原卡真的切到人格页（不是本页假装编辑）');

console.log('## 滑动窗口');
ok(/\.cross-window \{[^}]*max-height:340px/.test(crossCss), '外层容器固定高度 340px');
ok(/\.cross-window \{[^}]*overflow-y:auto/.test(crossCss), '外层容器纵向滚动');
ok(/\.cross-head \{[^}]*position:sticky; top:0/.test(crossCss), '表头 sticky 在窗口顶部');
ok(/grid-template-columns:minmax\(0,1fr\) 112px minmax\(140px,200px\) 62px 88px/.test(crossCss), '表头与行共用五列网格（编号列放得下「0（不共享）」，人格列放得下卡名）');
ok(!/<pre/.test(panel), '面板里没有代码块');

console.log('## 窄屏（≤760px）不再多挤一列');
ok(/"conv conv" "pick persona" "count time"/.test(groupsCss), '会话行两段式：会话一行、编号+人格一行、缓冲+时间一行');
ok(/#section-cross \.cross-persona-cell \{ grid-area:persona \}/.test(groupsCss), '人格格占 persona 区域（跟着编号那行走）');
ok(/#section-cross \.cross-row>\.cross-pick:not\(\.cross-persona\) \{ grid-area:pick \}/.test(groupsCss), '编号下拉与人格下拉分属两格，不互相盖住');
ok(/#section-cross \.cross-time \{ grid-area:time; text-align:right \}/.test(groupsCss), '最后一条仍右对齐（两段式里没丢格）');
ok(/@media \(max-width:760px\) \{/.test(groupsCss), '断点跟页面一致（760px）');

console.log('## 刷新接线');
ok(/if \(currentConsolePage === 'cross'\) refreshCrossBoard\(\);/.test(html), 'refresh() 里按当前视图守着跨渠道页（两个来源一起刷）');
ok(/if \(page === 'cross'\) \{ crossReload\(\); \}/.test(html), '切到这一页先丢弃草稿、画缓存、再强拉一次');
ok(/function paintCross\(\)/.test(crossJs) && /async function refreshCross\(force = false\)/.test(crossJs)
  && /async function refreshBindings\(force = false\)/.test(crossJs) && /function refreshCrossBoard\(force = false\)/.test(crossJs), 'paintCross / refreshCross / refreshBindings / refreshCrossBoard 都定义了');
ok(/if \(!force && crossFetchedAt > 0 && Date\.now\(\) - crossFetchedAt < 5000\)/.test(crossJs)
  && /if \(!force && bindFetchedAt > 0 && Date\.now\(\) - bindFetchedAt < 5000\)/.test(crossJs), '两个来源各自 5 秒节流（3 秒轮询不会每拍都打接口）');
ok(/if \(crossLoading\) \{ if \(force\) crossAgain = true; return; \}/.test(crossJs)
  && /if \(bindLoading\) \{ if \(force\) bindAgain = true; return; \}/.test(crossJs), '并发守卫：保存后的强拉不会被在途请求吞掉');
ok(/showConsoleToast\('跨渠道互通读取失败：' \+ failure\)/.test(crossJs), '会话读取失败弹 toast，不静默吞异常');
ok(/showConsoleToast\('互通组人格读取失败：' \+ failure\)/.test(crossJs), '绑定读取失败也弹 toast');
ok(/if \(failure && failure !== crossErrorShown\)/.test(crossJs) && /if \(failure && failure !== bindErrorShown\)/.test(crossJs), '同一条读错误只弹一次，不刷屏');
ok(/setConsolePage\(location\.hash\.slice\(1\)/.test(html), '首屏仍按 hash 定页（带 #cross 直接打开可用）');

console.log('## 形态与安全');
ok(!/crossJson|JSON\.stringify\((?:lastCross|r)\)/.test(panel) && !panel.includes('crossJson'), '面板里没有 JSON 预览（没有 crossJson 之类）');
ok(!/JSON/.test(panel), '面板文案里不出现 JSON');
ok(!/演示/.test(panel), '面板文案里没有内部术语「演示」');
ok(!/<script[^>]+src=/.test(panel) && !/<link[^>]+href="http/.test(panel), '面板没有引入外部脚本/样式');
ok(!/x-console-token['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html) && !/consoleToken['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html), 'HTML 里没有写死控制台令牌');
ok(/function apiWithStatus\(path, method, body\)/.test(crossJs) && /if \(res\.status === 401\)/.test(crossJs), '需要状态码的调用仍复用同一套令牌 / 401 处理');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }
try { new Function(crossJs); ok(crossJs.length > 0, '跨渠道互通段语法可解析', `${crossJs.length} 字符`); }
catch (e) { ok(false, '跨渠道互通段语法', e.message); }

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
