const KEY = 'autochat.console.token';
const params = new URLSearchParams(location.search);
if (params.get('token')) { localStorage.setItem(KEY, params.get('token')); history.replaceState(null, '', location.pathname); }
const token = localStorage.getItem(KEY) || '';
const main = document.getElementById('main');
const conn = document.getElementById('conn');
const stamp = document.getElementById('stamp');
let page = 'overview', timer = null;

const themeRoot = document.documentElement;
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const saved = localStorage.getItem('autochat.console.theme');
if (saved) themeRoot.setAttribute('data-theme', saved);
const effectiveTheme = () => themeRoot.getAttribute('data-theme') || (mq.matches ? 'dark' : 'light');
document.getElementById('theme').onclick = () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  themeRoot.setAttribute('data-theme', next);
  localStorage.setItem('autochat.console.theme', next);
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = sel => document.querySelector(sel);
const cny = micro => '¥' + (Number(micro || 0) / 1e6).toFixed(4);
const num = n => Number(n || 0).toLocaleString('zh-CN');
const time = value => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
const dur = ms => {
  const s = Math.floor(Number(ms || 0) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}天${h}小时` : h ? `${h}小时${m}分` : `${m}分${s % 60}秒`;
};

// --- 花费与令牌看板的状态与渲染辅助 ---
let costRange = '24h', costSession = '';
window.setRange = value => { costRange = value; costSession = ''; render(); };
window.openSession = value => { costSession = costSession === value ? '' : value; render(); };

const slotLabel = (t, unit) => new Date(Number(t)).toLocaleString('zh-CN', { hour12: false,
  month: '2-digit', day: '2-digit', ...(unit === 'hour' ? { hour: '2-digit' } : {}) });

// 峰谷堆叠柱：高峰在下、空闲在上，纵轴按所选区间的最大值自适应。
function chart(d) {
  const W = 680, H = 190, PAD = 26, INNER = H - PAD * 2;
  const max = Math.max(1, ...d.series.map(p => p.totalMicro));
  const bw = (W - PAD * 2) / d.series.length;
  const bar = Math.max(1, Math.min(bw * 0.74, bw - 1));
  const bars = d.series.map((p, i) => {
    const x = PAD + i * bw + (bw - bar) / 2;
    const peakH = p.peakMicro / max * INNER, offH = p.offMicro / max * INNER;
    const yPeak = H - PAD - peakH;
    const tip = `${slotLabel(p.t, d.unit)}\n花费 ${cny(p.totalMicro)}（高峰 ${cny(p.peakMicro)} · 空闲 ${cny(p.offMicro)}）\ntoken ${num(p.tokens)}，命中 ${num(p.hit)}\n调用 ${num(p.calls)} 次`;
    return `<g><title>${esc(tip)}</title>
      <rect x="${x.toFixed(2)}" y="${yPeak.toFixed(2)}" width="${bar.toFixed(2)}" height="${peakH.toFixed(2)}" fill="var(--accent)"/>
      <rect x="${x.toFixed(2)}" y="${(yPeak - offH).toFixed(2)}" width="${bar.toFixed(2)}" height="${offH.toFixed(2)}" fill="var(--ok)"/>
      <rect x="${x.toFixed(2)}" y="${PAD}" width="${bar.toFixed(2)}" height="${INNER}" fill="transparent"/></g>`;
  }).join('');
  const step = Math.max(1, Math.ceil(d.series.length / 6));
  const labels = d.series.map((p, i) => i % step ? '' :
    `<text x="${(PAD + i * bw + bw / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(slotLabel(p.t, d.unit))}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="花费走势">
    <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--border)"/>
    ${bars}${labels}</svg>`;
}

const segment = r => r.peakMicro && r.offMicro ? '混合' : r.peakMicro ? '高峰' : '空闲';

function turns(d) {
  if (!d.turns.length) return `<div class="section card"><h3>逐轮明细 · <code>${esc(d.session)}</code></h3><div class="empty">该会话没有采样</div></div>`;
  return `<div class="section card"><h3>逐轮明细 · <code>${esc(d.session)}</code>（最近 ${d.turns.length} 轮）</h3>
    <table><thead><tr><th>轮次</th><th>时间</th><th>调用</th><th>入未命中</th><th>入命中</th><th>出</th><th>时段</th><th>花费</th></tr></thead><tbody>
    ${d.turns.map(r => `<tr><td>${num(r.turn)}</td><td class="muted">${time(r.at)}</td><td>${num(r.calls)}</td>
      <td>${num(r.miss)}</td><td>${num(r.hit)}</td><td>${num(r.out)}</td><td>${segment(r)}</td>
      <td>${cny(r.totalMicro)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

async function api(path) {
  const res = await fetch(path, { headers: { 'x-console-token': token } });
  if (res.status === 401) throw new Error('未授权：请用带 ?token= 的地址打开控制台');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// --- 人格管理（Phase 2）---
// 写入一律走请求头令牌 + JSON，且只在「人格」页发起；该页不做自动轮询，
// 避免定时刷新打断正在编辑的文本。
const PERSONA_MSG = {
  PERSONA_NAME_INVALID: '名称不合法：1~40 字，可用中英文、数字、空格、点、短横线、间隔号；不能以点或空格开头/结尾。',
  PERSONA_CONTENT_EMPTY: '内容不能为空。',
  PERSONA_CONTENT_TOO_LARGE: '内容超过 64KB 上限。',
  PERSONA_LIMIT: '人格卡数量已达上限（50 张）。',
  PERSONA_NOT_FOUND: '该人格卡不存在。',
  PERSONA_UNAVAILABLE: '人格模块不可用。',
  header_token_required: '写入必须从控制台页面发起。',
  origin_rejected: '来源校验失败：写入只接受本机回环页面。',
  bad_json: '请求格式错误。',
  BODY_TOO_LARGE: '请求体过大。',
  // 黑话词库（Phase 4）
  SLANG_UNAVAILABLE: '黑话模块不可用。',
  SLANG_PARAM_INVALID: '参数不合法。',
  SLANG_NOT_FOUND: '该词条已不存在，可能已被删除。',
  SLANG_DISABLED: '黑话功能未开启：先在「黑话」页打开开关。',
  SLANG_BUDGET_BLOCKED: '今日模型预算不足，抽取或查义未执行。',
  SLANG_SEARCH_DISABLED: '联网搜索未启用（WEB_SEARCH_ENABLED）。',
  SLANG_SEARCH_LIMIT: '今日联网搜索次数已用完，明日恢复。',
  SLANG_IMPORT_INVALID: '备份文件不是合法 JSON，未导入任何词条（原文已另存到 runtime/ 供检查）。',
  SLANG_MODEL_FAILED: '模型调用失败，此次费用预留暂不释放。',
  SLANG_EXTRACT_UNPARSABLE: '模型没有返回可解析的 JSON 数组，本次未写入任何词条（避免把解释文字当成"没找到"）。',
  SLANG_LOOKUP_UNVERIFIED: '没有拿到可核查的搜索来源，含义未写入。',
  SLANG_LOOKUP_EMPTY: '搜索结果为空，含义未写入。',
  // 表情包库（Phase 6）
  STICKER_UNAVAILABLE: '表情包模块不可用。',
  STICKER_PARAM_INVALID: '参数不合法。',
  STICKER_NOT_FOUND: '该图片已不存在，可能已被删除。',
  STICKER_UPLOAD_INVALID: '上传失败：仅支持 PNG/JPG/GIF/WebP，每张最多 5MB。',
  // 运行时设置（V2）
  CONFIG_PARAM_INVALID: '参数不合法或超出范围。',
};
const explain = code => PERSONA_MSG[code] || code || '操作失败';

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-console-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

const personaState = { ready: false, file: { kind: 'card', name: '', content: '', exists: false }, notice: '', bad: false };
const setNotice = (text, bad = false) => { personaState.notice = text; personaState.bad = bad; };

// 合并同一次 API 调用的两种失败来源：HTTP 层与错误码。
const reason = error => explain(String(error?.message ?? error).replace(/^HTTP \d+$/, ''));

window.pfEdit = async (kind, name) => {
  try {
    const d = await api(`/api/personas/file?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name || '')}`);
    personaState.file = { kind: d.kind, name: d.name, content: d.content, exists: d.exists };
    setNotice(d.exists ? `已载入 ${d.name}` : '新人格卡，填写名称后保存。');
  } catch (error) { setNotice(reason(error), true); }
  render();
};
window.pfNew = () => {
  personaState.file = { kind: 'card', name: '', content: '', exists: false };
  setNotice('新建人格卡：填写名称与内容后点保存。');
  render();
};
window.pfName = value => { personaState.file.name = value; };
window.pfContent = value => { personaState.file.content = value; };
window.pfSave = async () => {
  const { kind, name, content } = personaState.file;
  try {
    const d = await post('/api/personas/file', { kind, name, content });
    if (kind === 'behavior') {
      setNotice(`行为层已保存（${d.bytes} 字节）。重启后生效。`);
    } else {
      personaState.file.exists = true;
      setNotice(`已保存人格卡「${d.saved.name}」（${d.saved.bytes} 字节）。下一条消息起生效。`);
    }
  } catch (error) { setNotice(reason(error), true); }
  render();
};
window.pfDelete = async name => {
  if (!window.confirm(`删除人格卡「${name}」？该操作不可撤销。`)) return;
  try {
    await post('/api/personas/delete', { name });
    if (personaState.file.name === name) personaState.file = { kind: 'card', name: '', content: '', exists: false };
    setNotice(`已删除「${name}」。`);
  } catch (error) { setNotice(reason(error), true); }
  render();
};
window.pfActivate = async name => {
  try {
    await post('/api/personas/active', { name: name ?? '' });
    setNotice(name ? `已启用「${name}」，下一条消息起生效。` : '已恢复内置默认人设。');
  } catch (error) { setNotice(reason(error), true); }
  render();
};

const SOURCE_LABEL = { env: 'SYSTEM_PROMPT（.env）', card: '人格卡', builtin: '内置默认' };

// --- 拟人化群友仿真（Phase 3）---
const SIM_LABEL = { observing: '观望', probing: '试探', active: '活跃', retreating: '退场' };
const REASON_LABEL = {
  addressed_by_core: '被点名，交给问答路径回复',
  scored: '相关度达标，主动接话',
  below_threshold: '相关度不足，保持沉默',
  disabled: '模型回复已停止', group_off: '群回复已关闭', muted: '该群已静音',
  image: '图片消息（由问答路径处理）', empty: '空消息', blocked: '命中屏蔽词',
  daily_limit: '已达当日主动发言上限', cooldown: '冷却中', budget: '预算不足',
};
const socialNotice = { text: '', bad: false };
const socialParams = d => ({
  threshold: d.params.threshold, cooldownSeconds: d.params.cooldownSeconds, dailyLimit: d.params.dailyLimit,
});
window.socialSet = async patch => {
  try {
    await post('/api/social/config', patch);
    socialNotice.text = '已保存，立即生效。'; socialNotice.bad = false;
  } catch (error) { socialNotice.text = reason(error); socialNotice.bad = true; }
  render();
};
window.socialToggle = () => socialSet({ enabled: !($('#sim-switch').dataset.on === '1') });
window.socialSave = () => socialSet({
  threshold: Number($('#sim-threshold').value),
  cooldownSeconds: Number($('#sim-cooldown').value),
  dailyLimit: Number($('#sim-daily').value),
  idleEnabled: $('#sim-idle').checked,
  idleMinutes: Number($('#sim-idle-minutes').value),
  idleHours: $('#sim-idle-hours').value.trim(),
});

// --- 黑话词库（Phase 4）---
// 「抽取候选」和「联网查义」都会真的花钱，所以两者都只由按钮触发，不会自动发生。
// 候选必须人工点「确认」才会进入群聊提示词——这是这个词库唯一的安全闸门。
const SLANG_STATUS = { candidate: '待确认', confirmed: '已确认', rejected: '已拒绝' };
const slangState = { filter: 'all', enabled: false, entry: null, notice: '', bad: false, patch: {} };
const slangSet = (text, bad = false) => { slangState.notice = text; slangState.bad = bad; };

window.slangToggle = async () => {
  try {
    await post('/api/slang/config', { enabled: !slangState.enabled });
    slangSet(slangState.enabled ? '已关闭：群聊提示词不再注入黑话表。' : '已开启。抽取与注入均已生效。');
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangFilterSet = value => { slangState.filter = value; render(); };
window.slangExtract = async group => {
  slangSet('正在抽取…需要调用一次模型，请稍候。');
  render();
  try {
    const d = await post('/api/slang/extract', { group });
    const r = d.result;
    slangSet(`扫描 ${r.scanned} 条消息，得到 ${r.candidates} 个候选（新增 ${r.created}、更新 ${r.updated}${r.dropped ? `、丢弃 ${r.dropped}` : ''}）。新增的词条需要你点「确认」才会生效。`);
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangStatus = async (id, status) => {
  try {
    await post('/api/slang/status', { id, status });
    slangSet(status === 'confirmed' ? '已确认：下一条群消息起就会带上这个词。' : status === 'rejected' ? '已拒绝：不会注入，也不会再被重复抽取覆盖。' : '已退回待确认。');
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangOpen = async id => {
  try {
    const d = await api(`/api/slang/entry?id=${encodeURIComponent(id)}`);
    slangState.entry = d.entry; slangState.patch = {};
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangClose = () => { slangState.entry = null; slangState.patch = {}; render(); };
window.slangEdit = (id, field, value) => { (slangState.patch[id] ||= {})[field] = value; };
window.slangScopeSave = async id => {
  const boxes = [...document.querySelectorAll('[data-scope-group]')];
  const groups = boxes.filter(b => b.checked).map(b => b.dataset.scopeGroup);
  try {
    await post('/api/slang/scopes', { id, groups });
    slangSet('已保存词条的生效群。');
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangSave = async id => {
  const patch = slangState.patch[id] || {};
  if (!Object.keys(patch).length) { slangSet('没有改动。'); render(); return; }
  try {
    await post('/api/slang/entry', { id, ...patch });
    delete slangState.patch[id];
    slangSet('含义已保存。确认状态不变——要注入仍需点「确认」。');
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangDelete = async (id, term) => {
  if (!window.confirm(`删除词条「${term}」？该操作不可撤销；建议先导出备份。`)) return;
  try {
    await post('/api/slang/delete', { id });
    if (slangState.entry?.id === id) slangState.entry = null;
    slangSet(`已删除「${term}」。`);
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangLookup = async id => {
  slangSet('正在联网查义…会消耗一次搜索额度与模型预算。');
  render();
  try {
    const d = await post('/api/slang/lookup', { id });
    slangSet(`已写入搜索得到的含义（来源 ${d.sources.length} 条）。仍需人工确认。`);
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangExport = async () => {
  try {
    const d = await api('/api/slang/export');
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `autochat-slang-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    slangSet(`已导出 ${d.entries.length} 条词条。`);
  } catch (error) { slangSet(reason(error), true); }
  render();
};
window.slangImportFile = async input => {
  const file = input?.files?.[0];
  if (!file) return;
  if (!window.confirm(`用「${file.name}」恢复？已存在的词条会保留本地的人工确认状态，只合并出现次数。`)) { input.value = ''; return; }
  try {
    const d = await post('/api/slang/import', { text: await file.text() });
    slangSet(`恢复完成：新增 ${d.added} 条、合并 ${d.merged} 条${d.trimmed ? `，并因超出容量裁剪 ${d.trimmed} 条` : ''}。`);
  } catch (error) { slangSet(reason(error), true); }
  input.value = '';
  render();
};

