/* 花费：账本页。数据全部来自 /api/cost（按 range 聚合）、/api/charges（最近几天的预算占用）
 * 与 /api/cost/turns（点开某个会话时看逐轮）。不改任何计价逻辑，只把已有的数字摆出来。
 */

const costState = { range: '', session: '', turns: null };

const COST_BUCKET = { peak: '峰时', off: '谷时' };

const costRange = (d) => {
  const ranges = Array.isArray(d.ranges) ? d.ranges : [];
  if (!ranges.length) return '';
  const options = ranges.map((item) => {
    const value = typeof item === 'string' ? item : String(item && item.value || '');
    const label = typeof item === 'string' ? item : String(item && item.label || value);
    return { value, label };
  });
  return `<div class="toolbar">${seg(options, costState.range || d.range, 'costRange')}</div>`;
};

// 分桶时间戳是桶的起点（按北京时间对齐）：小时桶「02-13 14时」，日桶「02-13」。
const costPad = value => String(value).padStart(2, '0');
const costLabel = (t, unit) => {
  const at = new Date(Number(t));
  const day = `${costPad(at.getMonth() + 1)}-${costPad(at.getDate())}`;
  return unit === 'hour' ? `${day} ${costPad(at.getHours())}时` : day;
};

// 三张卡要说清「从哪天几点开始算」，用北京时间的 MM-DD HH 时，别塞一整串 toLocaleString。
const costStamp = value => {
  const t = Number(value);
  if (!Number.isFinite(t)) return DASH;
  const d = new Date(t + 8 * 3600000);
  return `${costPad(d.getUTCMonth() + 1)}-${costPad(d.getUTCDate())} ${costPad(d.getUTCHours())} 时`;
};

// 今日／本周／本月共用 totals 的那套字段（后端 api-cost.js 的 metrics()），所以三张卡口径一致。
const costCards = d => {
  const cards = d.cards || {};
  const one = (title, card) => (card
    ? stat(title, cny(card.totalMicro), `${num(card.calls)} 次调用 · 从 ${costStamp(card.since)}`)
    : stat(title, DASH, '后端未提供区间聚合'));
  return `<div class="grid g3">${one('今日花费', cards.today)}${one('本周花费', cards.week)}${one('本月花费', cards.month)}</div>`;
};

const WEEKDAY = [DASH, '一', '二', '三', '四', '五', '六', '日'];

// 7 × 24 = 168 格。档次按「调用次数」分，不按钱：钱是长尾的，按钱分档绝大多数格子会挤在最低档。
const costHeat = d => {
  const heat = d.heatmap || {};
  const rows = Array.isArray(heat.rows) ? heat.rows.filter(row => Array.isArray(row.hours)) : [];
  const sub = '近 28 天 · 7 × 24 = 168 格 · 悬停看次数与花费';
  if (!rows.length) return card('星期 × 小时 活跃热力', sub, `<p class="muted">还没有可画的数据：日志里没有花费记录时，这里的 168 格全是空的。</p>`);
  const max = rows.reduce((top, row) => row.hours.reduce((t, cell) => Math.max(t, Number(cell?.calls) || 0), top), 0);
  const level = calls => (!calls || max <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(calls * 5 / max))));
  const today = ((new Date(Date.now() + 8 * 3600000).getUTCDay() + 6) % 7) + 1;
  const head = '<div class="hm-h"></div>' + Array.from({ length: 24 }, (_, h) => `<div class="hm-h">${h}</div>`).join('');
  const body = rows.map(row => {
    const label = `<div class="hm-label">周${WEEKDAY[row.weekday] || DASH}</div>`;
    const cells = row.hours.map((cell, h) => {
      const calls = Number(cell?.calls) || 0;
      const tip = `周${WEEKDAY[row.weekday] || DASH} ${h} 时 · ${num(calls)} 次 · ${cny(Number(cell?.totalMicro) || 0)}`;
      return `<div class="hm-cell hm-l${level(calls)}" title="${esc(tip)}"></div>`;
    }).join('');
    // display:contents 让这个包裹层不参与 grid 排布，但 .hm-row-today .hm-label 仍然选得中。
    return `<div class="hm-row${row.weekday === today ? ' hm-row-today' : ''}">${label}${cells}</div>`;
  }).join('');
  const legend = '<div class="hm-legend">少'
    + [0, 1, 2, 3, 4, 5].map(n => `<span class="swatch hm-l${n}"></span>`).join('')
    + '多<span>按「调用次数」分 5 档；橙色行名＝今天（北京时间）</span></div>';
  return card('星期 × 小时 活跃热力', sub, `<div class="hm" role="img" aria-label="近 28 天星期 × 小时活跃热力图">${head}${body}</div>${legend}`, badge('cells: 168', 'muted'));
};

