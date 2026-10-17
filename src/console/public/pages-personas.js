/* 人格。写入走 `POST /api/personas/{file,delete,active}`（服务端每次返回完整状态，
 * 所以写操作后直接重绘即可）。`SYSTEM_PROMPT` 存在时优先级最高，此时横幅提醒
 * 人格卡不会生效——这是 .env 的语义，不在前端假装能覆盖。
 */

const personaState = { ready: false, kind: 'card', name: '', content: '', exists: false, notice: null, bad: false };

const SOURCE_LABEL = { card: '人格卡', env: '环境变量', builtin: '内置默认' };
const SOURCE_HINT = { card: '由人格卡提供', env: 'SYSTEM_PROMPT 覆盖', builtin: 'src/persona.js' };

const personaNote = (text, bad = false) => { personaState.notice = text; personaState.bad = bad; };

const loadPersonaFile = async (kind, name) => {
  if (kind === 'behavior') {
    personaState.kind = 'behavior';
    personaState.name = 'behavior';
    personaState.content = '';
    try {
      const file = await api('/api/personas/file?kind=behavior');
      personaState.content = file.content ?? '';
      personaState.exists = Boolean(file.exists);
    } catch (error) { personaNote(reason(error), true); }
    return;
  }
  personaState.kind = 'card';
  personaState.name = name;
  personaState.content = '';
  try {
    const file = await api(`/api/personas/file?kind=card&name=${encodeURIComponent(name)}`);
    personaState.content = file.content ?? '';
    personaState.exists = Boolean(file.exists);
  } catch (error) { personaNote(reason(error), true); }
};

action('personaEdit', async el => {
  await loadPersonaFile('card', el.dataset.name || '');
  rerender();
});

action('personaNew', async () => {
  personaState.ready = true;
  personaState.kind = 'card';
  personaState.name = '';
  personaState.content = '';
  personaState.exists = false;
  personaNote('正在新建人格卡：填好名称与内容后点「保存」。');
  rerender();
});

action('personaBehavior', async () => {
  await loadPersonaFile('behavior');
  rerender();
});

action('personaSave', async () => {
  const nameInput = $('#pf-name');
  const contentInput = $('#pf-content');
  if (!contentInput) return;
  const content = contentInput.value;
  try {
    if (personaState.kind === 'behavior') {
      await post('/api/personas/file', { kind: 'behavior', content });
      personaNote('行为层已保存，重启 AutoChat 后生效。');
    } else {
      const name = (nameInput ? nameInput.value : '').trim();
      if (!name) {
        if (nameInput) nameInput.classList.add('is-invalid');
        personaNote('人格卡名称不能为空。', true);
        rerender();
        return;
      }
      await post('/api/personas/file', { name, content });
      personaState.name = name;
      personaState.exists = true;
      personaNote(`已保存人格卡「${name}」。`);
    }
  } catch (error) { personaNote(reason(error), true); }
  rerender();
});

action('personaActivate', async el => {
  const name = el.dataset.name || '';
  try {
    await post('/api/personas/active', { name });
    personaNote(name ? `已启用人格卡「${name}」。` : '已停用当前人格卡，回到默认来源。');
  } catch (error) { personaNote(reason(error), true); }
  rerender();
});

action('personaDelete', async el => {
  const name = el.dataset.name || '';
  if (!name) return;
  if (!window.confirm(`删除人格卡「${name}」？此操作不可撤销。`)) return;
  try {
    await post('/api/personas/delete', { name });
    if (personaState.name === name) {
      personaState.name = '';
      personaState.content = '';
      personaState.exists = false;
    }
    personaNote(`已删除人格卡「${name}」。`);
  } catch (error) { personaNote(reason(error), true); }
  rerender();
});

const personaStats = d => {
  const limit = d.limits || {};
  const chars = Array.isArray(d.characters) ? d.characters : [];
  const kb = limit.maxBytes === undefined ? DASH : `${Math.round(limit.maxBytes / 1024)} KB`;
  return `<div class="g4">${[
    stat('生效来源', esc(SOURCE_LABEL[d.source] || d.source || DASH), SOURCE_HINT[d.source] || ''),
    stat('人格卡', `${num(chars.length)} / ${num(limit.maxCharacters)}`, '已用 / 上限'),
    stat('合成提示词', d.resolved && d.resolved.bytes !== undefined ? `${num(d.resolved.bytes)} 字节` : DASH, '每次对话重新读取'),
    stat('单卡上限', esc(kb), '超出会被拒绝保存'),
  ].join('')}</div>`;
};

const personaBanners = d => {
  let out = '';
  if (d.override) {
    out += alertBox('warn', 'SYSTEM_PROMPT 已设置',
      '它优先级最高：人格卡的改动不会生效。清空该字段并重启后才会使用人格卡。');
  }
  if (personaState.notice) out += alertBox(personaState.bad ? 'err' : 'ok', personaState.bad ? '没有成功' : '完成', esc(personaState.notice));
  return out;
};

