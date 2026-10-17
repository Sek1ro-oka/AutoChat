/* 黑话——素材库的第二个子页（原「黑话」页）。
 * 读 /api/slang，写 /api/slang/{config,extract,status,entry,scopes,delete,import,export}。
 * 原句（example）只在点开某一条时由 /api/slang/entry 单独取，列表里不带群消息原文。
 */

const SLANG_STATUS = { candidate: '待确认', confirmed: '已确认', rejected: '已拒绝' };
const SLANG_BADGE = { candidate: 'warn', confirmed: 'ok', rejected: 'err' };

const slangGroupsText = (row, scopes) => (row.length ? row.join(' · ') : `<span class="muted">全局</span>`);

const slangRow = (row, scopes) => `<tr>
    <td><strong>${esc(row.term || '')}</strong></td>
    <td>${row.meaning ? esc(row.meaning) : `<span class="muted">${DASH}</span>`}</td>
    <td>${badge(SLANG_STATUS[row.status] || row.status, SLANG_BADGE[row.status] || 'muted')}</td>
    <td>${slangGroupsText(scopes, row.groups)}</td>
    <td class="nowrap">${num(row.count)}</td>
    <td class="nowrap"><div class="row">
      <button type="button" class="btn" data-act="slangEdit" data-id="${esc(row.id)}">详情</button>
      <button type="button" class="btn" data-act="slangStatus" data-id="${esc(row.id)}" data-status="confirmed">确认</button>
      <button type="button" class="btn" data-act="slangStatus" data-id="${esc(row.id)}" data-status="rejected">拒绝</button>
      <button type="button" class="btn" data-act="slangDelete" data-id="${esc(row.id)}">删除</button>
    </div></td>
  </tr>`;

// 详情卡：意思 / 怎么用 / 禁忌 三项可改，生效群可勾选（一个都不勾 = 全局生效）。
const slangEditor = (entry, groups) => {
  const scoped = entry.groups || [];
  return card(`词条：${entry.term || ''}`, `出现在群里 ${num(entry.count)} 次`, `
    <div class="form">
      <label class="lbl">在群里的意思
        <textarea id="sl-meaning" rows="2">${esc(entry.meaning || '')}</textarea>
      </label>
      <label class="lbl">怎么用
        <textarea id="sl-usage" rows="2">${esc(entry.usage || '')}</textarea>
      </label>
      <label class="lbl">歧义或禁忌（留空即可）
        <textarea id="sl-risk" rows="2">${esc(entry.risk || '')}</textarea>
      </label>
      <div class="field">
        <span class="flabel"><span class="lname">生效群</span><span class="lkey">都不勾 = 全局生效</span></span>
        <div class="fctl"><div class="row">${groups.length
    ? groups.map(group => `<label class="row"><input type="checkbox" value="${esc(group)}" data-scope-group ${scoped.includes(group) ? 'checked' : ''}> ${esc(group)}</label>`).join('')
    : '<span class="muted">机器人还没在群里收到过消息，暂时没有可选的群。</span>'}</div></div>
      </div>
      <div class="row">
        <button type="button" class="btn btn-primary" data-act="slangSave">保存含义</button>
        <button type="button" class="btn" data-act="slangScopes">保存生效群</button>
        <button type="button" class="btn" data-act="slangClose">收起</button>
      </div>
      <label class="lbl">记录里的原句（来自群消息，仅在你点开详情时显示）
        <pre class="pre">${esc(entry.example || '没有记录到原句。')}</pre>
      </label>
    </div>`);
};

const slangFilters = stats => {
  const count = value => (value === 'all' ? stats.total : stats[value]) || 0;
  return seg(['all', 'candidate', 'confirmed', 'rejected'].map(value => ({
    value,
    label: `${value === 'all' ? '全部' : SLANG_STATUS[value]} ${num(count(value))}`,
  })), assetsState.filter, 'slangFilter');
};