// 花费走势：设计稿的柱状图是 div + CSS（.bars/.bar-track/.bar-fill），不是 SVG。
// 高度只能由 CSSOM 写（CSP 禁内联 style），见下面 costPaint。
const costChart = d => {
  const series = Array.isArray(d.series) ? d.series : [];
  if (!series.length) return card('花费走势', '', '<div class="empty">这个区间还没有分桶数据。</div>');
  const unit = d.unit === 'hour' ? '小时' : '天';
  const max = Math.max(1, ...series.map(point => Number(point.totalMicro) || 0));
  const dense = series.length > 10;
  const every = Math.max(1, Math.ceil(series.length / 7));
  const last = series.length - 1;
  const bars = series.map((point, index) => {
    const total = Number(point.totalMicro) || 0;
    const peak = Number(point.peakMicro) || 0;
    const off = Number(point.offMicro) || 0;
    const percent = total > 0 ? Math.max(4, Math.round((total / max) * 100)) : 0;
    const isNow = index === last;
    const when = costLabel(point.t, d.unit);
    const hint = `${when}\n花费 ${cny(total)}（峰时 ${cny(peak)} · 谷时 ${cny(off)}）`
      + `\n命中 ${num(point.hit)} · 未命中 ${num(point.miss)} · 输出 ${num(point.out)}（token）`
      + `\n调用 ${num(point.calls)} 次`;
    const label = index % every === 0 || isNow ? `${when}${isNow && d.unit !== 'hour' ? ' 今天' : ''}` : '&nbsp;';
    return `<div class="bar-col${isNow ? ' is-today' : ''}" title="${esc(hint)}">`
      + (dense ? '' : `<div class="bar-value">${total > 0 ? cny(total) : DASH}</div>`)
      + `<div class="bar-track"><div class="bar-fill${isNow ? ' is-today' : ''}" data-bar="${percent}"></div></div>`
      + `<div class="bar-label">${label}</div></div>`;
  }).join('');
  // 图例的小方块和柱子共用 --chart-1（普通桶）/ --chart-4（当前桶）：颜色只在这里说一次。
  const legend = `<div class="legend"><span class="swatch"></span>每${unit}花费`
    + `<span class="swatch swatch-today"></span>${d.unit === 'hour' ? '当前小时' : '今天'}</div>`;
  return card(`花费走势（每${unit}）`,
    `${d.range} · ${num(series.length)} 桶 · 纵轴按区间峰值自适应；悬停柱子看峰谷明细。`,
    `<div class="bars${dense ? ' dense' : ''}" role="img" aria-label="花费走势">${bars}</div>` + legend);
};

// app.js 的 paintWidths 只处理 [data-width]，而 CSP 不许内联 style，所以柱高挂载后由这里补；
// render() 是同步写 innerHTML，0 毫秒定时器一定排在挂载之后。
const costPaint = () => {
  for (const node of document.querySelectorAll('[data-bar]')) {
    node.style.height = `${Number(node.dataset.bar) || 0}%`;
  }
};

const costMeter = (totals) => {
  const hit = Number(totals.hit) || 0;
  const miss = Number(totals.miss) || 0;
  const total = hit + miss;
  if (!total) return DASH;
  return `${((hit / total) * 100).toFixed(1)}%`;
};

