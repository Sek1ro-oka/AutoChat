/* 概览：运行状态、总开关、预算、健康、最近事件、会话。
 * 数据全部来自 /api/summary + /api/settings + /api/logs + /api/sessions，一个都不编。
 */

// 这四个布尔项是真能写的（都登记在 runtime-config 的 FIELDS 里，走 POST /api/settings）。
const WRITABLE_SWITCHES = [
  ['webSearchEnabled', '联网搜索', '关掉之后模型不再调用搜索，省 token 也省等待。'],
  ['visionEnabled', '图片识别', '关掉之后带图消息只按文字处理。'],
  ['antiSpamEnabled', '防刷屏', '关掉之后同一个群的连续刷屏不再被静音。'],
  ['groupManagementEnabled', '群管理命令', '关掉之后群里的 /禁言 这类管理命令不再响应。'],
];

const fieldOf = (settings, name) => (settings.fields || []).find(field => field.name === name) || null;
const isOn = field => String(field && field.value).toLowerCase() === 'true';

const switchCard = settings => {
  const rows = WRITABLE_SWITCHES.map(([name, label, why]) => {
    const field = fieldOf(settings, name);
    if (!field) {
      return switchRow(label, sw(false, label, 'disabled'), '<span class="muted">这个版本的配置里没有这一项。</span>');
    }
    const on = isOn(field);
    const control = sw(on, label, `data-act="setting-toggle" data-name="${esc(name)}"`);
    return switchRow(label, control, `${esc(why)}默认值：${esc(String(field.defaultValue))}。
      <span class="muted">${on ? '现在是开着的。' : '现在是关着的。'}</span>`);
  });
  return catCard('info', '总开关', '改完立刻生效，不用重启', rows.join(''));
};

const readonlySwitches = summary => {
  const switches = summary.switches || {};
  // 停着的时候要把「为什么停的」与「怎么恢复」分开说：自动熔断和手动停止的处理办法
  // 不一样，一句「发 /启动 可以让它继续」会把两者糊成同一件事（E-10）。
  const rows = [
    ['模型回复', switches.enabled
      ? badge('已开启', 'ok') + ' <span class="muted">在 QQ 里发 /停止 可以让它停下来。</span>'
      : badge('已停止', 'err') + ' <span class="muted">'
        + esc(stopRow(switches.enabledReason, '在 QQ 里发 /启动 恢复。')) + '</span>'],
    ['群聊参与', switches.groupEnabled
      ? badge('已开启', 'ok')
      : badge('已关闭', 'muted') + ' <span class="muted">'
        + esc(stopRow(switches.groupEnabledReason, '在 QQ 里发 /群开启 恢复。')) + '</span>'],
  ];
  const note = alertBox('info', '这两项控制台改不了', '它们是 QQ 命令写的运行时状态，不是配置文件项：只能在群里发 /启动 或 /停止。做成开关就是点了没反应的开关。');
  return catCard('info', '模型回复与群聊参与', '只读', kv(rows) + note);
};

const budgetCard = summary => {
  const budget = summary.budget || {};
  const queue = summary.queue || {};
  const used = Number(budget.used || 0);
  const limit = Number(budget.limitMicro || 0);
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const level = percent >= 100 ? 'err' : percent >= 80 ? 'warn' : '';
  const rows = [
    ['账期', esc(budget.day || DASH) + ' <span class="muted">（香港时间）</span>'],
    ['已用', `<span class="money">${cny(used)}</span> / ${cny(limit, 2)}`],
    ['预留中', cny(budget.held)],
    ['剩余', cny(budget.remaining)],
    ['待发队列', num(queue.depth) + ' 条'],
    ['发送失败', num(queue.sendFailures) + ' 次'],
  ];
  // 宽度走 data-width：CSP 是 style-src 'self'，HTML 里的 style="" 会被浏览器丢弃，
  // 所以由 app.js 在写入 innerHTML 之后用 CSSOM（el.style.width）补上。
  const bar = `<div class="progress${level ? ' ' + level : ''}"><i data-width="${percent}"></i></div>`;
  return catCard('money', '预算与队列', '今日账期', bar + kv(rows));
};

