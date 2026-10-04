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
});

const pages = {
  async overview() {
    const d = await api('/api/summary');
    conn.textContent = d.connection.ready ? '已连接' : '未连接';
    conn.className = 'pill ' + (d.connection.ready ? 'ok' : 'bad');
    stamp.textContent = new Date(d.generatedAt).toLocaleTimeString('zh-CN', { hour12: false });
    const b = d.budget, usedPct = b.limitMicro ? Math.min(100, (b.usedMicro + b.heldMicro) / b.limitMicro * 100) : 0;
    return `
      <div class="section grid">
        <div class="card"><h3>今日已用</h3><div class="metric">${cny(b.usedMicro)}<small>/ ${cny(b.limitMicro)}</small></div>
          <div class="bar" style="margin-top:10px"><span style="width:${usedPct.toFixed(1)}%"></span></div></div>
        <div class="card"><h3>预留中</h3><div class="metric">${cny(b.heldMicro)}</div></div>
        <div class="card"><h3>剩余</h3><div class="metric">${cny(b.remainingMicro)}</div></div>
        <div class="card"><h3>队列深度</h3><div class="metric">${d.queue.depth}<small>条</small></div></div>
      </div>
      <div class="section card">
        <h3>运行状态</h3>
        <dl class="kv">
          <dt>运行时长</dt><dd>${dur(d.uptimeMs)}</dd>
          <dt>模型</dt><dd>${esc(d.model.active)}（${esc(d.model.name)}）</dd>
          <dt>回复</dt><dd>${d.switches.enabled ? '启用' : '停止'}　群回复：${d.switches.groupEnabled ? '启用' : '关闭'}</dd>
          <dt>联网搜索</dt><dd>${d.switches.webSearch ? '启用' : '关闭'}　图片识别：${d.switches.vision ? '启用' : '关闭'}</dd>
          <dt>防刷屏</dt><dd>${d.switches.antiSpam ? '启用' : '关闭'}　群管理：${d.switches.groupManagement ? '启用' : '关闭'}</dd>
          <dt>账期</dt><dd>${esc(b.day)}（香港时间）</dd>
          <dt>发送失败计数</dt><dd>${d.queue.sendFailures}</dd>
        </dl>
      </div>
      <div class="section card">
        <h3>参与者</h3>
        ${d.participants.length ? `<table><thead><tr><th>名称</th><th>异常次数</th><th>最近错误</th></tr></thead><tbody>
          ${d.participants.map(p => `<tr><td>${esc(p.name)}</td><td>${p.failures}</td><td class="muted">${esc(p.lastError || '—')}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">无</div>'}
      </div>
      <div class="section card">
        <h3>群与清理时间</h3>
        ${d.groups.length ? `<table><thead><tr><th>群号</th><th>下次清理</th></tr></thead><tbody>
          ${d.groups.map(g => `<tr><td>${esc(g.id)}</td><td>${time(g.due)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">未配置群</div>'}
      </div>`;
  },
  async sessions() {
    const d = await api('/api/sessions');
    stamp.textContent = `${d.sessions.length} 个会话`;
    if (!d.sessions.length) return '<div class="empty">暂无会话</div>';
    return `<div class="card"><table><thead><tr><th>会话键</th><th>范围</th><th>条数</th><th>最后更新</th></tr></thead><tbody>
      ${d.sessions.map(s => `<tr><td><code>${esc(s.key)}</code></td><td class="muted">${esc(s.scope)}</td>
        <td>${num(s.items)}</td><td class="muted">${time(s.updated)}</td></tr>`).join('')}
    </tbody></table></div>`;
  },
  async cost() {
    const [d, daily] = await Promise.all([api('/api/cost?range=' + costRange), api('/api/charges?days=30')]);
    stamp.textContent = `区间 ${d.range} · ${d.series.length} 桶`;
    const t = d.totals;
    const pct = rate => rate === null ? '—' : (rate * 100).toFixed(1) + '%';
    const rangeButtons = d.ranges.map(r =>
      `<button onclick="setRange('${esc(r)}')" class="${r === d.range ? 'on' : ''}">${esc(r)}</button>`).join('');
    const drill = costSession
      ? await api('/api/cost/turns?limit=60&session=' + encodeURIComponent(costSession))
      : null;
    const price = d.pricing;
    return `
      <div class="section card" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-size:13px">时间范围</strong><span class="seg">${rangeButtons}</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size:12px">单价（元/百万）：入未命中 ${esc(price.inputPrice ?? '—')} · 入命中 ${esc(price.cacheHitPrice ?? '按默认 1/50')} · 出 ${esc(price.outputPrice ?? '—')} · 空闲 ${(Number(price.offPeakRatio) * 100).toFixed(0)}%</span>
      </div>
      <div class="section grid">
        <div class="card"><h3>区间花费</h3><div class="metric">${cny(t.totalMicro)}</div>
          <div class="muted" style="font-size:12px">高峰 ${cny(t.peakMicro)} · 空闲 ${cny(t.offMicro)}</div></div>
        <div class="card"><h3>累计 token</h3><div class="metric">${num(t.tokens)}</div>
          <div class="muted" style="font-size:12px">入未命中 ${num(t.miss)} · 入命中 ${num(t.hit)} · 出 ${num(t.out)}</div></div>
        <div class="card"><h3>缓存命中率</h3><div class="metric">${pct(t.hitRate)}</div>
          <div class="muted" style="font-size:12px">命中 ${num(t.hit)} / 输入 ${num(t.miss + t.hit)}</div></div>
        <div class="card"><h3>平均每轮</h3><div class="metric">${cny(t.avgTurnMicro)}</div>
          <div class="muted" style="font-size:12px">${num(t.turns)} 轮 · ${num(t.calls)} 次调用 · 每次 ${cny(t.avgCallMicro)}</div></div>
      </div>
      <div class="section card">
        <h3>花费走势（每${d.unit === 'hour' ? '小时' : '天'}）</h3>
        <div class="legend"><span><i class="swatch" style="background:var(--accent)"></i>高峰</span>
          <span><i class="swatch" style="background:var(--ok)"></i>空闲</span>
          <span>纵轴按区间峰值自适应；条形悬停可看明细</span></div>
        ${chart(d)}
      </div>
      <div class="section card">
        <h3>按会话</h3>
        ${d.sessions.length ? `<table><thead><tr><th>会话</th><th>轮数</th><th>调用</th><th>入未命中</th><th>入命中</th><th>出</th><th>命中率</th><th>花费</th><th>最后</th></tr></thead><tbody>
          ${d.sessions.map(s => `<tr class="click ${s.session === costSession ? 'sel' : ''}" onclick="openSession(${esc(JSON.stringify(s.session))})">
            <td><code>${esc(s.session)}</code></td><td>${num(s.turns)}</td><td>${num(s.calls)}</td>
            <td>${num(s.miss)}</td><td>${num(s.hit)}</td><td>${num(s.out)}</td>
            <td>${pct(s.hitRate)}</td><td>${cny(s.totalMicro)}</td><td class="muted">${time(s.last)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">所选区间内没有采样</div>'}
      </div>
      ${drill ? turns(drill) : '<div class="section card muted" style="font-size:12px">点击任意会话行可下钻到逐轮明细。</div>'}
      <div class="section card">
        <h3>最近采样</h3>
        ${d.recent.length ? `<table><thead><tr><th>时间</th><th>会话</th><th>轮/序</th><th>时段</th><th>入未命中</th><th>入命中</th><th>出</th><th>花费</th></tr></thead><tbody>
          ${d.recent.map(r => `<tr><td class="muted">${time(r.at)}</td><td><code>${esc(r.session)}</code></td>
            <td>${num(r.turn)} / ${num(r.seq)}</td><td>${r.bucket === 'peak' ? '高峰' : '空闲'}</td>
            <td>${num(r.miss)}</td><td>${num(r.hit)}</td><td>${num(r.out)}</td><td>${cny(r.costMicro)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">还没有采样。开启机器人与模型对话后这里会出现逐次记录。</div>'}
      </div>
      <div class="section card">
        <h3>按账期（预算账本：预留与结算）</h3>
        ${daily.days.length ? `<table><thead><tr><th>账期</th><th>已结算</th><th>预留中</th><th>调用数</th></tr></thead><tbody>
          ${daily.days.map(r => `<tr><td>${esc(r.day)}</td><td>${cny(r.used)}</td>
            <td>${cny(r.held)}</td><td>${num(r.calls)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">暂无记账</div>'}
      </div>`;
  },
  async personas() {
    const d = await api('/api/personas');
    if (!d.available) return '<div class="empty">人格模块不可用。</div>';
    if (!personaState.ready) {
      personaState.ready = true;
      const pick = d.active && d.characters.some(c => c.name === d.active) ? d.active : (d.characters[0]?.name ?? '');
      if (pick) {
        try {
          const file = await api(`/api/personas/file?kind=card&name=${encodeURIComponent(pick)}`);
          personaState.file = { kind: 'card', name: file.name, content: file.content, exists: file.exists };
        } catch { /* 编辑器留空，用户可手动打开 */ }
      }
    }
    stamp.textContent = `${d.characters.length} 张人格卡`;
    const f = personaState.file;
    const banners = [];
    if (d.override) banners.push(`<div class="banner warn"><strong>SYSTEM_PROMPT 已在 .env 中设置</strong>，它优先级最高：人格卡的改动不会生效。清空该字段并重启后才会使用人格卡。</div>`);
    if (personaState.notice) banners.push(`<div class="banner ${personaState.bad ? 'bad' : 'ok'}">${esc(personaState.notice)}</div>`);
    const limit = d.limits;
    return `${banners.join('')}
      <div class="section grid">
        <div class="card"><h3>当前生效来源</h3><div class="metric" style="font-size:18px">${esc(SOURCE_LABEL[d.source] || d.source)}</div>
          <div class="muted" style="font-size:12px">${d.source === 'card' ? `人格卡「${esc(d.active)}」` : d.source === 'env' ? '最高优先级覆盖' : 'src/persona.js'}</div></div>
        <div class="card"><h3>启用的人格卡</h3><div class="metric" style="font-size:18px">${d.active ? esc(d.active) : '（内置默认）'}</div>
          <div class="muted" style="font-size:12px">${d.active && !d.activeExists ? '<span class="bad-text">文件已不存在，实际回退到内置默认</span>' : '私聊与群聊共用'}</div></div>
        <div class="card"><h3>合成提示词</h3><div class="metric">${num(d.resolved.bytes)}<small>字节</small></div>
          <div class="muted" style="font-size:12px">行为层${d.behavior.loaded ? `已加载 ${num(d.behavior.bytes)} 字节` : '本进程未加载'}（需重启）＋ 人格层（即时）</div></div>
        <div class="card"><h3>人数上限</h3><div class="metric">${d.characters.length}<small>/ ${limit.maxCharacters}</small></div>
          <div class="muted" style="font-size:12px">单卡上限 ${Math.round(limit.maxBytes / 1024)} KB</div></div>
      </div>
      <div class="section card">
        <h3>行为层 · <code>${esc(d.behavior.path)}</code></h3>
        <div class="row" style="justify-content:space-between">
          <span class="muted" style="font-size:12px">定义「作为群友的行为协议」（何时可以开口、怎么分句、什么时候闭嘴）。改动<strong>需要重启</strong>才生效。</span>
          <span class="toolbar" style="margin:0">
            <span class="pill ${d.behavior.loaded ? 'ok' : ''}">${d.behavior.loaded ? `本进程已加载 ${num(d.behavior.bytes)} 字节` : d.behavior.onDisk ? '文件已存在，本进程未加载' : '未设置'}</span>
            ${d.behavior.pending ? '<span class="pill bad">待重启生效</span>' : ''}
            <button onclick="pfEdit('behavior','')">编辑行为层</button>
          </span>
        </div>
      </div>
      <div class="section card">
        <h3>人格卡</h3>
        ${d.characters.length ? `<table><thead><tr><th>名称</th><th>大小</th><th>最后修改</th><th>状态</th><th></th></tr></thead><tbody>
          ${d.characters.map(c => `<tr class="${c.active ? 'sel' : ''}">
            <td>${esc(c.name)}</td><td>${num(c.bytes)} B</td><td class="muted">${time(c.updated)}</td>
            <td>${c.active ? '<span class="ok-text">启用中</span>' : '<span class="muted">—</span>'}</td>
            <td><span class="toolbar" style="margin:0">
              <button onclick="pfEdit('card',${esc(JSON.stringify(c.name))})">编辑</button>
              ${c.active ? '<button onclick="pfActivate(\'\')">停用</button>' : `<button onclick="pfActivate(${esc(JSON.stringify(c.name))})">启用</button>`}
              <button onclick="pfDelete(${esc(JSON.stringify(c.name))})">删除</button>
            </span></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">还没有人格卡。点下方「新建」创建第一张。</div>'}
        <div class="toolbar">
          <button onclick="pfNew()">新建</button>
          <button onclick="pfActivate('')">恢复内置默认</button>
        </div>
      </div>
      <div class="section card">
        <h3>编辑器 · ${f.kind === 'behavior' ? '行为层（需重启）' : f.exists ? `人格卡「${esc(f.name)}」` : '新人格卡'}</h3>
        ${f.kind === 'card' ? `<div class="row" style="margin-bottom:10px">
          <label class="muted" style="font-size:12px">名称</label>
          <input type="text" value="${esc(f.name)}" oninput="pfName(this.value)" placeholder="例如 默认角色" maxlength="40">
          <span class="muted" style="font-size:12px">改名称后再保存即为「另存为」。</span>
        </div>` : '<div class="banner warn">行为层的改动不会立即生效：保存后需要重启 AutoChat。</div>'}
        <textarea oninput="pfContent(this.value)" placeholder="${f.kind === 'behavior' ? '例如：在群里默认保持沉默，只有被点名或话题与你相关时才开口；一次最多发三句短句。' : '角色设定：语气、口癖、偏好与禁区。'}">${esc(f.content)}</textarea>
        <div class="toolbar">
          <button onclick="pfSave()">保存</button>
          ${f.kind === 'card' && f.exists ? `<button onclick="pfDelete(${esc(JSON.stringify(f.name))})">删除这张卡</button>` : ''}
        </div>
      </div>
      <div class="section card">
        <h3>合成后的系统提示词（前 800 字）</h3>
        <pre>${esc(d.resolved.preview)}${d.resolved.bytes > new Blob([d.resolved.preview]).size ? '\n…' : ''}</pre>
        <div class="muted" style="font-size:12px;margin-top:8px">最终顺序：<code>SYSTEM_PROMPT</code>（若有，独占）→ 行为层 → 人格卡 → 内置默认。人格卡每次对话都会重新读取，保存后无需重启。</div>
      </div>`;
  },
  async social() {
    const d = await api('/api/social');
    if (!d.available) return '<div class="empty">仿真模块不可用。</div>';
    stamp.textContent = d.enabled ? '仿真已开启' : '仿真已关闭';
    const banners = [];
    if (!d.gate.core) banners.push('<div class="banner warn">模型回复已停止（<code>/停止</code>）。仿真同样不会发言。</div>');
    if (!d.gate.group) banners.push('<div class="banner warn">群回复已关闭（<code>/群关闭</code>）。仿真同样不会发言。</div>');
    if (!d.enabled) banners.push('<div class="banner">仿真未开启：群里仍然是「只 @ 才回」。开启后机器人才会自己判断该不该接话。</div>');
    if (socialNotice.text) banners.push(`<div class="banner ${socialNotice.bad ? 'bad' : 'ok'}">${esc(socialNotice.text)}</div>`);
    const groupRows = d.groups.map(g => {
      const dec = g.decision;
      const decided = dec
        ? `${esc(REASON_LABEL[dec.reason] || dec.reason)}<div class="muted" style="font-size:11px">分数 ${dec.score}${dec.need === null ? '' : ` / 需要 ${dec.need}`} · ${time(dec.at)}</div>`
        : '<span class="muted">尚无判定</span>';
      return `<tr>
        <td><code>${esc(g.id)}</code></td>
        <td><span class="pill ${g.state === 'active' ? 'ok' : ''}">${esc(SIM_LABEL[g.state] || g.state)}</span></td>
        <td>${(Number(g.energy) * 100).toFixed(0)}%</td>
        <td>${num(g.activity)}</td>
        <td>${num(g.spokeToday)} / ${num(g.dailyLimit)}</td>
        <td class="muted">${g.lastSpokeAt ? dur(g.idleMs) + '前' : '—'}</td>
        <td>${decided}</td>
        <td><button onclick="socialSet({group:${esc(JSON.stringify(g.id))}, muted:${g.muted ? 'false' : 'true'}})">${g.muted ? '取消静音' : '静音'}</button></td>
      </tr>`;
    }).join('');
    return `${banners.join('')}
      <div class="section grid">
        <div class="card"><h3>仿真开关</h3><div class="metric" style="font-size:20px">${d.enabled ? '已开启' : '已关闭'}</div>
          <div class="muted" style="font-size:12px">规则决定<b>何时说</b>，模型决定<b>说什么</b></div></div>
        <div class="card"><h3>今日主动发言</h3><div class="metric">${num(d.today.spoke)}<small>条</small></div>
          <div class="muted" style="font-size:12px">账期 ${esc(d.today.day)}（北京时间），每群上限 ${num(d.params.dailyLimit)}</div></div>
        <div class="card"><h3>相关度阈值</h3><div class="metric">${num(d.params.threshold)}</div>
          <div class="muted" style="font-size:12px">低于阈值=保持沉默（不调用模型，不花钱）</div></div>
        <div class="card"><h3>发言冷却</h3><div class="metric">${num(d.params.cooldownSeconds)}<small>秒</small></div>
          <div class="muted" style="font-size:12px">与上一条主动发言的最小间隔</div></div>
      </div>
      <div class="section card">
        <h3>参数（立即生效，写入本机设置）</h3>
        <div class="row" style="gap:14px">
          <button id="sim-switch" data-on="${d.enabled ? '1' : '0'}" onclick="socialToggle()">${d.enabled ? '关闭仿真' : '开启仿真'}</button>
          <label class="muted" style="font-size:12px">阈值 <input type="text" id="sim-threshold" style="min-width:70px" value="${esc(d.params.threshold)}"></label>
          <label class="muted" style="font-size:12px">冷却（秒） <input type="text" id="sim-cooldown" style="min-width:70px" value="${esc(d.params.cooldownSeconds)}"></label>
          <label class="muted" style="font-size:12px">每群日上限 <input type="text" id="sim-daily" style="min-width:70px" value="${esc(d.params.dailyLimit)}"></label>
          <button onclick="socialSave()">保存参数</button>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">默认值来自 <code>.env</code>：阈值 ${num(d.defaults.threshold)}、冷却 ${num(d.defaults.cooldownSeconds)} 秒、每群上限 ${num(d.defaults.dailyLimit)}；上下文 ${num(d.defaults.contextMessages)} 条、最多 ${num(d.defaults.maxChunks)} 条消息、发送间隔 ${num(d.defaults.minDelayMs)}~${num(d.defaults.maxDelayMs)} 毫秒、群消息保留 ${num(d.defaults.messageTtlHours)} 小时。上表可覆盖前三项。</div>
      </div>
      <div class="section card">
        <h3>每群状态</h3>
        ${d.groups.length ? `<table><thead><tr><th>群号</th><th>状态</th><th>能量</th><th>2 分钟内消息</th><th>今日发言</th><th>上次发言</th><th>最近判定</th><th></th></tr></thead><tbody>
          ${groupRows}
        </tbody></table>` : '<div class="empty">未配置群</div>'}
        <div class="muted" style="font-size:12px;margin-top:8px">状态含义：观望＝默认；试探＝刚开口，等回应；活跃＝有人接话，意愿更高；退场＝被冷落，长期少说。控制台不展示任何聊天正文。</div>
      </div>`;
  },
  async logs() {
    const d = await api('/api/logs?limit=150');
    stamp.textContent = `最近 ${d.logs.length} 条`;
    if (!d.logs.length) return '<div class="empty">暂无日志</div>';
    return `<div class="card"><table><thead><tr><th>时间</th><th>事件</th></tr></thead><tbody>
      ${d.logs.map(l => `<tr><td class="muted">${esc(l.time || '—')}</td><td><code>${esc(l.event)}</code></td></tr>`).join('')}
    </tbody></table></div>`;
  },
  async config() {
    const d = await api('/api/config');
    stamp.textContent = '密钥已打码';
    return `<div class="section card"><h3>凭据（已打码）</h3>
      <dl class="kv">${Object.entries(d.credentials).map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join('')}</dl></div>
      <div class="section card"><h3>生效配置</h3><pre>${esc(JSON.stringify(d.config, null, 2))}</pre></div>
      <div class="section card"><h3>模型配置</h3><pre>${esc(JSON.stringify(d.modelProfiles, null, 2))}</pre></div>`;
  }
};

async function render() {
  try { main.innerHTML = await pages[page](); }
  catch (error) { main.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
}
function schedule() {
  clearInterval(timer);
  // 人格页与仿真页保存着可编辑字段，轮询会覆盖输入：这两页只在动作或手动刷新时重绘。
  if (page === 'personas' || page === 'social') return;
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