// core.js 的 table(headers, rows) 吃「每行一个单元格数组」；这三张表原来传整行 <tr> 字符串，
// 只要有一条会话 / 逐轮 / 预算占用记录就会 TypeError: cells.map is not a function，整页渲染失败。
const costSessionRow = row => [
  `<span class="mono">${esc(String(row.session || '').slice(0, 12))}</span>`,
  num(row.turns),
  num(row.calls),
  `${num(row.hit)} / ${num(row.miss)}`,
  num(row.out),
  `<strong>${cny(row.totalMicro)}</strong>`,
  `<button type="button" class="btn" data-act="costTurns" data-session="${esc(row.session)}">逐轮</button>`,
];

const costTurnRow = row => [
  num(row.turn),
  row.at ? time(row.at) : DASH,
  num(row.calls),
  `${num(row.hit)} / ${num(row.miss)}`,
  num(row.out),
  row.totalMicro === 0 ? '<span class="muted">免费</span>' : cny(row.totalMicro),
];

const costCharges = (d) => {
  const days = Array.isArray(d && d.days) ? d.days : [];
  if (!days.length) return '<div class="empty">最近几天还没有记账，第一次调用模型后这里就会出现。</div>';
  const rows = days.map(row => [
    esc(String(row.day || '')),
    num(row.calls),
    cny(row.used),
    cny(row.held),
  ]);
  return table(['日期', '调用', '已花', '占用中的额度'], rows);
};

/* --- 多实例对照（T-035）---------------------------------------------------
 * 这张卡只读：数据来自 /api/instances（hub 自己缓存 5 秒，core.js 再缓 5 秒）。
 * 读不到的库一律 DASH —— 「没读到」不许写成 0，那会把缺库说成没花钱。
 */
const costInstanceRow = row => {
  const [level, state] = instanceState(row);
  return [
    `<span class="mono">${esc(row.name)}</span>`,
    dot(level) + esc(state),
    instanceMoney(row, 'today'),
    instanceMoney(row, 'week'),
    instanceMoney(row, 'month'),
    instanceNote(row) || DASH,
  ];
};

// 合计行：全实例取 aggregate，单实例视角取那一行自己的三张卡（合计只累加 ok 行是 hub 的口径）。
const costInstancesTotal = (data, rows) => {
  const all = INSTANCE_SCOPE.name === 'all';
  const cards = all ? (data && data.aggregate) || {} : (rows[0] && rows[0].cards) || {};
  const money = key => instanceMoney({ ok: true, cards }, key);
  return [
    `<b>合计</b> ${badge(all ? '全实例' : '该实例', 'brand')}`,
    DASH,
    money('today'),
    money('week'),
    money('month'),
    DASH,
  ];
};

const costInstances = data => {
  const rows = instanceRows(data);
  const empty = INSTANCE_SCOPE.name === 'all' ? '这是唯一的一台' : '这个实例已经不在了';
  const body = rows.length
    ? table(['实例', '状态', '今日', '本周', '本月', '备注'], [...rows.map(costInstanceRow), costInstancesTotal(data, rows)])
    : `<div class="empty">${empty}</div>`;
  const head = INSTANCE_SCOPE.name === 'all'
    ? ''
    : alertBox('info', '现在只看一个实例', '切换器只筛这张表与「实例管理」卡；其它页面仍是本实例的数据。');
  return card('多实例对照', '合计只累加能读到的库；切换器只筛本表与「实例管理」卡', head + body);
};

