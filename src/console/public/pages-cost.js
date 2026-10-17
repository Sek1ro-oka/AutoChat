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

const costSessionRow = (row) => `<tr>
    <td><span class="mono">${esc(String(row.session || '').slice(0, 12))}</span></td>
    <td class="nowrap">${num(row.turns)}</td>
    <td class="nowrap">${num(row.calls)}</td>
    <td class="nowrap">${num(row.hit)} / ${num(row.miss)}</td>
    <td class="nowrap">${num(row.out)}</td>
    <td class="nowrap"><strong>${cny(row.totalMicro)}</strong></td>
    <td class="nowrap"><button type="button" class="btn" data-act="costTurns" data-session="${esc(row.session)}">逐轮</button></td>
  </tr>`;

const costTurnRow = (row) => `<tr>
    <td class="nowrap">${num(row.turn)}</td>
    <td class="nowrap">${row.at ? time(row.at) : DASH}</td>
    <td class="nowrap">${num(row.calls)}</td>
    <td class="nowrap">${num(row.hit)} / ${num(row.miss)}</td>
    <td class="nowrap">${num(row.out)}</td>
    <td class="nowrap">${row.totalMicro === 0 ? '<span class="muted">免费</span>' : cny(row.totalMicro)}</td>
  </tr>`;

const costCharges = (d) => {
  const days = Array.isArray(d && d.days) ? d.days : [];
  if (!days.length) return '<div class="empty">最近几天还没有记账，第一次调用模型后这里就会出现。</div>';
  const rows = days.map((row) => `<tr>
      <td class="nowrap">${esc(String(row.day || ''))}</td>
      <td class="nowrap">${num(row.calls)}</td>
      <td class="nowrap">${cny(row.used)}</td>
      <td class="nowrap">${cny(row.held)}</td>
    </tr>`);
  return table(['日期', '调用', '已花', '占用中的额度'], rows);
};

const pages_costBody = (d, charges) => {
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
    + costChart(d)
    + card('每日预算占用', '', costCharges(charges))
    + card('按会话', `${num(sessions.length)} 个会话`, table(
      ['会话', '轮数', '调用', '命中 / 未命中（token）', '输出（token）', '花费', ''],
      sessions.map(costSessionRow), { empty: '这个区间里还没有花过钱。' }))
    + detail
    + card('最近的调用', `${num(recent.length)} 条`, table(
      ['时间', '会话', '轮', '时段', '命中 / 未命中（token）', '花费'],
      recent.map((row) => `<tr>
        <td class="nowrap">${row.at ? time(row.at) : DASH}</td>
        <td><span class="mono">${esc(String(row.session || '').slice(0, 12))}</span></td>
        <td class="nowrap">${num(row.turn)}</td>
        <td class="nowrap">${badge(COST_BUCKET[row.bucket] || row.bucket || DASH, row.bucket === 'off' ? 'ok' : 'muted')}</td>
        <td class="nowrap">${num(row.hit)} / ${num(row.miss)}</td>
        <td class="nowrap">${row.costMicro === 0 ? '<span class="muted">免费</span>' : cny(row.costMicro)}</td>
      </tr>`), { empty: '没有符合区间的调用。' }))
    + card('计价规则', '以 model-profiles 里的单价为准', kv([
      ['输入', pricing.inputPrice === undefined ? DASH : `${cny(pricing.inputPrice)} / 百万 token`],
      ['输出', pricing.outputPrice === undefined ? DASH : `${cny(pricing.outputPrice)} / 百万 token`],
      ['缓存命中', pricing.cacheHitPrice === undefined ? DASH : `${cny(pricing.cacheHitPrice)} / 百万 token`],
      ['谷时折扣', pricing.offPeakRatio === undefined ? DASH : `${(Number(pricing.offPeakRatio) * 10).toFixed(1)} 折`],
      ['统计区间', d.range ? `${esc(String(d.range))}（${time(d.since)} 起）` : DASH],
    ]));
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
  const html = head + pages_costBody(d, charges);
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
