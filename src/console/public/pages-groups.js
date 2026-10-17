/* 群管理。一个群一张卡：人格卡选择、仿真开关与三项参数、黑话开关、恢复默认。
 * 写入统一走 `POST /api/groups/config`（`subsystem` 决定落在哪一层），
 * 服务端每次返回完整状态，写成功后直接重绘。
 */

const groupState = { notice: null, bad: false };
const groupNote = (text, bad = false) => { groupState.notice = text; groupState.bad = bad; };

const SOCIAL_KEYS = [
  { key: 'threshold', label: '相关度阈值', min: 0, max: 100, unit: '0-100' },
  { key: 'cooldownSeconds', label: '发言冷却（秒）', min: 5, max: 3600, unit: '5-3600' },
  { key: 'dailyLimit', label: '每日上限', min: 1, max: 500, unit: '1-500' },
];

const groupWrite = async (group, patch, done) => {
  try {
    await post('/api/groups/config', { group, ...patch });
    groupNote(done);
  } catch (error) { groupNote(reason(error), true); }
  rerender();
};

action('groupPersona', el => {
  const name = el.value === '__inherit__' ? null : el.value;
  const patch = name === null ? { subsystem: 'persona' } : { subsystem: 'persona', name };
  return groupWrite(el.dataset.group || '', patch, name ? `已把该群指定到人格卡「${name}」。` : '该群恢复继承全局人格卡。');
});

action('groupSocialToggle', el => {
  const on = el.dataset.on === '1';
  return groupWrite(el.dataset.group || '', { subsystem: 'social', enabled: !on },
    on ? '该群已关闭仿真。' : '该群已开启仿真。');
});

action('groupSocialSave', el => {
  const group = el.dataset.group || '';
  const patch = { subsystem: 'social' };
  let missing = '';
  for (const item of SOCIAL_KEYS) {
    const raw = $(`#g-${item.key}-${group}`);
    if (!raw) continue;
    // 不能直接 Number('')：空串会变成 0，而阈值下限正好是 0，于是「什么都没填」
    // 会被当成合法的 0 发出去。先 trim 再判空。
    const text = String(raw.value).trim();
    const value = text === '' ? NaN : Number(text);
    if (!Number.isFinite(value) || value < item.min || value > item.max) {
      raw.classList.add('is-invalid');
      missing = missing || `${item.label}需在 ${item.unit} 之间`;
    }
    patch[item.key] = value;
  }
  if (missing) {
    groupNote(`${missing}。本次没有保存任何改动。`, true);
    // 就地写提示，不整页重绘：重绘会把操作者刚填的其它字段一起冲掉。
    const slot = $('#groups-notice');
    if (slot) slot.innerHTML = alertBox('err', '没有保存', esc(`${missing}。本次没有保存任何改动。`));
    return;
  }
  return groupWrite(group, patch, '该群仿真参数已保存。');
});

action('groupSocialInherit', el => {
  const group = el.dataset.group || '';
  const key = el.dataset.key || '';
  return groupWrite(group, { subsystem: 'social', [key]: null }, `已清除「${key}」的本群覆盖，改回继承全局。`);
});

action('groupSlangToggle', el => {
  const on = el.dataset.on === '1';
  return groupWrite(el.dataset.group || '', { subsystem: 'slang', enabled: !on },
    on ? '该群已关闭黑话。' : '该群已开启黑话。');
});

action('groupReset', el => groupWrite(el.dataset.group || '', { subsystem: 'reset' },
  '已清除该群的人格卡、仿真、黑话覆盖，全部回到全局默认。'));

const groupPersonaRow = (row, chars, globalActive) => {
  const view = row.persona || {};
  const inherit = globalActive ? `继承全局（${globalActive}）` : '继承全局（内置默认）';
  const selected = view.override === null || view.override === undefined ? '__inherit__' : view.override;
  const options = [`<option value="__inherit__"${selected === '__inherit__' ? ' selected' : ''}>${esc(inherit)}</option>`,
    `<option value=""${selected === '' ? ' selected' : ''}>内置默认</option>`]
    .concat(chars.map(name => `<option value="${esc(name)}"${selected === name ? ' selected' : ''}>${esc(name)}</option>`));
  const live = view.source === 'env' ? '被 SYSTEM_PROMPT 覆盖'
    : view.source === 'group' ? `该群指定（${view.active || '内置默认'}）`
      : view.source === 'global' ? `继承全局（${view.active}）` : '内置默认';
  return `<select data-act="groupPersona" data-group="${esc(row.id)}" aria-label="人格卡">${options.join('')}</select>`
    + `<div class="muted">${esc(live)}</div>`;
};

