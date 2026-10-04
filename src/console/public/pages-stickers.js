// 表情包库数据页（Phase 6）。挂在 `pages` 上（先于 app.js 加载），与人格/仿真/
// 黑话/群设置页一样不轮询。状态与写处理器也放在这里，让 app.js 不必为它再长。
//
// 缩略图走带 token 的查询串——`<img>` 带不了自定义请求头，而这张图是数据、不是
// 静态代码。确认/拒绝是唯一的安全闸门：待确认的图片不会发给模型。

const STICKER_STATUS = { candidate: '待确认', confirmed: '已确认', rejected: '已拒绝' };
const stickerState = { filter: 'all', enabled: false, entry: null, notice: '', bad: false, patch: {} };
const stickerSet = (text, bad = false) => { stickerState.notice = text; stickerState.bad = bad; };

window.stickerToggle = async () => {
  try {
    await post('/api/stickers/config', { enabled: !stickerState.enabled });
    stickerSet(stickerState.enabled ? '已关闭：不再收藏、注入或发送表情。' : '已开启。群图片会被收集为待确认。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerFilterSet = value => { stickerState.filter = value; render(); };
window.stickerAutoToggle = async () => {
  try {
    const d = await api('/api/stickers');
    await post('/api/stickers/config', { autoCollect: !d.params.autoCollect });
    stickerSet(d.params.autoCollect ? '已关闭自动收藏：只有模型的「偷图」标记会收藏。' : '已开启自动收藏：同一图出现达阈值即自动确认。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerAutoSave = async () => {
  try {
    await post('/api/stickers/config', { autoThreshold: Number($('#st-auto-threshold').value) });
    stickerSet('已保存自动收藏阈值。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerUploadFile = async input => {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { stickerSet('文件超过 5MB。', true); input.value = ''; render(); return; }
  stickerSet('正在上传…');
  render();
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await post('/api/stickers/upload', { dataUrl });
    stickerSet('已上传并确认为可发。');
  } catch (error) { stickerSet(reason(error), true); }
  input.value = '';
  render();
};
window.stickerStatus = async (id, status) => {
  try {
    await post('/api/stickers/status', { id, status });
    stickerSet(status === 'confirmed' ? '已确认：下一条消息起模型就能选用。' : status === 'rejected' ? '已拒绝：不会发给模型。' : '已退回待确认。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerOpen = async id => {
  try {
    const d = await api(`/api/stickers/entry?id=${encodeURIComponent(id)}`);
    stickerState.entry = d.entry; stickerState.patch = {};
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerClose = () => { stickerState.entry = null; stickerState.patch = {}; render(); };
window.stickerEdit = (id, field, value) => { (stickerState.patch[id] ||= {})[field] = value; };
window.stickerSave = async id => {
  const patch = stickerState.patch[id] || {};
  if (!Object.keys(patch).length) { stickerSet('没有改动。'); render(); return; }
  const clean = { ...patch };
  if (typeof clean.tags === 'string') clean.tags = clean.tags.split('/').map(t => t.trim()).filter(Boolean);
  try {
    await post('/api/stickers/entry', { id, ...clean });
    delete stickerState.patch[id];
    stickerSet('备注/标签已保存。确认状态不变。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};
window.stickerDelete = async id => {
  if (!window.confirm('删除这张图？会同时删除本地文件，不可撤销。')) return;
  try {
    await post('/api/stickers/delete', { id });
    if (stickerState.entry?.id === id) stickerState.entry = null;
    stickerSet('已删除。');
  } catch (error) { stickerSet(reason(error), true); }
  render();
};

Object.assign(pages, {
  async stickers() {
    const d = await api('/api/stickers');
    if (!d.available) return '<div class="empty">表情包模块不可用。</div>';
    stickerState.enabled = d.enabled;
    stamp.textContent = `${d.stats.total} 张 · 可发 ${d.stats.sendable}`;
    const tk = localStorage.getItem('autochat.console.token') || '';
    const banners = [];
    if (!d.enabled) banners.push('<div class="banner">表情包功能<strong>未开启</strong>：不会收藏群图片，也不会注入可用表情、发送表情。</div>');
    if (d.stats.total >= d.limits.entries) banners.push(`<div class="banner warn">已达容量上限 ${num(d.limits.entries)} 张，新收藏会按「已确认 &gt; 使用次数 &gt; 最近更新」裁剪。</div>`);
    if (stickerState.notice) banners.push(`<div class="banner ${stickerState.bad ? 'bad' : 'ok'}">${esc(stickerState.notice)}</div>`);

    const shown = d.entries.filter(e => stickerState.filter === 'all' || e.status === stickerState.filter);
    const filterButtons = [['all', `全部 ${d.stats.total}`], ['candidate', `待确认 ${d.stats.candidate}`],
      ['confirmed', `已确认 ${d.stats.confirmed}`], ['rejected', `已拒绝 ${d.stats.rejected}`]]
      .map(([key, label]) => `<button onclick="stickerFilterSet('${key}')" class="${stickerState.filter === key ? 'on' : ''}">${esc(label)}</button>`).join('');

    const detail = stickerState.entry;
    const rows = shown.map(entry => {
      const patch = stickerState.patch[entry.id] || {};
      const note = patch.note ?? (detail?.id === entry.id ? detail.note : entry.note);
      const thumb = entry.file
        ? `<img src="/api/stickers/image?id=${encodeURIComponent(entry.id)}&token=${encodeURIComponent(tk)}" alt="" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:6px;background:var(--panel-2)">`
        : '<span class="muted" style="font-size:12px">无图</span>';
      return `<tr class="${detail?.id === entry.id ? 'sel' : ''}">
        <td>${thumb}</td>
        <td><code>${esc(entry.id.slice(0, 8))}</code></td>
        <td>${note ? esc(note) : (entry.desc ? esc(entry.desc) : '<span class="muted">（暂无备注）</span>')}</td>
        <td>${entry.tags?.length ? esc(entry.tags.join('/')) : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${entry.status === 'confirmed' ? 'ok' : ''}">${esc(STICKER_STATUS[entry.status] || entry.status)}</span></td>
        <td>${num(entry.seen)}</td>
        <td>${num(entry.useCount)}</td>
        <td class="muted">${esc(entry.source)}</td>
        <td><span class="toolbar" style="margin:0">
          ${entry.status === 'confirmed' ? '' : `<button onclick="stickerStatus(${esc(JSON.stringify(entry.id))},'confirmed')">确认</button>`}
          ${entry.status === 'rejected' ? '' : `<button onclick="stickerStatus(${esc(JSON.stringify(entry.id))},'rejected')">拒绝</button>`}
          <button onclick="stickerOpen(${esc(JSON.stringify(entry.id))})">${detail?.id === entry.id ? '收起' : '详情/改备注'}</button>
          <button onclick="stickerDelete(${esc(JSON.stringify(entry.id))})">删除</button>
        </span></td></tr>`;
    }).join('');

    const detailPanel = detail ? `<div class="section card">
      <h3>表情详情 · <code>${esc(detail.id)}</code></h3>
      <div class="row" style="margin:10px 0">
        ${detail.file ? `<img src="/api/stickers/image?id=${encodeURIComponent(detail.id)}&token=${encodeURIComponent(tk)}" alt="" style="max-width:160px;max-height:160px;border-radius:8px;background:var(--panel-2)">` : '<span class="muted">无图</span>'}
        <div class="muted" style="font-size:12px">出现 ${num(detail.seen)} 次 · 用过 ${num(detail.useCount)} 次 · 来源 ${esc(detail.source)} · 创建 ${time(detail.created)}</div>
      </div>
      <div class="row" style="margin-bottom:10px"><label class="muted" style="font-size:12px;min-width:52px">备注</label>
        <input type="text" style="flex:1" value="${esc(stickerState.patch[detail.id]?.note ?? detail.note)}"
          oninput="stickerEdit(${esc(JSON.stringify(detail.id))},'note',this.value)" placeholder="给这张图写一句备注，模型会据此选用"></div>
      <div class="row" style="margin-bottom:10px"><label class="muted" style="font-size:12px;min-width:52px">标签</label>
        <input type="text" style="flex:1" value="${esc((stickerState.patch[detail.id]?.tags ?? detail.tags ?? []).join('/'))}"
          oninput="stickerEdit(${esc(JSON.stringify(detail.id))},'tags',this.value)" placeholder="用 / 分隔，如 猫/无语/尴尬"></div>
      <div class="toolbar">
        <button onclick="stickerSave(${esc(JSON.stringify(detail.id))})">保存备注</button>
        <button onclick="stickerClose()">收起</button>
      </div>
    </div>` : '';

    return `${banners.join('')}
      <div class="section grid">
        <div class="card"><h3>功能开关</h3><div class="metric" style="font-size:20px">${d.enabled ? '已开启' : '已关闭'}</div>
          <div class="muted" style="font-size:12px">只收集群聊图片，私聊不碰</div></div>
        <div class="card"><h3>可发</h3><div class="metric">${num(d.stats.sendable)}<small>张</small></div>
          <div class="muted" style="font-size:12px">已确认且有本地文件的才会发给模型</div></div>
        <div class="card"><h3>待确认</h3><div class="metric">${num(d.stats.candidate)}<small>张</small></div>
          <div class="muted" style="font-size:12px">规则收藏不会自动生效，需你点「确认」</div></div>
        <div class="card"><h3>容量</h3><div class="metric">${num(d.stats.total)}<small>/ ${num(d.limits.entries)}</small></div>
          <div class="muted" style="font-size:12px">超限按「已确认 &gt; 使用次数 &gt; 最近更新」裁剪</div></div>
      </div>
      <div class="section card">
        <h3>操作</h3>
        <div class="row" style="gap:10px">
          <button onclick="stickerToggle()">${d.enabled ? '关闭表情包' : '开启表情包'}</button>
          <button onclick="stickerAutoToggle()">自动收藏：${d.params.autoCollect ? '开' : '关'}</button>
          <label class="muted" style="font-size:12px">出现次数阈值 <input type="text" id="st-auto-threshold" value="${esc(d.params.autoThreshold)}" style="min-width:48px"></label>
          <button onclick="stickerAutoSave()">保存自动收藏</button>
          <label class="muted" style="font-size:12px">上传自己的图 <input type="file" accept="image/*" onchange="stickerUploadFile(this)"></label>
        </div>
        <div class="muted" style="font-size:12px;margin-top:8px">
          自动收藏：同一张图出现 ≥ 阈值次就自动确认。模型也可以在自己的回复里写 <code>【偷图:备注】</code> 主动收藏当前图片、写 <code>【表情:编号】</code> 主动发图——这两种都不额外花钱。
        </div>
      </div>
      <div class="section card">
        <h3>图片库</h3>
        <div class="row" style="margin-bottom:10px"><span class="seg">${filterButtons}</span></div>
        ${shown.length ? `<table><thead><tr><th>图</th><th>ID</th><th>备注</th><th>标签</th><th>状态</th><th>出现</th><th>用过</th><th>来源</th><th>操作</th></tr></thead><tbody>
          ${rows}</tbody></table>` : '<div class="empty">这一分类下没有图片。开启后，群里的图片会被收集为「待确认」；也可以在上方手动上传。</div>'}
      </div>
      ${detailPanel}
      <div class="section card">
        <h3>当前注入到群聊提示词的内容</h3>
        ${d.preview ? `<pre>${esc(d.preview)}</pre>` : '<div class="empty">未注入任何内容（功能未开启，或还没有已确认的图片）。</div>'}
        <div class="muted" style="font-size:12px;margin-top:8px">这段会追加在人格提示词之后，群聊问答与仿真两条路径都会带上，且每次对话重新读取。私聊不带。</div>
      </div>`;
  },
});