const personaTable = d => {
  const chars = Array.isArray(d.characters) ? d.characters : [];
  const rows = chars.map(item => [
    `<code>${esc(item.name)}</code>${item.active ? ' ' + badge('启用中', 'ok') : ''}`,
    `${num(item.bytes)} 字节`,
    esc(item.updated || DASH),
    item.active ? '启用中' : DASH,
    `<button class="btn btn-sm" data-act="personaEdit" data-name="${esc(item.name)}">编辑</button> `
      + `<button class="btn btn-sm" data-act="personaActivate" data-name="${esc(item.name)}">${item.active ? '停用' : '启用'}</button> `
      + `<button class="btn btn-sm btn-danger" data-act="personaDelete" data-name="${esc(item.name)}">删除</button>`,
  ]);
  const head = `<div class="toolbar"><button class="btn btn-sm" data-act="personaNew">新建人格卡</button>`
    + `<button class="btn btn-sm" data-act="personaBehavior">编辑行为层</button></div>`;
  return card('人格卡', `目录：${esc(d.directory || DASH)}`, head + table(
    ['名称', { label: '大小', num: true }, '最后修改', '状态', '操作'],
    rows, { empty: '还没有人格卡。新建一张后即使不启用也会保留在列表里。' },
  ));
};

const behaviorCard = d => {
  const behavior = d.behavior || {};
  const state = behavior.loaded
    ? `本进程已加载 ${num(behavior.bytes)} 字节`
    : (behavior.onDisk ? '文件已存在，本进程未加载' : '未设置');
  return card('行为层', '给模型的硬性行为约束，叠加在人格卡之前',
    kv([
      ['路径', behavior.path ? `<code>${esc(behavior.path)}</code>` : DASH],
      ['状态', esc(state)],
      ['待重启生效', behavior.pending ? badge('是', 'warn') : '否'],
      ['最终顺序', 'SYSTEM_PROMPT（若有，独占）→ 行为层 → 人格卡 → 内置默认'],
    ]));
};

const editorCard = d => {
  const state = personaState;
  const isBehavior = state.kind === 'behavior';
  const nameField = isBehavior
    ? `<span class="dim">行为层只有一个文件，不能改名。</span>`
    : field('人格卡名称', 'pf-name', `<input id="pf-name" type="text" maxlength="40" value="${esc(state.name)}" placeholder="例如：jasper">`,
      '改名称后再保存即为「另存为」。');
  return card(isBehavior ? '编辑行为层' : '编辑人格卡', state.name ? esc(state.name) : '未选择文件',
    `<div class="form">${nameField}`
    + `<label class="lbl" for="pf-content">内容（Markdown）</label>`
    + `<textarea id="pf-content" rows="14" placeholder="${isBehavior ? '写在这个文件里的规则对所有对话生效。' : '用 Markdown 描述这个角色的说话方式、边界与例子。'}">${esc(state.content)}</textarea>`
    + `<div class="toolbar">`
    + `<button class="btn btn-primary btn-sm" data-act="personaSave">保存</button>`
    + (state.exists && !isBehavior ? `<button class="btn btn-sm btn-danger" data-act="personaDelete" data-name="${esc(state.name)}">删除</button>` : '')
    + `</div>`
    + (isBehavior ? alertBox('info', '保存后需要重启', '行为层在启动时读入进程，改完要重启 AutoChat 才生效。') : '')
    + `</div>`);
};

const previewCard = d => {
  const preview = (d.resolved && d.resolved.preview) || '';
  if (!preview) return '';
  const cut = `
…`;
  return card('合成后的提示词（预览）', d.resolved.bytes === undefined ? '前 800 字' : `前 800 字，共 ${num(d.resolved.bytes)} 字节`,
    `<pre class="pre">${esc(preview)}${preview.length >= 800 ? cut : ''}</pre>`);
};

pages.personas = async () => {
  const d = await api('/api/personas');
  if (!d.available) return pageHead('人格', '人格模块未启用。') + alertBox('warn', '人格模块不可用', '检查 .env 的 PERSONA_DIR 配置后重启。');
  if (!personaState.ready) {
    personaState.ready = true;
    const chars = Array.isArray(d.characters) ? d.characters : [];
    const pick = d.active && chars.some(item => item.name === d.active) ? d.active : (chars[0] ? chars[0].name : '');
    if (pick) await loadPersonaFile('card', pick);
  }
  return pageHead('人格', '人格卡、行为层与最终提示词，改完即刻生效（行为层除外）。')
    + personaBanners(d)
    + personaStats(d)
    + `<div class="g2">${personaTable(d)}${behaviorCard(d)}</div>`
    + editorCard(d)
    + previewCard(d);
};

REPAINT.personas = () => {};