const healthCard = summary => {
  const queue = summary.queue || {};
  const switches = summary.switches || {};
  const budget = summary.budget || {};
  const alerts = [];
  if (!switches.enabled) {
    // E-10：这里以前只有一句「/停止 或连续发送失败都会让它停下」，等于把两种
    // 完全不同的故障糊在一起。原因由后端在翻开关时写下，这里照实分开说。
    const info = stopInfo(switches.enabledReason);
    alerts.push(info
      ? alertBox('err', info.alert[0], info.alert[1])
      : alertBox('err', '模型回复已停止', '原因没有记录（可能是旧版本留下的状态）。要恢复，让管理员在 QQ 私聊里发 /启动。'));
  }
  if (Number(queue.sendFailures) > 0) {
    alerts.push(alertBox('warn', `发送失败 ${num(queue.sendFailures)} 次`, '连续 3 次失败会自动停止模型回复。检查 OneBot 连接。'));
  }
  if (Number(budget.remaining) <= 0) {
    alerts.push(alertBox('warn', '预算用完了', '今天的请求会被预算闸门拦下，明天零点（香港时间）重置。'));
  }
  if (!alerts.length) alerts.push(alertBox('ok', '没有发现异常', '连接、预算、发送三个方向都正常。'));
  alerts.push(alertBox('info', '日志级告警在「日志与健康」页',
    '写盘失败、权限失败、黑话导入损坏这类事件只在事件日志里，概览页不去重复统计。'));
  return catCard('money', '健康与告警', '只看 /api/summary 能拿到的信号', alerts.join(''));
};

const eventsCard = entries => {
  const rows = (entries || []).slice(0, 8).map(entry => [
    `<span class="nowrap">${esc(stampOf(entry.time))}</span>`, `<code>${esc(entry.event)}</code>`,
  ]);
  return catCard('data', '最近事件', '来自 /api/logs', rows.length
    ? table(['时间', '事件'], rows)
    : '<div class="empty">日志目录里还没有事件。</div>');
};

// 日志里的 time 是 ISO 字符串（不是毫秒数），所以不能直接用 core.js 的 time()。
const stampOf = value => {
  if (!value) return DASH;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN', { hour12: false });
};

const sessionsCard = sessions => {
  const rows = (sessions || []).map(item => [
    `<code>${esc(item.key)}</code>`, esc(item.scope || DASH), num(item.items),
    `<span class="nowrap">${esc(time(item.updated))}</span>`,
  ]);
  return catCard('data', '会话', '来自 /api/sessions（最近 20 条）', rows.length
    ? table(['会话键', '作用域', { label: '条数', num: true }, '更新时间'], rows)
    : '<div class="empty">还没有会话记录。</div>');
};

const participantsCard = summary => {
  const rows = (summary.participants || []).map(item => [
    `<code>${esc(item.name)}</code>`, { label: num(item.failures), num: true },
    item.lastError ? `<code>${esc(item.lastError)}</code>` : '<span class="muted">—</span>',
  ]);
  return rows.length
    ? table(['参与者', { label: '失败', num: true }, '最后一次错误'], rows)
    : '<div class="empty">没有参与者记录。</div>';
};

const groupsDueCard = summary => {
  const rows = (summary.groups || []).map(item => [
    `<code>${esc(item.id)}</code>`, `<span class="nowrap">${esc(time(item.due))}</span>`,
  ]);
  return catCard('data', '群与下次清理', '来自 /api/summary', rows.length ? table(['群号', '下次清理'], rows) : '<div class="empty">还没有群。</div>');
};