const assetsSlangView = d => {
  const stats = d.stats || {};
  const limits = d.limits || {};
  const defaults = d.defaults || {};
  const rows = (d.entries || []).filter(row => assetsState.filter === 'all' || row.status === assetsState.filter);
  const full = Number(stats.total) >= Number(limits.entries);
  const banner = !d.enabled
    ? alertBox('warn', '黑话功能未开启', '现在是关的：不会注入、也不会自动抽取。打开下面的开关才会工作。')
    : (full ? alertBox('warn', '词条已达容量上限', `已经 ${num(stats.total)} 条，上限 ${num(limits.entries)} 条；再抽取会先裁掉最久没用的词条。`) : '');
  const last = d.lastExtract && d.lastExtract.at
    ? `上次抽取：${time(d.lastExtract.at)}，扫了 ${num(d.lastExtract.scanned)} 条消息，新增 ${num(d.lastExtract.created)} 条。`
    : '还没有抽取过。';
  const body = rows.length
    ? table(['词', '意思', '状态', '生效群', '出现', '操作'], rows.map(row => slangRow(row, row.groups)), { empty: '这一分类下没有词条。' })
    : '<div class="empty">这一分类下没有词条。开启黑话后，抽取到的候选会先出现在「待确认」里。</div>';
  const editor = assetsState.entry ? slangEditor(assetsState.entry, d.groups || []) : '';
  const preview = d.preview ? esc(d.preview) : '未注入任何内容（功能未开启，或还没有已确认的词条）。';
  return `<div class="grid g4">
      ${stat('黑话功能', d.enabled ? badge('已开启', 'ok') : badge('已关闭', 'muted'), d.searchEnabled ? '联网查义可用' : '联网查义不可用')}
      ${stat('已确认', num(stats.confirmed), `本次实际注入 ${num(stats.injected)} 条（上限 ${num(limits.injectMax)}）`)}
      ${stat('待确认', num(stats.candidate), '每次抽取最多产出 ' + num(limits.perRun) + ' 条')}
      ${stat('词条容量', `${num(stats.total)} / ${num(limits.entries)}`, '到上限时优先裁掉最久没用的')}
    </div>`
    + banner
    + card('开关与动作', last, `
      ${switchRow('黑话功能', sw(d.enabled, '黑话总开关', `class="btn" data-act="slangToggle" data-on="${d.enabled ? '1' : '0'}"`),
    '关掉后不再往提示词里注入，也不会自动抽取。')}
      <div class="toolbar">
        ${(d.groups || []).length
    ? (d.groups || []).map(group => `<button type="button" class="btn" data-act="slangExtract" data-group="${esc(group)}"${d.enabled ? '' : ' disabled title="先开启黑话功能"'}>抽取候选（${esc(group)}）</button>`).join('')
    : '<span class="muted">机器人还没在任何群里收到过消息，所以没有可抽取的群。</span>'}
      </div>
      <div class="toolbar">
        <button type="button" class="btn" data-act="slangExport">导出备份</button>
        <label class="lbl">恢复备份 <input type="file" accept="application/json,.json" data-act="slangImport"></label>
      </div>
      <p class="muted dim">抽取和查义各会调用一次模型并计入每日预算；自动抽取默认关闭（SLANG_AUTO_EXTRACT），周期改动需要重启。默认每次扫 ${num(defaults.extractMessages)} 条消息，原句保留 ${num(defaults.messageTtlHours)} 小时。</p>`)
    + editor
    + card('词条', `${num(rows.length)} 条`, `<div class="toolbar">${slangFilters(stats)}</div>${body}`)
    + card('注入到群聊提示词的内容', '', `<pre class="pre">${preview}</pre>`);
};

action('slangFilter', (button) => {
  assetsState.filter = button.dataset.value || 'all';
  rerender();
});

action('slangToggle', async (button) => {
  const on = button.dataset.on !== '1';
  await post('/api/slang/config', { enabled: on });
  assetSay(on ? '黑话功能已开启。' : '黑话功能已关闭：不再注入，也不再抽取。');
  rerender();
});

action('slangExtract', async (button) => {
  const group = button.dataset.group || '';
  const d = await post('/api/slang/extract', { group });
  const r = (d && d.result) || {};
  assetSay(`群 ${group}：扫了 ${num(r.scanned)} 条，候选 ${num(r.candidates)}，新增 ${num(r.created)}，更新 ${num(r.updated)}。`);
  rerender();
});

action('slangStatus', async (button) => {
  const status = button.dataset.status;
  await post('/api/slang/status', { id: button.dataset.id, status });
  if (assetsState.entry && assetsState.entry.id === button.dataset.id) assetsState.entry = null;
  assetSay(`已标记为「${SLANG_STATUS[status]}」。`);
  rerender();
});

action('slangDelete', async (button) => {
  if (!window.confirm('删除这个词条？删掉之后不会再注入。')) return;
  await post('/api/slang/delete', { id: button.dataset.id });
  if (assetsState.entry && assetsState.entry.id === button.dataset.id) assetsState.entry = null;
  assetSay('词条已删除。');
  rerender();
});

action('slangEdit', async (button) => {
  const d = await api(`/api/slang/entry?id=${encodeURIComponent(button.dataset.id || '')}`);
  assetsState.entry = (d && d.entry) || null;
  rerender();
});

action('slangClose', () => {
  assetsState.entry = null;
  rerender();
});

action('slangSave', async () => {
  const entry = assetsState.entry;
  if (!entry) return;
  const value = id => String((document.getElementById(id) || {}).value || '');
  await post('/api/slang/entry', { id: entry.id, meaning: value('sl-meaning'), usage: value('sl-usage'), risk: value('sl-risk') });
  assetsState.entry = null;
  assetSay('已保存这个词条的含义。');
  rerender();
});

action('slangScopes', async () => {
  const entry = assetsState.entry;
  if (!entry) return;
  const groups = Array.from(document.querySelectorAll('[data-scope-group]'))
    .filter(box => box.checked)
    .map(box => box.value);
  await post('/api/slang/scopes', { id: entry.id, groups });
  assetsState.entry = null;
  assetSay(groups.length ? `已限定在 ${groups.join('、')} 生效。` : '已改为全局生效。');
  rerender();
});

action('slangExport', async () => {
  const data = await api('/api/slang/export');
  if (typeof document === 'undefined' || !document.body) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'autochat-slang.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  assetSay('备份已导出（浏览器下载）。');
  rerender();
});

action('slangImport', (input, kind) => {
  if (kind !== 'change') return;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    post('/api/slang/import', { text: String(reader.result || '') })
      .then(() => {
        assetSay(`已从 ${file.name} 恢复备份。`);
        rerender();
      })
      .catch(error => {
        assetSay(`导入失败：${reason(error)}`, true);
        rerender();
      });
  };
  reader.readAsText(file);
  input.value = '';
});
