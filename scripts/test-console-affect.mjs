// 情绪面板（T-012）的静态校验：不能跑 Playwright 的环境里，用它守住真正会摔人的那几处契约。
//
// 这个文件只读 public/console.html 的文本，不起服务、不发请求。它管的是「接线有没有接错」：
//   - 视图契约：侧栏有 data-view="affect"，页面有 data-page="affect" 的 section，两边各一份；
//   - 接口契约：四个端点的路径拼写（/affect、/affect/vent、/affect/config、/affect/events）；
//   - 安全契约：「真的发一次」必须带二次确认，而且全页只有这一处写 dryRun:false
//     —— 别的地方多出一个 dryRun:false，等于多点一下就往 QQ 空间发一条；
//   - 展示契约：四种情绪、阈值刻度、决策步骤、三个出口的额度都有落点；
//   - 令牌契约：HTML 里不许出现写死的控制台令牌。
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

// 面板本体：从 section 开头切到 </main>。它内部嵌了一个 .af-debug 子 section，
// 所以不能按「第一个 </section>」切，否则正好切掉在调试区前的两张表。
const sectionStart = html.indexOf('<section id="section-affect"');
const sectionEnd = html.indexOf('</main>', sectionStart);
const panel = sectionStart > -1 && sectionEnd > sectionStart ? html.slice(sectionStart, sectionEnd) : '';