/* --- 服务卡片（T-020）-------------------------------------------------------
 * 后端给三个口子：GET /api/service 读状态，POST /api/service/restart|stop 写。
 * 写接口是先回包、约半秒后自杀，所以点下去页面必然断连几秒 —— 两个按钮都做成二次
 * 确认，把「这一下真的会断线」提前说清楚，而不是点完才让用户自己发现。
 * 「已请求 / 已恢复 / 没恢复」这三个事实只能存在模块状态里：app.js 每 3 秒整块重绘
 * 概览，写进 DOM 的提示活不过一次重绘。
 * 未托管时两个按钮一律 disabled 并把原因写成一句话：那种进程一重启就直接消失、不会
 * 自动回来，做成可点再报错是假承诺；禁用而不解释，用户只会觉得坏了。
 */
const SERVICE_PATH = '/api/service';
const SERVICE_PROBE_MS = 2000;      // 每 2 秒探一次
const SERVICE_GIVE_UP_MS = 30000;   // 30 秒还没回来，就不再假装它会回来
const SERVICE_RECOVERED_MS = 60000; // 「已恢复」挂一分钟够了，挂久了会误导
const SERVICE_ARM_MS = 3000;        // 二次确认 3 秒内不点就复原
const SERVICE_LABEL = { restart: '重启', stop: '停止' };
// 409 只回错误码，翻译成人话是控制台的活（口径与 core.js 的 CODE_TEXT 一致）。
const SERVICE_CODE_TEXT = {
  SERVICE_NOT_MANAGED: '这个进程不是 supervisor 拉起来的：重启会让它直接退出，而且不会自己回来',
};
const SERVICE = { confirm: '', armTimer: null, probeTimer: null, phase: 'idle', action: '', since: 0, error: '', seen: null };

const serviceReason = error => {
  const raw = String((error && error.message) || error || '');
  return SERVICE_CODE_TEXT[raw.replace(/^HTTP \d+\s*/, '')] || reason(error);
};

const serviceManaged = status => Boolean(status && status.managed === true);
const serviceLocked = status => !serviceManaged(status) || SERVICE.phase === 'pending';

// 按钮外观全走类名：CSP 收紧之后不许 style=""，也不许 onclick。
const serviceButton = (action, locked) => {
  const armed = SERVICE.confirm === action;
  const kind = action === 'stop' ? 'btn-danger' : 'btn-primary';
  const text = armed ? `确认${SERVICE_LABEL[action]}？` : SERVICE_LABEL[action];
  return `<button type="button" class="btn ${kind}${armed ? ' is-armed' : ''}" data-act="serviceAction"` +
    ` data-value="${action}"${locked ? ' disabled' : ''}>${esc(text)}</button>`;
};

const serviceFeedback = () => {
  const stopping = SERVICE.action === 'stop';
  if (SERVICE.phase === 'failed') return alertBox('err', '请求没有发出去', SERVICE.error);
  if (SERVICE.phase === 'recovered' && Date.now() - SERVICE.since > SERVICE_RECOVERED_MS) return '';
  if (SERVICE.phase === 'pending') {
    return stopping
      ? alertBox('warn', '已请求停止，进程会在约半秒后退出',
        '停止之后不会有进程自己回来：要用时请用 start.cmd 重新启动。这里每 2 秒确认一次状态。')
      : alertBox('info', '已请求重启，页面将在几秒后自动重连',
        '每 2 秒探一次 /api/service。断连这几秒里页面上别的数字会报错，那是在退出，不是新故障。');
  }
  if (SERVICE.phase === 'recovered') {
    return stopping
      ? alertBox('ok', '已停止', '接口已经不应答，进程应该退出了。要用时请用 start.cmd 重新启动。')
      : alertBox('ok', '已恢复', '接口重新应答，上面的数据是恢复之后重新取回来的。');
  }
  if (SERVICE.phase === 'lost') {
    return stopping
      ? alertBox('err', '停止没有生效', '30 秒后 /api/service 仍在应答：停止请求没让进程退出去，请到 supervisor 窗口看退出码。')
      : alertBox('err', '没有自动恢复，请检查 supervisor 窗口', '等了 30 秒 /api/service 还是不通。进程可能没起来，或者 supervisor 窗口已经关了。');
  }
  return '';
};

