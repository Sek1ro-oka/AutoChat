/* 设置：把 /api/settings 的字段表按分组画成表单。
 * 写路由是 POST /api/settings { name, value }；空字符串表示清除覆盖、回到 .env 默认值。
 * 字段表本身来自 src/runtime-config.js，所以这里不写死任何键名或取值范围。
 */

const settingsState = { notice: '', bad: false };

const settingSay = (text, bad = false) => {
  settingsState.notice = String(text || '');
  settingsState.bad = Boolean(bad);
};

const settingNotice = () => (settingsState.notice
  ? alertBox(settingsState.bad ? 'err' : 'ok', settingsState.bad ? '没保存' : '已保存', settingsState.notice)
  : '');

const SETTING_CONTROL = {
  boolean: field => sw(field.value === 'true', '', `data-act="settingToggle" data-name="${esc(field.name)}"`),
  enum: field => `<select id="cfg-${esc(field.name)}">${(field.options || [])
    .map(option => `<option value="${esc(option)}"${String(option) === String(field.value) ? ' selected' : ''}>${esc(option)}</option>`)
    .join('')}</select>`,
  number: field => `<input id="cfg-${esc(field.name)}" type="number" step="any" value="${esc(field.value)}"${field.min === undefined ? '' : ` min="${esc(field.min)}"`}${field.max === undefined ? '' : ` max="${esc(field.max)}"`}>`,
  integer: field => `<input id="cfg-${esc(field.name)}" type="number" step="1" value="${esc(field.value)}"${field.min === undefined ? '' : ` min="${esc(field.min)}"`}${field.max === undefined ? '' : ` max="${esc(field.max)}"`}>`,
};

const settingControl = (field) => {
  const build = SETTING_CONTROL[field.kind] || (item =>
    `<input id="cfg-${esc(item.name)}" type="text" value="${esc(item.value)}"${item.max === undefined ? '' : ` maxlength="${esc(item.max)}"`}>`);
  return build(field);
};

const settingRow = (field) => {
  const overridden = String(field.value) !== String(field.defaultValue);
  const control = settingControl(field);
  const buttons = field.kind === 'boolean'
    ? ''
    : `<div class="row">
        <button type="button" class="btn btn-primary" data-act="settingSave" data-name="${esc(field.name)}">保存</button>
        <button type="button" class="btn" data-act="settingReset" data-name="${esc(field.name)}">恢复默认</button>
      </div>`;
  return `<div class="field" data-setting="${esc(field.name)}">
    <span class="flabel">
      <span class="lname">${esc(field.label)}${overridden ? badge('已覆盖', 'warn') : ''}</span>
      <span class="lkey mono">${esc(field.key)}${overridden ? ` · 默认 ${esc(field.defaultValue === '' ? '空' : field.defaultValue)}` : ''}</span>
    </span>
    <div class="fctl">
      ${control}
      ${field.hint ? `<span class="lkey">${esc(field.hint)}</span>` : ''}
      ${buttons}
    </div>
  </div>`;
};

const settingGroup = (group, fields) => card(group.label, `${num(fields.length)} 项`, fields.map(settingRow).join(''));

pages.settings = async () => {
  const head = pageHead('设置', '运行时可改的参数都存在本地库里：覆盖只影响这一份配置，随时可以恢复成 .env 的默认值。')
    + settingNotice();
  let d;
  try {
    d = await api('/api/settings');
  } catch (error) {
    return head + alertBox('err', '读不到设置', reason(error));
  }
  const fields = Array.isArray(d && d.fields) ? d.fields : [];
  const groups = Array.isArray(d && d.groups) ? d.groups : [];
  if (!fields.length) return head + alertBox('warn', '没有可改的设置', '这一版没有暴露任何运行时字段。');
  const sections = groups
    .map(group => settingGroup(group, fields.filter(field => field.group === group.id)))
    .filter(section => section);
  const orphans = fields.filter(field => !groups.some(group => group.id === field.group));
  return head
    + `<div class="grid g4">
      ${stat('可改字段', num(fields.length), `分 ${num(groups.length)} 组`)}
      ${stat('已覆盖', num(fields.filter(field => String(field.value) !== String(field.defaultValue)).length), '与 .env 默认不同的项')}
    </div>`
    + alertBox('info', '保存后立即生效', '这些字段每次调用前重新读取，不需要重启机器人。密钥与令牌不在这里：它们只能在 .env 里改。')
    + sections.join('')
    + (orphans.length ? card('其他', `${num(orphans.length)} 项`, orphans.map(settingRow).join('')) : '');
};

action('settingSave', async (button) => {
  const name = button.dataset.name || '';
  const control = document.getElementById(`cfg-${name}`);
  if (!control) return;
  await post('/api/settings', { name, value: String(control.value) });
  settingSay(`${name} 已保存，立即生效。`);
  rerender();
});

action('settingReset', async (button) => {
  const name = button.dataset.name || '';
  await post('/api/settings', { name, value: '' });
  settingSay(`${name} 已恢复 .env 默认值。`);
  rerender();
});

action('settingToggle', async (button) => {
  const name = button.dataset.name || '';
  const on = !button.classList.contains('on');
  await post('/api/settings', { name, value: on ? 'true' : 'false' });
  settingSay(`${name} 已${on ? '打开' : '关闭'}。`);
  rerender();
});
