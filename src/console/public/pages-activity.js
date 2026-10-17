/* 动态（仿真）。全局参数可写（POST /api/social/config 不带 group 即全局），
 * 但运行期只有 7 个字段能写：阈值/冷却/每日上限/插话三项的开关与上下限；
 * 上下文条数、分段数、打字延迟、消息保留来自配置文件，只读展示。
 */

const ACTIVITY_PARAMS = [
  ['threshold', '相关度阈值', v => num(v)],
  ['cooldownSeconds', '发言冷却', v => `${num(v)} 秒`],
  ['dailyLimit', '每日上限', v => `${num(v)} 条`],
  ['contextMessages', '上下文条数', v => num(v)],
  ['maxChunks', '最多分段', v => num(v)],
  ['minDelayMs', '最短打字延迟', v => `${num(v)} 毫秒`],
  ['maxDelayMs', '最长打字延迟', v => `${num(v)} 毫秒`],
  ['messageTtlHours', '消息保留', v => `${num(v)} 小时`],
  ['idleEnabled', '看气氛插话', v => (v ? '已开启' : '已关闭')],
  ['idleMinutes', '插话最短空闲', v => `${num(v)} 分钟`],
  ['idleHours', '插话最长空闲', v => `${num(v)} 小时`],
];

// 可写的五项数字 + 一个开关，键名就是 POST /api/social/config 的字段名。
const ACTIVITY_EDITABLE = [
  ['threshold', '相关度阈值', '0.01', '0 到 1 之间；越高越难开口。'],
  ['cooldownSeconds', '发言冷却（秒）', '1', '同一群里两次发言之间至少隔这么久。'],
  ['dailyLimit', '每日上限（条）', '1', '0 等于这个群今天不再发言。'],
  ['idleMinutes', '插话最短空闲（分钟）', '1', '群里安静够久才可能被当成「气氛到了」。'],
  ['idleHours', '插话最长空闲（小时）', '1', '超过这个时长就不插话了，避免冷场硬接。'],
];

const ACTIVITY_STATE = {
  active: '活跃',
  idle: '空闲',
  resting: '休息中',
  muted: '已静音',
  off: '已关闭',
  unknown: DASH,
};

const activityDecision = decision => {
  if (!decision) return DASH;
  const reason = decision.reason || '未记录';
  const parts = [`原因：${reason}`];
  if (decision.score !== undefined && decision.score !== null) parts.push(`分数 ${num(decision.score)}`);
  if (decision.need !== undefined && decision.need !== null) parts.push(`门槛 ${num(decision.need)}`);
  return parts.join(' · ');
};

const activityRow = row => {
  const at = row.lastSpokeAt ? time(row.lastSpokeAt) : '还没有发过';
  const state = ACTIVITY_STATE[row.state] || row.state || DASH;
  const energy = row.energy === undefined || row.energy === null ? DASH : num(row.energy);
  return [
    `<span class="mono">${esc(row.id)}</span>`,
    row.enabled === false ? badge('已关闭', 'err') : badge(state, row.enabled === false ? 'err' : 'ok'),
    esc(energy),
    esc(`${num(row.spokeToday ?? 0)} / ${num(row.dailyLimit ?? 0)}`),
    esc(at),
    `<span class="muted">${esc(activityDecision(row.decision))}</span>`,
  ];
};

pages.activity = async () => {
  const d = await api('/api/social');
  if (!d.available) {
    return pageHead('动态', '仿真模块没有启用。')
      + alertBox('info', '这一页现在没有数据', '仿真模块未启用时不会记录任何群状态。启用后这里会显示每个群的能量、今日发言与最近一次判断。');
  }
  const params = d.params || {};
  const groups = Array.isArray(d.groups) ? d.groups : [];
  const spoken = groups.filter(row => num(row.spokeToday ?? 0) > 0).length;
  const blockedByGate = d.gate?.core === false ? '核心未就绪' : d.gate?.group === false ? '群门禁未通过' : '门禁已通过';
  const stats = `<div class="g4">${[
    stat('今日已发言群', num(spoken), `共 ${num(groups.length)} 个群在册`),
    stat('总开关', d.enabled ? '已开启' : '已关闭', '在群管理里按群开'),
    stat('门禁', blockedByGate, '核心与群条件同时满足才发言'),
    stat('今日记录', num(d.today?.spoke ?? 0), `第 ${num(d.today?.day ?? 0)} 天`),
  ].join('')}</div>`;

  const rows = groups.map(activityRow);
  // 注意：局部变量不能叫 table——它会遮蔽 core.js 的 table() 助手（TDZ 直接抛错）。
  const tableHtml = table(['群', '状态', '能量', '今日 / 上限', '最近发言', '最近判断'], rows,
    { empty: '还没有任何群被登记。让机器人先在群里跑一次。' });

  const editable = ACTIVITY_EDITABLE.map(([key, label, step, hint]) => field(label, `social.${key}`,
    `<input type="number" id="act-${key}" step="${step}" min="0" value="${esc(String(params[key] ?? ''))}">`
    + `<button type="button" class="btn btn-sm" data-act="activitySave" data-value="${key}">保存</button>`, hint));
  const idle = field('看气氛插话', 'social.idleEnabled',
    sw(params.idleEnabled === true, '看气氛插话', 'data-act="activityToggle" data-value="idleEnabled"'),
    '群里安静到「插话最短空闲」之后，主动接一句。');
  const fixed = card('来自配置文件（只读）', '这几个值没有运行期写入路径',
    kv(ACTIVITY_PARAMS.filter(([key]) => !isEditable(key)).map(([key, label, fmt]) => [label, esc(fmt(params[key]))])));

  return pageHead('动态', '每个群的仿真状态、能量与最近一次判断依据。')
    + stats + tableHtml
    + card('全局参数', '改这里影响所有没做按群覆盖的群；按群覆盖请去「群管理」', editable.concat(idle).join(''))
    + fixed;
};

const isEditable = key => key === 'idleEnabled' || ACTIVITY_EDITABLE.some(([name]) => name === key);

// 数字字段只收「不小于 0 的数」；不合法就标红并让调用方别发请求。
const activityValue = key => {
  const input = document.getElementById(`act-${key}`);
  if (!input) return null;
  input.classList.remove('is-invalid');
  const raw = String(input.value ?? '').trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value) || value < 0) {
    input.classList.add('is-invalid');
    return null;
  }
  return value;
};

action('activitySave', async button => {
  const key = button.dataset.value;
  const value = activityValue(key);
  if (value === null) {
    toast('请填一个不小于 0 的数字', 'err');
    return;
  }
  await post('/api/social/config', { [key]: value });
  toast('已保存，新的参数立刻生效', 'ok');
  rerender();
});

action('activityToggle', async button => {
  const on = button.getAttribute('aria-checked') !== 'true';
  await post('/api/social/config', { [button.dataset.value]: on });
  toast(on ? '已开启看气氛插话' : '已关闭看气氛插话', 'ok');
  rerender();
});

REPAINT.activity = () => {};