const serviceCard = status => {
  // 每次重绘都会重新拿到状态：顺手记下来，事件处理器要用它判断能不能写。
  SERVICE.seen = status || null;
  const managed = serviceManaged(status);
  const locked = serviceLocked(status);
  const rows = [];
  if (status) {
    rows.push(['托管', managed
      ? `${badge('已托管', 'ok')} <span class="muted">有 supervisor 看着它，重启会自动拉回来。</span>`
      : `${badge('未托管', 'warn')} <span class="muted">没有 supervisor 在看着它。</span>`]);
    rows.push(['进程号', status.pid ? `<code>${esc(status.pid)}</code>` : DASH]);
    rows.push(['运行时长', status.uptimeMs ? esc(dur(status.uptimeMs)) : DASH]);
    if (status.supervisorPid) rows.push(['supervisor', `<code>${esc(status.supervisorPid)}</code>`]);
  }
  const body = [
    status ? kv(rows) : '<div class="empty">读不到 /api/service，所以这里没有状态可显示。</div>',
    !status ? alertBox('warn', '拿不到服务状态，两个按钮都禁用',
      '状态读不出来就不给按钮：宁可不给，也不给一个点了会让进程直接消失、还不回来的按钮。') : '',
    status && !managed ? alertBox('warn', '未托管，重启与停止都不可用',
      '当前不是由 supervisor 启动的，重启会让它直接退出、不会自动回来。请用 start.cmd 启动。') : '',
    serviceFeedback(),
    `<div class="row svc-actions">${serviceButton('restart', locked)}${serviceButton('stop', locked)}` +
      `<span class="msg muted">${managed ? '点第一次只是确认，第二次才真的执行。' : '按钮禁用中，原因见上面那行。'}</span></div>`,
  ].join('');
  return catCard('run', '服务', '来自 /api/service', body);
};

// 一次探测：重启等到「接口重新应答」，停止正好相反，等到「接口不再应答」才算停成了。
const serviceProbe = async () => {
  SERVICE.probeTimer = null;
  if (SERVICE.phase !== 'pending') return;
  const stopping = SERVICE.action === 'stop';
  let status = null;
  try {
    status = await api(SERVICE_PATH);
  } catch {
    status = null;
  }
  if (SERVICE.phase !== 'pending') return; // 探测途中又被点了别的动作，以它为准
  if ((status === null) === stopping) {
    SERVICE.phase = 'recovered';
    SERVICE.since = Date.now();
    if (!stopping) rerender(); // 重启回来了：顺手把整页数据重新取一遍
    return;
  }
  if (Date.now() - SERVICE.since >= SERVICE_GIVE_UP_MS) {
    SERVICE.phase = 'lost';
    SERVICE.since = Date.now();
    return;
  }
  SERVICE.probeTimer = setTimeout(serviceProbe, SERVICE_PROBE_MS);
};

action('serviceAction', async element => {
  const wanted = element.dataset.value === 'stop' ? 'stop' : 'restart';
  const label = SERVICE_LABEL[wanted];
  if (!serviceManaged(SERVICE.seen)) {
    toast('这个进程不由 supervisor 管理，控制台不能重启或停止它', 'err');
    return;
  }
  if (SERVICE.phase === 'pending') {
    toast('上一个请求还在等回执，先别重复点', 'err');
    return;
  }
  if (SERVICE.confirm !== wanted) {
    // 第一次点只是把它变成问句：3 秒内再点才算数，超时就自己复原。
    SERVICE.confirm = wanted;
    if (SERVICE.armTimer) clearTimeout(SERVICE.armTimer);
    SERVICE.armTimer = setTimeout(() => {
      SERVICE.armTimer = null;
      SERVICE.confirm = '';
      rerender();
    }, SERVICE_ARM_MS);
    toast(`再点一次才真的${label}`, 'ok');
    rerender();
    return;
  }
  SERVICE.confirm = '';
  if (SERVICE.armTimer) {
    clearTimeout(SERVICE.armTimer);
    SERVICE.armTimer = null;
  }
  if (SERVICE.probeTimer) {
    clearTimeout(SERVICE.probeTimer);
    SERVICE.probeTimer = null;
  }
  SERVICE.phase = 'pending';
  SERVICE.action = wanted;
  SERVICE.since = Date.now();
  SERVICE.error = '';
  try {
    await post(`${SERVICE_PATH}/${wanted}`, {});
  } catch (error) {
    // 409 SERVICE_NOT_MANAGED 之类：说清为什么没做成，并把按钮重新按回禁用态。
    SERVICE.phase = 'failed';
    SERVICE.error = serviceReason(error);
    rerender();
    return;
  }
  SERVICE.since = Date.now(); // 计时从回包那一刻算起，而且这期间按钮一直锁着
  toast(`已请求${label}`, 'ok');
  rerender();
  SERVICE.probeTimer = setTimeout(serviceProbe, SERVICE_PROBE_MS);
});

