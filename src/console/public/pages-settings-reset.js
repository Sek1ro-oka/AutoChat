/* 危险区：把本实例的配置、运行状态与学习数据恢复成初始状态。
 *
 * 「一键重置」最容易被读成「连人格一起清」，所以确认框必须把「会保留」与
 * 「会被清空」并排摆出来。它用原生 <dialog>：CSP 不许内联 on*，而
 * window.confirm 只画得出一句话、放不下两栏。两栏布局复用 console.css 的
 * .grid，<dialog> 自己只有 dialog.dlg 一条样式。
 *
 * 后端是 POST /api/config/reset（src/console/reset.js）：人格卡（active_persona /
 * group_persona:*）、.env、聊天记录、账本、说说都不动；返回四个被删的行数。
 */

// 会被清空的四类：运行参数、开关状态、学习数据、当天的各种计数。
const RESET_CLEAR = [
  '控制台改过的所有运行参数（预算、模型、白名单、防刷屏、戳一戳、空间说说…）',
  '机器人开关、群回复开关、模型档位',
  '词库（词条与按群生效范围）、表情库',
  '仿真参数与今日计数、搜索计数、戳一戳计数、防刷屏冷却',
];

// 会保留的四类：人格、启动期密钥、历史，以及表情的图片文件——重置只删库里的行，
// 磁盘上的图不动，这一句是为了不让人把「清空表情库」读成「删掉图片」。
const RESET_KEEP = [
  '人格卡与当前选中的人格',
  'API Key、模型地址等 .env 里的密钥与启动配置',
  '聊天记录、计费账目、空间说说历史',
  '表情包图片文件留在磁盘上，只清库里的行',
];

const resetColumn = (title, items) =>
  `<div><strong>${esc(title)}</strong><ul class="muted">`
  + `${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`;

// 确认框跟着卡片一起渲染：页面重绘时它自然消失，不需要额外的清理状态。
const resetDialog = () =>
  '<dialog class="dlg" id="reset-dialog" aria-labelledby="reset-title">'
  + '<h3 id="reset-title">确认重置全部配置？</h3>'
  + `<div class="grid">${resetColumn('会被清空', RESET_CLEAR)}${resetColumn('会保留', RESET_KEEP)}</div>`
  + '<p class="fhint">执行后页面自动刷新；清空不可撤销，改过的值要重新在设置页填一遍。</p>'
  + '<div class="row"><span class="spacer"></span>'
  + '<button type="button" class="btn" data-act="configResetCancel">取消</button>'
  + '<button type="button" class="btn btn-danger" data-act="configResetGo">确认重置</button>'
  + '</div></dialog>';

// 危险区卡片放在设置页最底部：翻表单时不会顺手点到它。
const resetCard = () => card('一键重置配置',
  '配置、运行状态与学习数据恢复初始状态；人格卡与 API Key 不受影响',
  '<div class="row between"><span class="fhint">清空后不可撤销：控制台改过的参数要重新填一遍。'
  + '人格卡、.env 与聊天记录都不动。</span>'
  + '<button type="button" class="btn btn-danger" data-act="configReset">一键重置配置</button></div>'
  + resetDialog(),
  badge('危险', 'err'));

const resetNode = () => document.getElementById('reset-dialog');

const resetClose = () => {
  const dialog = resetNode();
  if (dialog && typeof dialog.close === 'function') dialog.close();
};

// 只有确认框真的弹得出来才继续：浏览器没有 <dialog> 时宁可什么都不做，
// 也不能把「点一下」变成「直接删」。
action('configReset', () => {
  const dialog = resetNode();
  if (!dialog || typeof dialog.showModal !== 'function') {
    toast('这个浏览器不支持弹窗确认，为了安全这里不会直接删数据');
    return;
  }
  dialog.showModal();
});

action('configResetCancel', () => resetClose());

action('configResetGo', async (button) => {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '正在重置…';
  try {
    const result = await post('/api/config/reset', {});
    resetClose();
    toast(`已重置：配置 ${num(result && result.settings)} 项、词库 ${num(result && result.slang)} 条、`
      + `表情 ${num(result && result.stickers)} 张`);
    rerender();
  } catch (error) {
    toast(reason(error), 'err');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
