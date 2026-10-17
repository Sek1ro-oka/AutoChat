/* 表情包——素材库的第一个子页（原「表情包」页）。
 * 读 /api/stickers，写 /api/stickers/{config,status,entry,delete,upload}。
 * 两条不能忘的细节：缩略图必须带 ?token= 才拿得到字节（<img> 带不了请求头）；
 * 上传只收 data URL（FileReader 读出来的那种），所以先本地卡一遍大小再发。
 */

const STICKER_STATUS = { candidate: '待确认', confirmed: '已确认', rejected: '已拒绝' };
const STICKER_BADGE = { candidate: 'warn', confirmed: 'ok', rejected: 'err' };
const STICKER_SOURCE = { auto: '自动收藏', marker: '模型偷图', manual: '手动上传' };
const UPLOAD_MAX = 5 * 1024 * 1024;

const stickerThumb = id =>
  `<img class="thumb" alt="表情包缩略图" loading="lazy" src="/api/stickers/image?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}">`;

// core.js 的 table(headers, rows) 吃的是「每行一个单元格数组」，不是整行 <tr> 字符串；
// 以前这里返回 <tr>，只要库里有一张图就 TypeError: cells.map is not a function，整页白屏。
// 顺序必须与调用点的表头 ['图','描述 / 备注','标签','状态','出现','用过','来源','操作'] 一一对应；
// 原来写在 <td> 上的 nowrap 改由 CSS 的 .nowrap 类承担。
const stickerRow = d => {
  const badges = STICKER_BADGE[d.status] || 'muted';
  const file = d.desc ? esc(d.desc) : `<span class="muted">${esc(d.note || '没有备注')}</span>`;
  const tags = (d.tags || []).length ? esc((d.tags || []).join(' · ')) : DASH;
  // 缩略图的 src 必须带 ?token=：<img> 发不了请求头，去掉就是一堆占位图。
  return [
    stickerThumb(d.id),
    file,
    tags,
    badge(STICKER_STATUS[d.status] || d.status, badges),
    `<span class="nowrap">${num(d.seen)}</span>`,
    `<span class="nowrap">${num(d.useCount)}</span>`,
    `<span class="nowrap">${esc(STICKER_SOURCE[d.source] || d.source || DASH)}</span>`,
    `<span class="nowrap"><div class="row">
      <button type="button" class="btn" data-act="stickerEdit" data-id="${esc(d.id)}">编辑</button>
      <button type="button" class="btn" data-act="stickerStatus" data-id="${esc(d.id)}" data-status="confirmed">通过</button>
      <button type="button" class="btn" data-act="stickerStatus" data-id="${esc(d.id)}" data-status="rejected">拒绝</button>
      <button type="button" class="btn" data-act="stickerDelete" data-id="${esc(d.id)}">删除</button>
    </div></span>`,
  ];
};

// 详情编辑卡：只在点了「编辑」之后出现，字段是可改的三项（描述 / 备注 / 标签）。
const stickerEditor = entry => card(
  '编辑这张图',
  entry.file || '',
  `<div class="form">
    <label class="lbl">描述（给模型的画面说明，最多 200 字）
      <textarea id="st-desc" rows="2">${esc(entry.desc || '')}</textarea>
    </label>
    <label class="lbl">备注（只给你自己看，最多 120 字）
      <input type="text" id="st-note" class="w-320" value="${esc(entry.note || '')}">
    </label>
    <label class="lbl">标签（用 / 或逗号分开）
      <input type="text" id="st-tags" class="w-320" value="${esc((entry.tags || []).join('/'))}">
    </label>
    <div class="row">
      <button type="button" class="btn btn-primary" data-act="stickerSave">保存</button>
      <button type="button" class="btn" data-act="stickerClose">收起</button>
    </div>
  </div>`,
);

const stickerFilters = stats => {
  const count = value => (value === 'all' ? stats.total : stats[value]) || 0;
  return seg(
    ['all', 'candidate', 'confirmed', 'rejected'].map(value => ({
      value,
      label: `${value === 'all' ? '全部' : STICKER_STATUS[value]} ${num(count(value))}`,
    })),
    assetsState.filter,
    'stickerFilter',
  );
};