console.log('## 视图与导航');
ok(sectionStart > -1, '存在 section#section-affect', panel ? `${panel.length} 字符` : '切片为空');
ok(/<section id="section-affect" data-page="affect" class="card span-all">/.test(html), 'section 带 data-page="affect" 且整行铺满');
ok((html.match(/data-view="affect"/g) ?? []).length === 1, '侧栏只有一个 data-view="affect"');
const slangAt = html.indexOf('data-view="slang"');
const affectAt = html.indexOf('data-view="affect"');
const manageAt = html.indexOf('<div class="nav-label">管理</div>');
ok(slangAt > -1 && affectAt > slangAt && manageAt > affectAt, '「情绪」排在「黑话词库」之后、管理分组之前');
ok(/data-view="affect" class="nav-item"><span class="nav-icon" aria-hidden="true">.+<\/span>情绪<\/button>/.test(html), '导航按钮沿用 nav-item / nav-icon 结构');
ok(/\n  affect: \['情绪'/.test(html), 'consolePages 里有 affect 的标题与描述');
ok(/document\.getElementById\('breadcrumbPage'\)\.textContent = consolePages\[page\]\[0\]/.test(html), '面包屑/标题仍走 consolePages（新页自动有标题）');

console.log('## 四个端点');
ok(/api\('\/api\/socialV2\/affect'\)/.test(html), 'GET /api/socialV2/affect（读快照）');
ok(/api\('\/api\/socialV2\/affect\/vent', 'POST', \{ dryRun: true \}\)/.test(html), 'POST /affect/vent 评估（dryRun:true）');
ok(/api\('\/api\/socialV2\/affect\/vent', 'POST', \{ dryRun: false \}\)/.test(html), 'POST /affect/vent 真发（dryRun:false）');
ok(/api\('\/api\/socialV2\/affect\/config', 'POST'/.test(html), 'POST /affect/config（阈值与限额）');
ok(/api\('\/api\/socialV2\/affect\/events', 'POST'/.test(html), 'POST /affect/events（手动加情绪）');
ok(/events: \[\{ kind, step, confidence: 0\.8, causeSummary: cause, source: 'console' \}\]/.test(html), 'events 按桥接要求包成数组（单条也包一层）');

console.log('## 「真的发一次」的安全边界');
const realStart = html.indexOf('async function affectRealVent(');
const realEnd = html.indexOf('async function affectAddEvent(', realStart);
const realSlice = realStart > -1 && realEnd > realStart ? html.slice(realStart, realEnd) : '';
ok(realSlice.length > 0, '真的发一次是独立处理函数', `${realSlice.length} 字符`);
ok(realSlice.includes('confirm('), '处理函数里有 confirm( 二次确认');
ok(/真的发一条说说？/.test(realSlice), '确认文案说清了后果（发到 QQ 空间 / 占额度 / 进冷却）');
ok(/id="afRealVent" class="danger small"/.test(html), '按钮用红色（danger）');
const falseHits = [...html.matchAll(/dryRun: false/g)].map((m) => m.index);
ok(falseHits.length === 1, '全页只有一处 dryRun:false', `${falseHits.length} 处`);
ok(falseHits.length === 1 && falseHits[0] >= realStart && falseHits[0] < realEnd, '那唯一一处就在真的发一次的处理函数里');
ok(!/dryRun: false/.test(html.slice(0, realStart)), '真的发一次之前没有任何 dryRun:false');
ok(/dryRun: false/.test(realSlice), '真发请求体里写的是 dryRun:false');

console.log('## 四条强度条与阈值刻度');
for (const [key, label] of [['Anger', '生气'], ['Sadness', '难过'], ['Joy', '开心'], ['Boredom', '无聊']]) {
  ok(panel.includes(`id="afRow${key}"`) && panel.includes(`id="afFill${key}"`) && panel.includes(`id="afTick${key}"`), `${label} 有行/填充/刻度线`);
  ok(new RegExp(`<span class="af-name">${label}</span>`).test(panel), `${label} 标签写在 HTML 里（不是只靠 JS 现拼）`);
}
ok((panel.match(/class="af-fill"/g) ?? []).length === 4, '四条填充');
ok((panel.match(/class="af-th"/g) ?? []).length === 4, '四条阈值刻度线（绝对定位竖线）');
ok((panel.match(/class="af-th-label"/g) ?? []).length === 4, '每根刻度线都有小字');
ok(/tickLabel\.textContent = '阈值 ' \+ threshold\.toFixed\(2\);/.test(html), '刻度小字按阈值现算成「阈值 0.70」');
ok(/tick\.style\.left = left;/.test(html) && /tickLabel\.style\.left = left;/.test(html), '刻度位置按阈值百分比现算');
ok(/row\.classList\.toggle\('is-over'/.test(html), '超过阈值整行切告警态');
ok(/\.af-row\.is-over \.af-fill \{ background:var\(--warn-fg-strong\) \}/.test(html), '越线用告警色');
ok(/val\.textContent = intensity === null \? '—' : intensity\.toFixed\(2\);/.test(html), '右侧显示当前强度');
ok(/剂量 /.test(html) && /doseMin/.test(html), '条形下面显示剂量与剂量下限');

console.log('## 摘要 / 决策理由 / 额度');
ok(/id="afEnabledBadge"/.test(panel) && /id="afDominantBadge"/.test(panel) && /id="afVerdictBadge"/.test(panel), '摘要三个徽标都在');
ok(/id="afVerdictText"/.test(panel) && /为什么现在不发/.test(html), 'canVent 结论翻成人话');
ok(/canVent\.ok === true|item\.ok === true|data\.canVent/.test(html), '结论读自接口 canVent');
ok(/id="afLastVent"/.test(panel) && /最近一次宣泄/.test(html), '最近一次宣泄时间');
ok(/id="afCapQzone"/.test(panel) && /id="afCapPrivate"/.test(panel) && /id="afCapDiary"/.test(panel), '三个出口的额度各有落点');
ok(/dailyCap\.qzone/.test(html) && /dailyCap\.private/.test(html) && /dailyCap\.diary/.test(html), '额度分母读 config.dailyCap');
ok(/qzoneRemaining/.test(html), '说说剩余条数读 caps.qzoneRemaining');
ok(/id="afPlan"/.test(panel), '决策理由列表有容器');
ok(/affectPlanHtml/.test(html) && /text\.startsWith\('✓'\)/.test(html), 'plan 按 ✓/✗ 分色渲染');
ok(/function affectPlanHtml\(plan\)/.test(html) && /text\.replace\(\/\^\[✓✗\]\\s\*\/, ''\)/.test(html), '每一行渲染成「✓ 步骤：说明」');
ok(/id="afEventBody"/.test(panel) && /id="afEventTable"/.test(panel), '最近事件表');
ok(/<th>时间<\/th><th>情绪<\/th><th>档位<\/th><th>原因<\/th><th>来源<\/th>/.test(panel), '事件表五列：时间/情绪/档位/原因/来源');
ok(/id="afVentBody"/.test(panel) && /id="afVentTable"/.test(panel), '最近宣泄表');
ok(/<th>时间<\/th><th>出口<\/th><th>情绪<\/th><th>文案<\/th><th>结果<\/th>/.test(panel), '宣泄表五列：时间/出口/情绪/文案/结果');

console.log('## 调试区四件事');
ok(/id="afDryRun"/.test(panel) && /评估一次（不发）/.test(panel), '① 评估一次（不发）');
ok(/id="afRealVent"/.test(panel) && /真的发一次/.test(panel), '② 真的发一次');
ok(/id="afEventKind"/.test(panel) && /id="afEventStep"/.test(panel) && /id="afEventCause"/.test(panel) && /id="afEventAdd"/.test(panel), '③ 手动加一次情绪：情绪 + 档位 + 原因 + 按钮');
ok((panel.match(/<option value="0\.25">/) ?? []).length === 1 && /<option value="0\.5" selected>/.test(panel) && /<option value="0\.75">/.test(panel) && /<option value="1">/.test(panel), '档位是 0.25 / 0.5 / 0.75 / 1');
ok(/maxlength="60"/.test(panel), '原因框限 60 字');
ok(/id="afThAnger"/.test(panel) && /id="afThSadness"/.test(panel) && /id="afThJoy"/.test(panel) && /id="afThBoredom"/.test(panel), '④ 四个阈值输入');
ok(/id="afDailyQzone"/.test(panel) && /id="afDailyPrivate"/.test(panel) && /id="afDailyDiary"/.test(panel), '④ 三个日配额输入');
ok(/id="afMinInterval"/.test(panel) && /最小间隔（分钟）/.test(panel), '④ 全局最小间隔');
ok(/id="afQuietToggle"/.test(panel) && /id="afQuietStart"/.test(panel) && /id="afQuietEnd"/.test(panel), '④ 静默开关与起止时间');
ok(/id="afSaveConfig"/.test(panel) && /保存阈值与限额/.test(panel), '④ 保存按钮');
ok(/minIntervalMs: Math\.round\(minutes \* 60000\)/.test(html), '分钟换算成毫秒再提交');
ok(/quietHours: \{/.test(html) && /enabled: quietToggle \? quietToggle\.checked === true : false/.test(html), '静默时段按桥接的形状提交');
ok(/if \(r\.affect\) renderAffectParams\(r\.affect\);/.test(html), '保存后用响应里的完整配置回填');
ok(/await refreshAffect\(true\);/.test(html), '保存/真发之后立即重拉一次');
ok(/affectVentResultHtml/.test(html) && /闸门数据/.test(html), '评估结果展示 plan / 文案 / 来源 / 闸门');

console.log('## 每种拒因都有一句人话');
for (const reason of ['disabled', 'below_threshold', 'below_dose', 'cooldown', 'daily_cap', 'min_interval', 'quiet_hours', 'qzone_unconfigured']) {
  ok(new RegExp(`\\b${reason}: '[^']{6,}'`).test(html), `原因 ${reason} 有中文说明`);
}
ok(/text_rejected/.test(html) && /send_failed/.test(html) && /channel_not_ready/.test(html), '发送侧失败原因也有说明');
ok(/是「' \+ reason \+ '」/.test(html) || /这一版面板还不认识/.test(html), '没见过的原因会显示原文，不静默留白');

console.log('## 刷新接线');
ok(/if \(currentConsolePage === 'affect'\) refreshAffect\(\);/.test(html), 'refresh() 里按当前视图守着情绪页');
ok(/if \(page === 'affect'\) \{[^}]*paintAffect\(\); refreshAffect\(true\); \}/.test(html), '切到这一页先画缓存再强拉一次');
ok(/function paintAffect\(\)/.test(html) && /async function refreshAffect\(force = false\)/.test(html), 'paintAffect / refreshAffect 都定义了');
ok(/setConsolePage\(location\.hash\.slice\(1\)/.test(html), '首屏仍按 hash 定页（带 #affect 直接打开可用）');

console.log('## 令牌与依赖');
ok(!/x-console-token['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html), 'HTML 里没有写死 x-console-token');
ok(!/consoleToken['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{12,}/.test(html), 'HTML 里没有写死 consoleToken');
ok(/const token = localStorage\.getItem\('consoleToken'\);/.test(html), '令牌仍从 localStorage 取');
ok(!/<script[^>]+src=/.test(panel) && !/<link[^>]+href="http/.test(panel), '面板没有引入外部脚本/样式');
ok(!/演示/.test(panel), '面板文案里没有内部术语「演示」');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
