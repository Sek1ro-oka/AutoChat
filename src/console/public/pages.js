// 每个页面一个渲染函数，全部挂在同一个 `pages` 对象上。
// 本文件在 app.js 之前加载：`pages` 是经典脚本的全局词法绑定，
// 因此 app.js 的 render() 与内联 onclick 都能直接引用它。

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
  async slang() {
    const d = await api('/api/slang');
    if (!d.available) return '<div class="empty">黑话模块不可用。</div>';
    slangState.enabled = d.enabled;
    stamp.textContent = `${d.stats.total} 条 · 已确认 ${d.stats.confirmed}`;
    const banners = [];
    if (!d.enabled) banners.push('<div class="banner">黑话功能<strong>未开启</strong>：已确认的词条不会进入群聊提示词，「抽取候选」也不可用。词库本身仍可查看与编辑。</div>');
    if (d.stats.total >= d.limits.entries) banners.push(`<div class="banner warn">词条已达容量上限 ${num(d.limits.entries)} 条，新抽取会按「已确认 &gt; 出现次数 &gt; 最近更新」把优先级最低的词条裁掉。</div>`);
    if (slangState.notice) banners.push(`<div class="banner ${slangState.bad ? 'bad' : 'ok'}">${esc(slangState.notice)}</div>`);

    const shown = d.entries.filter(e => slangState.filter === 'all' || e.status === slangState.filter);
    const filterButtons = [['all', `全部 ${d.stats.total}`], ['candidate', `待确认 ${d.stats.candidate}`],
      ['confirmed', `已确认 ${d.stats.confirmed}`], ['rejected', `已拒绝 ${d.stats.rejected}`]]
      .map(([key, label]) => `<button onclick="slangFilterSet('${key}')" class="${slangState.filter === key ? 'on' : ''}">${esc(label)}</button>`).join('');

    const groups = d.groups.length ? d.groups : [''];
    const extractButtons = d.enabled
      ? groups.map(g => `<button onclick="slangExtract(${esc(JSON.stringify(g))})">抽取候选${g ? `（${esc(g)}）` : ''}</button>`).join('')
      : '<button disabled title="先开启黑话功能">抽取候选</button>';

    const detail = slangState.entry;
    const rows = shown.map(entry => {
      const patch = slangState.patch[entry.id] || {};
      const meaning = patch.meaning ?? (detail?.id === entry.id ? detail.meaning : entry.meaning);
      return `<tr class="${detail?.id === entry.id ? 'sel' : ''}">
        <td><code>${esc(entry.term)}</code></td>
        <td>${meaning ? esc(meaning) : '<span class="muted">（暂无含义）</span>'}</td>
        <td><span class="pill ${entry.status === 'confirmed' ? 'ok' : ''}">${esc(SLANG_STATUS[entry.status] || entry.status)}</span></td>
        <td>${num(entry.count)}</td>
        <td class="muted">${esc(entry.source)}</td>
        <td class="muted">${time(entry.updated)}</td>
        <td><span class="toolbar" style="margin:0">
          ${entry.status === 'confirmed' ? '' : `<button onclick="slangStatus(${esc(JSON.stringify(entry.id))},'confirmed')">确认</button>`}
          ${entry.status === 'rejected' ? '' : `<button onclick="slangStatus(${esc(JSON.stringify(entry.id))},'rejected')">拒绝</button>`}
          <button onclick="slangOpen(${esc(JSON.stringify(entry.id))})">${detail?.id === entry.id ? '收起' : '详情/改义'}</button>
          <button onclick="slangLookup(${esc(JSON.stringify(entry.id))})" ${d.searchEnabled ? '' : 'disabled title="需要 WEB_SEARCH_ENABLED"'}>联网查义</button>
          <button onclick="slangDelete(${esc(JSON.stringify(entry.id))},${esc(JSON.stringify(entry.term))})">删除</button>
        </span></td></tr>`;
    }).join('');

    const detailPanel = detail ? `<div class="section card">
      <h3>词条详情 · <code>${esc(detail.content)}</code></h3>
      <div class="muted" style="font-size:12px">出现 ${num(detail.count)} 次 · 来源 ${esc(detail.source)} · 创建 ${time(detail.created)} · 更新 ${time(detail.updated)}
        ${detail.sources?.length ? ` · 依据 <code>${esc(detail.sources.join(' '))}</code>` : ''}</div>
      <div class="row" style="margin:10px 0"><label class="muted" style="font-size:12px;min-width:52px">含义</label>
        <input type="text" style="flex:1" value="${esc(slangState.patch[detail.id]?.meaning ?? detail.meaning)}"
          oninput="slangEdit(${esc(JSON.stringify(detail.id))},'meaning',this.value)" placeholder="群里的意思"></div>
      <div class="row" style="margin-bottom:10px"><label class="muted" style="font-size:12px;min-width:52px">用法</label>
        <input type="text" style="flex:1" value="${esc(slangState.patch[detail.id]?.usage ?? detail.usage)}"
          oninput="slangEdit(${esc(JSON.stringify(detail.id))},'usage',this.value)" placeholder="怎么用"></div>
      <div class="row" style="margin-bottom:10px"><label class="muted" style="font-size:12px;min-width:52px">风险</label>
        <input type="text" style="flex:1" value="${esc(slangState.patch[detail.id]?.risk ?? detail.risk)}"
          oninput="slangEdit(${esc(JSON.stringify(detail.id))},'risk',this.value)" placeholder="歧义或禁忌，留空即可"></div>
      <div class="row" style="margin-bottom:10px"><label class="muted" style="font-size:12px;min-width:52px">生效群</label>
        <span class="row" style="gap:10px">${d.groups.map(gid => {
          const checked = (detail.groups ?? []).includes(String(gid));
          return `<label class="muted" style="font-size:12px"><input type="checkbox" data-scope-group="${esc(gid)}" ${checked ? 'checked' : ''}> ${esc(gid)}</label>`;
        }).join('') || '<span class="muted">未配置群</span>'}</span>
        <button onclick="slangScopeSave(${esc(JSON.stringify(detail.id))})">保存生效群</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:10px">不勾选任何群 = 全局生效（注入所有群）；勾选若干群 = 仅这些群注入。</div>
      <div class="toolbar">
        <button onclick="slangSave(${esc(JSON.stringify(detail.id))})">保存含义</button>
        <button onclick="slangClose()">收起</button>
      </div>
      ${detail.example ? `<div class="muted" style="font-size:12px;margin-top:10px">记录中的原句（来自群消息，仅在你点开详情时显示）：</div>
        <pre>${esc(detail.example)}</pre>` : ''}
    </div>` : '';

    return `${banners.join('')}
      <div class="section grid">
        <div class="card"><h3>功能开关</h3><div class="metric" style="font-size:20px">${d.enabled ? '已开启' : '已关闭'}</div>
          <div class="muted" style="font-size:12px">只有「已确认」的词条会被注入群聊提示词</div></div>
        <div class="card"><h3>已确认</h3><div class="metric">${num(d.stats.confirmed)}<small>条</small></div>
          <div class="muted" style="font-size:12px">本次实际注入 ${num(d.stats.injected)} 条（上限 ${num(d.limits.injectMax)}）</div></div>
        <div class="card"><h3>待确认</h3><div class="metric">${num(d.stats.candidate)}<small>条</small></div>
          <div class="muted" style="font-size:12px">抽取结果不会自动生效</div></div>
        <div class="card"><h3>词条容量</h3><div class="metric">${num(d.stats.total)}<small>/ ${num(d.limits.entries)}</small></div>
          <div class="muted" style="font-size:12px">超限按「已确认 &gt; 出现次数 &gt; 最近更新」裁剪</div></div>
      </div>
      <div class="section card">
        <h3>操作</h3>
        <div class="row" style="gap:10px">
          <button onclick="slangToggle()">${d.enabled ? '关闭黑话功能' : '开启黑话功能'}</button>
          ${extractButtons}
          <button onclick="slangExport()">导出备份</button>
          <label class="muted" style="font-size:12px">恢复备份 <input type="file" accept="application/json,.json" onchange="slangImportFile(this)"></label>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">
          抽取与查义各会调用一次模型并计入每日预算；自动抽取默认关闭（<code>SLANG_AUTO_EXTRACT</code>），周期改动需重启。
          抽取扫描最近 ${num(d.defaults.extractMessages)} 条群消息（保留 ${num(d.defaults.messageTtlHours)} 小时）；上次抽取：
          ${d.lastExtract ? `${time(d.lastExtract.at)}，扫描 ${num(d.lastExtract.scanned)} 条、候选 ${num(d.lastExtract.candidates)} 个` : '尚无'}。
        </div>
      </div>
      <div class="section card">
        <h3>词条库</h3>
        <div class="row" style="margin-bottom:10px"><span class="seg">${filterButtons}</span></div>
        ${shown.length ? `<table><thead><tr><th>词条</th><th>含义</th><th>状态</th><th>出现</th><th>来源</th><th>更新</th><th>操作</th></tr></thead><tbody>
          ${rows}</tbody></table>` : '<div class="empty">这一分类下没有词条。开启功能后点「抽取候选」。</div>'}
      </div>
      ${detailPanel}
      <div class="section card">
        <h3>当前注入到群聊提示词的内容</h3>
        ${d.preview ? `<pre>${esc(d.preview)}</pre>` : '<div class="empty">未注入任何内容（功能未开启，或还没有已确认的词条）。</div>'}
        <div class="muted" style="font-size:12px;margin-top:8px">这段文字会追加在人格提示词之后，群聊与问答（@机器人）两条路径都会带上，且每次对话都重新读取。私聊不带。</div>
      </div>`;
  },
  async groups() {
    const d = await api('/api/groups');
    stamp.textContent = `${d.groups.length} 个群`;
    if (!d.groups.length) return '<div class="empty">未配置群。请在 <code>.env</code> 的 <code>GROUP_QQS</code> 里用逗号列出群号。</div>';
    const banners = [];
    if (groupState.notice) banners.push(`<div class="banner ${groupState.bad ? 'bad' : 'ok'}">${esc(groupState.notice)}</div>`);
    const names = d.personas?.characters ?? [];
    const globalActive = d.personas?.active ?? '';
    const g = d.socialGlobal ?? { threshold: 0, cooldownSeconds: 0, dailyLimit: 0 };

    const cards = d.groups.map(row => {
      const p = row.persona, s = row.social, sl = row.slang;
      const inheritLabel = globalActive ? `继承全局（${esc(globalActive)}）` : '继承全局（内置默认）';
      const selValue = p?.override === null || p?.override === undefined ? '__inherit__' : p.override;
      const personaOptions = [`<option value="__inherit__">${inheritLabel}</option>`,
        `<option value="" ${selValue === '' ? 'selected' : ''}>内置默认</option>`]
        .concat(names.map(n => `<option value="${esc(n)}" ${selValue === n ? 'selected' : ''}>${esc(n)}</option>`)).join('');
      const personaLive = p?.source === 'group' ? `该群指定「${esc(p.active || '内置默认')}」`
        : p?.source === 'global' ? `继承全局「${esc(p.active)}」` : '内置默认';

      const ov = s?.overridden ?? {};
      const socialEnabled = s?.enabled;
      const field = (key, id, value, min, max, unit) => `<label class="muted" style="font-size:12px">${key}
        <input type="text" id="${id}" style="min-width:64px" value="${esc(value)}">
        ${ov[key] ? `<button onclick="groupSocialInherit(${esc(JSON.stringify(row.id))},'${key}')" title="清除该群覆盖，改回继承全局">清除</button>` : '<span class="muted">继承</span>'}
      </label>`;

      return `<div class="card">
        <div class="row" style="justify-content:space-between">
          <h3 style="margin:0">群 <code>${esc(row.id)}</code></h3>
          <button onclick="groupReset(${esc(JSON.stringify(row.id))})">恢复该群默认</button>
        </div>
        <div class="row" style="margin-top:10px">
          <label class="muted" style="font-size:12px">人格卡
            <select onchange="groupPersona(${esc(JSON.stringify(row.id))},this.value)">${personaOptions}</select>
          </label>
          <span class="muted" style="font-size:12px">${esc(personaLive)}</span>
        </div>
        <div class="row" style="margin-top:10px">
          <button onclick="groupSocialToggle(${esc(JSON.stringify(row.id))},${socialEnabled ? 'false' : 'true'})">${socialEnabled ? '关闭仿真' : '开启仿真'}</button>
          ${field('阈值', `g-threshold-${row.id}`, s?.threshold ?? g.threshold, 0, 100)}
          ${field('冷却(秒)', `g-cooldown-${row.id}`, s?.cooldownSeconds ?? g.cooldownSeconds, 5, 3600)}
          ${field('日上限', `g-daily-${row.id}`, s?.dailyLimit ?? g.dailyLimit, 1, 500)}
          <button onclick="groupSocialSave(${esc(JSON.stringify(row.id))})">保存仿真参数</button>
        </div>
        <div class="row" style="margin-top:10px">
          <button onclick="groupSlangToggle(${esc(JSON.stringify(row.id))},${sl?.enabled ? 'false' : 'true'})">${sl?.enabled ? '关闭黑话' : '开启黑话'}</button>
          <span class="muted" style="font-size:12px">${sl?.override === null || sl?.override === undefined ? '继承全局开关' : '该群已单独指定'} · 适用词条 ${num(sl?.terms ?? 0)} 条</span>
        </div>
      </div>`;
    }).join('');

    return `${banners.join('')}
      <div class="section card">
        <h3>按群特异化</h3>
        <div class="muted" style="font-size:12px">每个群可独立选择人格卡、仿真参数（开关/阈值/冷却/日上限）与黑话开关。未单独指定的项继承全局值；「恢复默认」会清空该群的全部覆盖。</div>
      </div>
      <div class="section" style="display:grid;gap:14px">${cards}</div>`;
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
