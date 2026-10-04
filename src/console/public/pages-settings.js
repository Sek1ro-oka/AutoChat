// 运行时设置页（V2）。挂在 `pages` 上（先于 app.js 加载）。与人格/仿真/黑话/
// 群设置/表情包页一样不轮询：这些输入框会在定时刷新时被覆盖。字段表本身由
// 服务端 src/runtime-config.js 下发，本页只负责按 `kind` 渲染控件与提交，
// 不在这里重复维护键名或范围——否则会与读取方（代理）静默失配。
//
// 每个字段独立保存：留空提交等于删除该行、恢复 `.env` 默认值；「恢复默认」
// 按钮是同一个动作的显式入口。

const settingsNotice = { text: '', bad: false };
const settingsSet = (text, bad = false) => { settingsNotice.text = text; settingsNotice.bad = bad; };

const settingsControl = (f, id) => {
  const value = esc(f.value);
  if (f.kind === 'boolean') {
    return `<input type="checkbox" id="${id}" ${f.value === 'true' ? 'checked' : ''}>`;
  }
  if (f.kind === 'enum') {
    const options = (f.options ?? []).map(o =>
      `<option value="${esc(o)}" ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('');
    return `<select id="${id}">${options}</select>`;
  }
  if (f.kind === 'number' || f.kind === 'integer') {
    const step = f.kind === 'integer' ? '1' : 'any';
    const bounds = `${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}`;
    return `<input type="number" id="${id}" value="${value}" step="${step}" ${bounds}>`;
  }
  return `<input type="text" id="${id}" value="${value}">`;
};

window.settingSave = async name => {
  const el = document.getElementById('cfg-' + name);
  if (!el) return;
  const value = el.type === 'checkbox' ? (el.checked ? 'true' : 'false') : el.value;
  try {
    await post('/api/settings', { name, value });
    settingsSet('已保存，立即生效。');
  } catch (error) { settingsSet(reason(error), true); }
  render();
};

window.settingReset = async name => {
  try {
    await post('/api/settings', { name, value: '' });
    settingsSet('已恢复默认（.env）。');
  } catch (error) { settingsSet(reason(error), true); }
  render();
};

Object.assign(pages, {
  async settings() {
    const d = await api('/api/settings');
    stamp.textContent = `${d.fields.length} 项 · 留空=恢复默认`;
    const byGroup = {};
    for (const field of d.fields) (byGroup[field.group] ||= []).push(field);
    const sections = d.groups.map(group => {
      const fields = byGroup[group.id] ?? [];
      if (!fields.length) return '';
      const rows = fields.map(field => {
        const id = 'cfg-' + field.name;
        const overridden = field.value !== field.defaultValue;
        const defaultText = field.defaultValue === '' ? '<em>（空）</em>' : `<code>${esc(field.defaultValue)}</code>`;
        const hint = field.hint ? `<div class="muted">${esc(field.hint)}</div>` : '';
        return `<div class="setting-row">
          <div class="setting-label">${esc(field.label)}${hint}</div>
          <div class="setting-input">${settingsControl(field, id)}</div>
          <div class="setting-default muted">默认 ${defaultText}${overridden ? ' <span class="bad-text">· 已覆盖</span>' : ''}</div>
          <div class="setting-actions">
            <button onclick="settingSave('${esc(field.name)}')">保存</button>
            ${overridden ? `<button onclick="settingReset('${esc(field.name)}')">恢复默认</button>` : ''}
          </div>
        </div>`;
      }).join('');
      return `<div class="section card"><h2>${esc(group.label)}</h2>${rows}</div>`;
    }).join('');
    const banner = settingsNotice.text
      ? `<div class="banner ${settingsNotice.bad ? 'bad' : 'ok'}">${esc(settingsNotice.text)}</div>` : '';
    return `${banner}<div class="banner">改动即时生效，无需重启；密钥与启动期参数（端口、WS 地址、数据库路径等）仍只在「配置」页只读展示。</div>${sections}`;
  },
});