// --- 按群特异化 ---
// 群设置页只按动作保存，不自动轮询：下拉与输入框会因定时刷新而重置。
const groupState = { notice: '', bad: false };
const groupSet = (text, bad = false) => { groupState.notice = text; groupState.bad = bad; };
window.groupPersona = async (group, value) => {
  try {
    await post('/api/groups/config', { group, subsystem: 'persona', name: value === '__inherit__' ? null : value });
    groupSet('已保存人格选择。');
  } catch (error) { groupSet(reason(error), true); }
  render();
};
window.groupSocialToggle = async (group, enabled) => {
  try { await post('/api/groups/config', { group, subsystem: 'social', enabled }); groupSet('已保存仿真开关。'); }
  catch (error) { groupSet(reason(error), true); }
  render();
};
window.groupSocialSave = async group => {
  try {
    await post('/api/groups/config', { group, subsystem: 'social',
      threshold: Number($('#g-threshold-' + group).value),
      cooldownSeconds: Number($('#g-cooldown-' + group).value),
      dailyLimit: Number($('#g-daily-' + group).value),
    });
    groupSet('已保存仿真参数。');
  } catch (error) { groupSet(reason(error), true); }
  render();
};
window.groupSocialInherit = async (group, field) => {
  try { await post('/api/groups/config', { group, subsystem: 'social', [field]: null }); groupSet('已恢复继承全局。'); }
  catch (error) { groupSet(reason(error), true); }
  render();
};
window.groupSlangToggle = async (group, enabled) => {
  try { await post('/api/groups/config', { group, subsystem: 'slang', enabled }); groupSet('已保存黑话开关。'); }
  catch (error) { groupSet(reason(error), true); }
  render();
};
window.groupReset = async group => {
  if (!window.confirm(`恢复群 ${group} 的人格 / 仿真 / 黑话覆盖为「继承全局」？`)) return;
  try { await post('/api/groups/config', { group, subsystem: 'reset' }); groupSet('已恢复该群默认。'); }
  catch (error) { groupSet(reason(error), true); }
  render();
};


async function render() {
  try { main.innerHTML = await pages[page](); }
  catch (error) { main.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
}
function schedule() {
  clearInterval(timer);
  // 人格页与仿真/黑话/群设置/表情包/设置页保存着可编辑字段，轮询会覆盖输入：这几页只在动作或手动刷新时重绘。
  if (page === 'personas' || page === 'social' || page === 'slang' || page === 'groups' || page === 'stickers' || page === 'settings') return;
  timer = setInterval(() => { if (!document.hidden) render(); }, 3000);
}
document.querySelectorAll('nav a').forEach(link => {
  link.onclick = () => {
    document.querySelectorAll('nav a').forEach(x => x.classList.remove('active'));
    link.classList.add('active'); page = link.dataset.page; render(); schedule();
  };
});
document.getElementById('refresh').onclick = render;
if (!token) main.innerHTML = '<div class="error">缺少访问令牌。请使用启动日志中带 ?token= 的地址打开控制台。</div>';
else { render(); schedule(); }

