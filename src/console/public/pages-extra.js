// 黑话与群设置两个数据页。挂在 `pages` 上（pages.js 先加载），保持
// `pages.js` 在 400 行以内。两者与人格/仿真页一样不轮询，见 app.js::schedule。

Object.assign(pages, {
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
});