const pages_costBody = (d, charges, instances = '') => {
  const totals = d.totals || {};
  const pricing = d.pricing || {};
  const sessions = Array.isArray(d.sessions) ? d.sessions : [];
  const recent = Array.isArray(d.recent) ? d.recent : [];
  const detail = costState.session
    ? card(`会话 ${costState.session.slice(0, 12)} 的逐轮明细`, '', costState.turns === null
      ? '<div class="empty">正在读…</div>'
      : table(['轮', '时间', '调用', '命中 / 未命中（token）', '输出（token）', '花费'],
        (costState.turns || []).map(costTurnRow), { empty: '这个会话还没有记账。' }),
    `<button type="button" class="btn" data-act="costTurns" data-session="">收起</button>`)
    : '';
  return `<div class="grid g4">
      ${stat('区间合计', cny(totals.totalMicro), `${num(totals.calls)} 次调用 / ${num(totals.turns)} 轮`)}
      ${stat('平均每轮', cny(totals.avgTurnMicro), `平均每次调用 ${cny(totals.avgCallMicro)}`)}
      ${stat('缓存命中', costMeter(totals), `命中 ${num(totals.hit)} / 未命中 ${num(totals.miss)}（token）`)}
      ${stat('谷时花费', cny(totals.offMicro), `峰时 ${cny(totals.peakMicro)}`)}
    </div>`
    + costRange(d)
    + costCards(d)
    + costHeat(d)
    + costChart(d)
    + card('每日预算占用', '', costCharges(charges))
    + card('按会话', `${num(sessions.length)} 个会话`, table(
      ['会话', '轮数', '调用', '命中 / 未命中（token）', '输出（token）', '花费', ''],
      sessions.map(costSessionRow), { empty: '这个区间里还没有花过钱。' }))
    + detail
    + card('最近的调用', `${num(recent.length)} 条`, table(
      ['时间', '会话', '轮', '时段', '命中 / 未命中（token）', '花费'],
      recent.map(row => [
        row.at ? time(row.at) : DASH,
        `<span class="mono">${esc(String(row.session || '').slice(0, 12))}</span>`,
        num(row.turn),
        badge(COST_BUCKET[row.bucket] || row.bucket || DASH, row.bucket === 'off' ? 'ok' : 'muted'),
        `${num(row.hit)} / ${num(row.miss)}`,
        row.costMicro === 0 ? '<span class="muted">免费</span>' : cny(row.costMicro),
      ]), { empty: '没有符合区间的调用。' }))
    + card('计价规则', '以 model-profiles 里的单价为准', kv([
      ['输入', pricing.inputPrice === undefined ? DASH : `${cny(pricing.inputPrice)} / 百万 token`],
      ['输出', pricing.outputPrice === undefined ? DASH : `${cny(pricing.outputPrice)} / 百万 token`],
      ['缓存命中', pricing.cacheHitPrice === undefined ? DASH : `${cny(pricing.cacheHitPrice)} / 百万 token`],
      ['谷时折扣', pricing.offPeakRatio === undefined ? DASH : `${(Number(pricing.offPeakRatio) * 10).toFixed(1)} 折`],
      ['统计区间', d.range ? `${esc(String(d.range))}（${time(d.since)} 起）` : DASH],
    ]))
    + instances;
};

pages.cost = async () => {
  const head = pageHead('花费', '按量计费：每次调用都记账，缓存命中与谷时折扣各按各的价，不做估算。');
  const query = costState.range ? `?range=${encodeURIComponent(costState.range)}` : '';
  let d;
  try {
    d = await api(`/api/cost${query}`);
  } catch (error) {
    return head + alertBox('err', '读不到账本', reason(error));
  }
  if (!d || typeof d !== 'object') return head + alertBox('warn', '账本还是空的', '还没有任何调用记录。');
  if (!costState.range && d.range) costState.range = String(d.range);
  let charges = null;
  try {
    charges = await api('/api/charges');
  } catch (error) {
    charges = { days: [] };
  }
  // 实例列表读不到不该把整页拖垮：退一条横幅，本实例的账照常画。
  let instances = '';
  try {
    instances = costInstances(await loadInstances());
  } catch (error) {
    instances = alertBox('warn', '读不到实例列表', reason(error));
  }
  const html = head + pages_costBody(d, charges, instances);
  setTimeout(costPaint, 0);
  return html;
};

action('costRange', (button) => {
  costState.range = button.dataset.value || '';
  costState.session = '';
  costState.turns = null;
  rerender();
});

action('costTurns', async (button) => {
  const session = button.dataset.session || '';
  if (!session) {
    costState.session = '';
    costState.turns = null;
    rerender();
    return;
  }
  costState.session = session;
  costState.turns = null;
  rerender();
  try {
    const d = await api(`/api/cost/turns?session=${encodeURIComponent(session)}`);
    costState.turns = Array.isArray(d && d.turns) ? d.turns : [];
  } catch (error) {
    costState.turns = [];
    toast(reason(error), 'err');
  }
  rerender();
});