const groupSocialBlock = (row, globalParams) => {
  const social = row.social;
  if (!social) return `<div class="muted">仿真模块不可用，这一群只能设置人格卡与黑话。</div>`;
  const overridden = social.overridden || {};
  const rows = SOCIAL_KEYS.map(item => {
    // `/api/groups` 的 overridden 是「四个字段都在、值是布尔」的形状，
    // 所以这里必须看值，不能用 hasOwnProperty——否则每一行都会被说成「本群自定义」。
    const over = overridden[item.key] === true;
    const value = social[item.key] !== undefined ? social[item.key] : (globalParams[item.key] ?? '');
    const clear = over
      ? ` <button class="btn btn-sm" data-act="groupSocialInherit" data-group="${esc(row.id)}" data-key="${item.key}" title="清除该群覆盖，改回继承全局">清除</button>`
      : '';
    return `<label class="lbl" for="g-${item.key}-${esc(row.id)}">${item.label}
      <input id="g-${item.key}-${esc(row.id)}" type="number" min="${item.min}" max="${item.max}" step="1" value="${esc(value)}">
      <span class="muted">${over ? `${badge('本群自定义', 'warn')}${clear}` : `继承全局（${esc(globalParams[item.key] ?? DASH)}）`}</span>
    </label>`;
  });
  return `<div class="form form-inline">${rows.join('')}</div>`
    + `<div class="toolbar"><button class="btn btn-sm btn-primary" data-act="groupSocialSave" data-group="${esc(row.id)}">保存仿真参数</button></div>`;
};

const groupCard = (row, chars, globalActive, globalParams) => {
  const social = row.social;
  const socialOn = Boolean(social && social.enabled);
  const slang = row.slang;
  const slangOn = Boolean(slang && slang.enabled);
  const slangNote = !slang ? '<div class="muted">黑话模块不可用。</div>'
    : `<div class="muted">${slang.override === null || slang.override === undefined
      ? `继承全局（${slangOn ? '当前开启' : '当前关闭'}）`
      : `该群已单独指定（${slangOn ? '开启' : '关闭'}）`}，适用词条 ${num(slang.terms ?? 0)} 条。</div>`;
  const socialSwitch = social
    ? `<div class="row between"><span>仿真（自己判断要不要接话）</span><button class="sw${socialOn ? ' sw-on' : ''}" role="switch" aria-checked="${socialOn}" data-act="groupSocialToggle" data-group="${esc(row.id)}" data-on="${socialOn ? '1' : '0'}" aria-label="仿真开关"><span class="sw-knob"></span></button></div>`
    : '';
  const slangSwitch = slang
    ? `<div class="row between"><span>黑话</span><button class="sw${slangOn ? ' sw-on' : ''}" role="switch" aria-checked="${slangOn}" data-act="groupSlangToggle" data-group="${esc(row.id)}" data-on="${slangOn ? '1' : '0'}" aria-label="黑话开关"><span class="sw-knob"></span></button></div>`
    : '';
  return card(`群 ${row.id}`, '', `<div class="form">`
    + `<label class="lbl">人格卡${groupPersonaRow(row, chars, globalActive)}</label>`
    + socialSwitch + groupSocialBlock(row, globalParams)
    + slangSwitch + slangNote
    + `<div class="toolbar"><button class="btn btn-sm" data-act="groupReset" data-group="${esc(row.id)}">恢复该群默认</button></div>`
    + `</div>`);
};

pages.groups = async () => {
  const d = await api('/api/groups');
  const chars = d.personas?.characters ?? [];
  const globalActive = d.personas?.active ?? '';
  const globalParams = d.socialGlobal ?? { threshold: DASH, cooldownSeconds: DASH, dailyLimit: DASH };
  const list = Array.isArray(d.groups) ? d.groups : [];
  const socialOn = list.filter(row => row.social?.enabled).length;
  const slangOn = list.filter(row => row.slang?.enabled).length;
  const custom = list.filter(row => row.persona?.source === 'group'
    || Object.values(row.social?.overridden || {}).some(Boolean)
    || (row.slang?.override !== null && row.slang?.override !== undefined)).length;
  const banner = groupState.notice
    ? alertBox(groupState.bad ? 'err' : 'ok', groupState.bad ? '没有成功' : '完成', esc(groupState.notice))
    : '';
  const stats = `<div class="g4">${[
    stat('已登记群', num(list.length), '由仿真与黑话自动登记'),
    stat('仿真已开', num(socialOn), '本群自己判断接话'),
    stat('黑话已开', num(slangOn), '适用词条生效中'),
    stat('有单独设置', num(custom), '未覆盖的字段继承全局'),
  ].join('')}</div>`;
  const body = list.length
    ? `<div class="g2">${list.map(row => groupCard(row, chars, globalActive, globalParams)).join('')}</div>`
    : card('还没有群', '群号由仿真与黑话在运行时自动登记', alertBox('info', '怎么出现群',
      '在群里让机器人跑一次（被 @ 或触发关键词）后，这一页就会出现该群。控制台没有手动新增群号的入口。'));
  return pageHead('群管理', '按群覆盖人格卡、仿真参数与黑话开关，未覆盖的字段继承全局。')
    + `<div id="groups-notice">${banner}</div>` + stats + body;
};

REPAINT.groups = () => {};
