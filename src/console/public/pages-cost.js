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
  return head + pages_costBody(d, charges);
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