const assetsStickersView = d => {
  const stats = d.stats || {};
  const limits = d.limits || {};
  const params = d.params || {};
  const rows = (d.entries || []).filter(entry => assetsState.filter === 'all' || entry.status === assetsState.filter);
  const body = rows.length
    ? table(['图', '描述 / 备注', '标签', '状态', '出现', '用过', '来源', '操作'], rows.map(stickerRow), {
      empty: '这一分类下没有图片。',
    })
    : `<div class="empty">这一分类下没有图片。开启后群里的图片会被收集为「待确认」；也可以在上方手动上传。</div>`;
  const editor = assetsState.entry ? stickerEditor(assetsState.entry) : '';
  const preview = d.preview ? esc(d.preview) : '未注入任何内容（功能未开启，或还没有已确认的图片）。';
  return `<div class="grid g4">
      ${stat('图片总库', `${num(stats.total)} / ${num(limits.entries)}`, '到上限会先裁掉最久没用的')}
      ${stat('可发送', num(stats.sendable), '已确认、文件也还在')}
      ${stat('待确认', num(stats.candidate), '出现过的图，还没审')}
      ${stat('已确认', num(stats.confirmed), '会进提示词，也能被模型发出来')}
    </div>`
    + card('开关与自动收藏', '改完立刻生效，不用重启', `
      ${switchRow('表情包功能', sw(params.enabled, '表情包总开关', `class="btn" data-act="stickerToggle" data-on="${params.enabled ? '1' : '0'}"`),
    params.enabled ? '关掉后不再收藏、不再注入、也不再发送。' : '现在是关的：群里的图不会进库，模型也不会发表情。')}
      ${switchRow('自动收藏', sw(params.autoCollect, '自动收藏', `class="btn" data-act="stickerAutoToggle" data-on="${params.autoCollect ? '1' : '0'}"`),
    '关掉后只有模型打了「偷图」标记的图才会进库。')}
      <div class="form form-inline">
        <label class="lbl">自动确认阈值
          <input type="number" id="st-auto-threshold" class="w-90" min="0" value="${esc(String(params.autoThreshold ?? 0))}">
        </label>
        <button type="button" class="btn" data-act="stickerAutoSave">保存阈值</button>
        <label class="lbl">手动上传（≤ 5MB，png/jpeg/gif/webp）
          <input type="file" accept="image/*" data-act="stickerUpload">
        </label>
      </div>`)
    + editor
    + card('图片库', `${num(rows.length)} 张`, `<div class="toolbar">${stickerFilters(stats)}</div>${body}`)
    + card('注入到群聊提示词的内容', '', `<pre class="pre">${preview}</pre>`);
};

action('stickerFilter', (button) => {
  assetsState.filter = button.dataset.value || 'all';
  rerender();
});

action('stickerToggle', async (button) => {
  const on = button.dataset.on !== '1';
  const d = await post('/api/stickers/config', { enabled: on });
  assetSay(on ? '已开启：群图片会被收集为待确认。' : '已关闭：不再收藏、注入或发送表情。');
  if (d && !on) assetsState.filter = 'all';
  rerender();
});

action('stickerAutoToggle', async (button) => {
  const on = button.dataset.on !== '1';
  await post('/api/stickers/config', { autoCollect: on });
  assetSay(on ? '已开启自动收藏：同一张图出现达阈值会自动确认。' : '已关闭自动收藏：只有模型的「偷图」标记会收藏。');
  rerender();
});

action('stickerAutoSave', async () => {
  const { patch, missing } = readNumbers([{ id: 'st-auto-threshold', label: '自动确认阈值', key: 'autoThreshold' }]);
  if (missing.length) {
    refuse(document.getElementById('st-auto-threshold'), missing);
    return;
  }
  await post('/api/stickers/config', patch);
  assetSay(`自动确认阈值已保存：${patch.autoThreshold} 次。`);
  rerender();
});

action('stickerUpload', (input, kind) => {
  if (kind !== 'change') return;
  const file = input.files && input.files[0];
  if (!file) return;
  if (file.size > UPLOAD_MAX) {
    assetSay('文件超过 5MB。', true);
    input.value = '';
    rerender();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    post('/api/stickers/upload', { dataUrl: String(reader.result || '') })
      .then(() => {
        assetSay(`已上传：${file.name}。`);
        rerender();
      })
      .catch(error => {
        assetSay(`上传失败：${reason(error)}`, true);
        rerender();
      });
  };
  reader.readAsDataURL(file);
  input.value = '';
});

action('stickerStatus', async (button) => {
  const status = button.dataset.status;
  await post('/api/stickers/status', { id: button.dataset.id, status });
  assetSay(`已标记为「${STICKER_STATUS[status]}」。`);
  rerender();
});

action('stickerDelete', async (button) => {
  if (!window.confirm('删除这张图？会同时删除本地文件，不可撤销。')) return;
  await post('/api/stickers/delete', { id: button.dataset.id });
  if (assetsState.entry && assetsState.entry.id === button.dataset.id) assetsState.entry = null;
  assetSay('已删除。');
  rerender();
});

action('stickerEdit', async (button) => {
  const d = await api(`/api/stickers/entry?id=${encodeURIComponent(button.dataset.id || '')}`);
  assetsState.entry = (d && d.entry) || null;
  rerender();
});

action('stickerClose', () => {
  assetsState.entry = null;
  rerender();
});

action('stickerSave', async () => {
  const entry = assetsState.entry;
  if (!entry) return;
  const tags = String((document.getElementById('st-tags') || {}).value || '')
    .split(/[/,，、]/)
    .map(tag => tag.trim())
    .filter(Boolean);
  await post('/api/stickers/entry', {
    id: entry.id,
    desc: String((document.getElementById('st-desc') || {}).value || ''),
    note: String((document.getElementById('st-note') || {}).value || ''),
    tags,
  });
  assetsState.entry = null;
  assetSay('已保存这张图的描述与标签。');
  rerender();
});