// 批次 B 的分类强调：色条与胶囊都只靠类名（CSP 不许 style=""）。
// core.js 的 card() 把 <div class="card"> 写死了，本批不动 core.js，所以补类在页面这边做。
const catCard = (kind, title, sub, body) =>
  card(title, sub, body).replace('<div class="card">', `<div class="card cat-${kind}">`);
const pill = (kind, value) => `<span class="pill pill-${kind}">${value}</span>`;

const renderOverview = async () => {
  const [summary, settings, logs, sessions, service] = await Promise.all([
    api('/api/summary'),
    api('/api/settings').catch(() => ({ fields: [] })),
    api('/api/logs?limit=8').catch(() => ({ logs: [] })),
    api('/api/sessions?limit=20').catch(() => ({ sessions: [] })),
    // 读不到就返回 null：卡片会自己收起状态行，不让整页跟着崩。
    api('/api/service').catch(() => null),
  ]);
  applyChips(summary);
  const switches = summary.switches || {};
  const model = summary.model || {};
  const connection = summary.connection || {};
  // 连接状态本身就是语义色：就绪/重连中/断了各一档，不另立"连接"这个分类色。
  const connectionState = connection.ready ? ['ok', '就绪']
    : connection.reconnecting ? ['warn', '重连中'] : ['err', '未连接'];
  const stats = `<div class="grid g4">
    ${stat('运行时长', pill('run', esc(dur(summary.uptimeMs))), '进程启动至今')}
    ${stat('当前模型', pill('info', esc(model.name || DASH)), model.active ? '生效层级：' + model.active : '没有可用模型')}
    ${stat('OneBot 连接', pill(...connectionState),
    connection.reconnecting ? `第 ${num(connection.retry)} 次重试` : connection.ready ? '消息通道正常' : '消息发不出去')}
    ${stat('今日花费', pill('money', cny(summary.budget && summary.budget.used)), '预算 ' + cny(summary.budget && summary.budget.limitMicro, 2))}
  </div>`;
  return `<div class="page active">
    ${pageHead('概览', '机器人现在在做什么、花了多少钱、有没有哪里不对。')}
    ${stats}
    <div class="grid g2">${switchCard(settings)}${readonlySwitches(summary)}</div>
    <div class="grid g2">${budgetCard(summary)}${healthCard(summary)}</div>
    <div class="grid g2">${eventsCard(logs.logs)}${catCard('data', '参与者与发送', '来自 /api/summary', participantsCard(summary))}</div>
    <div class="grid g2">${sessionsCard(sessions.sessions)}${groupsDueCard(summary)}</div>
    ${serviceCard(service)}
  </div>`;
};

action('setting-toggle', async element => {
  const name = element.dataset.name;
  const next = element.getAttribute('aria-checked') !== 'true';
  await post('/api/settings', { name, value: next ? 'true' : 'false' });
  toast(`${next ? '已打开' : '已关闭'}`, 'ok');
  rerender();
});

pages.overview = renderOverview;
