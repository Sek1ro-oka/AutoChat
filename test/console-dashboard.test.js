// Console pure builders and the cost dashboard (I-08: split out of the
// 587-line file). No server is started here — every case is a function call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { buildSummary, buildConfig, buildCost, buildCostTurns, redact } from '../src/console/api.js';

test('summary and config builders are pure and redact secrets', () => {
  const store = new Store();
  const config = { budgetMicro: 500000, model: 'deepseek-flash', apiKey: 'sk-abcdefghijkl',
    onebotToken: 'tok', consoleToken: 'consoletokenvalue' };
  const summary = buildSummary({ config, store, bot: { queued: 3, sendFailures: 1 },
    transport: { ready: false, retry: 2 }, runtime: null, now: 1800000000000, startedAt: 1800000000000 });
  assert.equal(summary.queue.depth, 3);
  assert.equal(summary.connection.ready, false);
  assert.equal(summary.participants.length, 0);
  const built = buildConfig({ config });
  assert.equal(built.credentials.apiKey, 'sk-a••••kl');
  assert.ok(!JSON.stringify(built).includes('sk-abcdefghijkl'));
  assert.equal(redact({ nested: { secretKey: 'value' } }).nested.secretKey, '••••');
  store.close();
});

// D-19 / E-10：这两个字段是新增的。布尔项的意思不变，reason 只解释「为什么」——
// 熔断（send_failures）与手动 /停止（admin_stop）在控制台上必须能分开。
test('the summary carries why a switch is off, without changing what the boolean means', () => {
  const store = new Store();
  const config = { budgetMicro: 500000, model: 'deepseek-flash' };
  const switches = () => buildSummary({ config, store, bot: { queued: 0, sendFailures: 0 },
    transport: { ready: true, retry: 0 }, runtime: null, now: 1800000000000, startedAt: 1800000000000 }).switches;

  assert.equal(switches().enabled, true);
  assert.equal(switches().enabledReason, '', '没停过就没有原因');
  assert.equal(switches().groupEnabledReason, '');

  store.set('enabled', '0'); store.set('enabled_reason', 'send_failures');
  assert.equal(switches().enabled, false, 'enabled 仍是布尔，语义没变');
  assert.equal(switches().enabledReason, 'send_failures');

  store.set('enabled_reason', 'admin_stop');
  assert.equal(switches().enabledReason, 'admin_stop', '同一个开关，换原因就换文案');

  store.set('groupEnabled', '0'); store.set('groupEnabled_reason', 'admin_stop');
  const both = switches();
  assert.equal(both.groupEnabled, false);
  assert.equal(both.groupEnabledReason, 'admin_stop');
  assert.equal(both.enabledReason, 'admin_stop', '两个原因各归各的，不串台');
  store.close();
});

test('the cost dashboard zero-fills its range and prices samples supplied by the store', () => {
  const store = new Store();
  const config = { inputPrice: 2, outputPrice: 8, cacheHitPrice: 0.04, offPeakRatio: 0.5 };
  // 2026-10-08 10:30 Beijing -> peak; 2026-10-09 02:00 Beijing -> off.
  const peakAt = Date.UTC(2026, 9, 8, 2, 30);
  const offAt = Date.UTC(2026, 9, 8, 18, 0);
  const empty = buildCost({ config, store, range: '7d', now: peakAt });
  assert.equal(empty.series.length, 7);
  assert.equal(empty.unit, 'day');
  assert.equal(empty.totals.tokens, 0);
  assert.equal(empty.totals.hitRate, null);
  assert.equal(empty.series[6].t, Date.UTC(2026, 9, 8, -8, 0)); // last bucket starts at China midnight

  store.noteSample({ turnKey: 'private:1:1:1', session: 'private:1', turn: 1, seq: 1, at: peakAt,
    miss: 1000000, hit: 0, out: 0, bucket: 'peak' });
  store.noteSample({ turnKey: 'private:1:1:2', session: 'private:1', turn: 1, seq: 2, at: offAt,
    miss: 0, hit: 1000000, out: 0, bucket: 'off' });

  const cost = buildCost({ config, store, range: '7d', now: offAt });
  assert.equal(cost.totals.tokens, 2000000);
  assert.equal(cost.totals.turns, 1);
  assert.equal(cost.totals.calls, 2);
  assert.equal(cost.totals.peakMicro, 2000000); // 1M miss at 2 CNY/M
  assert.equal(cost.totals.offMicro, 20000); // 1M cache-hit at 0.02 CNY/M (off-peak half of 0.04)
  assert.equal(cost.totals.hitRate, 0.5);
  assert.equal(cost.sessions.length, 1);
  assert.equal(cost.sessions[0].session, 'private:1');
  assert.equal(cost.recent.length, 2);

  const turns = buildCostTurns({ config, store, session: 'private:1' });
  assert.equal(turns.turns.length, 1);
  assert.equal(turns.turns[0].calls, 2);
  assert.equal(turns.turns[0].peakMicro + turns.turns[0].offMicro, turns.turns[0].totalMicro);
  store.close();
});

// T-031a：三张卡是「从该周期起点到 now」的累计，起点按北京时间自然日 / ISO 周一 / 月初
// 截断，上界是 now 本身 —— 正好落在 now 的样本归下一个窗口（costTotals 是左闭右开）。
test('cost cards accumulate from China midnight, Monday and the 1st up to now', () => {
  const store = new Store();
  const config = { inputPrice: 2, outputPrice: 8, cacheHitPrice: 0.04, offPeakRatio: 0.5 };
  const now = Date.UTC(2026, 9, 8, 2, 30); // 北京时间 2026-10-08（周四）10:30
  const note = (turn, at, miss) => store.noteSample({ turnKey: `private:1:${turn}:1`,
    session: 'private:1', turn, seq: 1, at, miss, hit: 0, out: 0 });
  note(1, Date.UTC(2026, 8, 20, 0, 0), 4000); // 北京 09-20：本月之外
  note(2, Date.UTC(2026, 9, 6, 0, 0), 2000); // 北京 10-06 08:00：本周，但不是今天
  note(3, Date.UTC(2026, 9, 8, 1, 0), 1000); // 北京 10-08 09:00：今天
  note(4, now, 500); // 正好落在 now：归下一个窗口
  const { cards, totals } = buildCost({ config, store, now });
  assert.equal(cards.today.since, Date.UTC(2026, 9, 7, 16, 0), '北京 10-08 00:00');
  assert.equal(cards.week.since, Date.UTC(2026, 9, 4, 16, 0), '北京 10-05 周一 00:00');
  assert.equal(cards.month.since, Date.UTC(2026, 9, 0, 16, 0), '北京 10-01 00:00（= 09-30T16:00Z）');
  for (const card of [cards.today, cards.week, cards.month]) assert.equal(card.until, now);
  assert.deepEqual([cards.today.tokens, cards.week.tokens, cards.month.tokens], [1000, 3000, 3000], '09-20 那条属于上月');
  assert.deepEqual([cards.today.calls, cards.week.calls, cards.today.turns], [1, 2, 1]);
  assert.equal(cards.today.totalMicro, 2000); // 1000 未命中 token × 2 元/M
  assert.deepEqual([cards.today.avgCallMicro, cards.today.avgTurnMicro], [2000, 2000]);
  // 24h 区间的上界是下一个整点，所以 totals 把「正好在 now」那条也算进来了。
  assert.deepEqual([totals.calls, totals.tokens], [2, 1500], '卡与 totals 的上界不同，不矛盾');
  // 卡的字段形状与 totals 完全一致，只有 since / until 是卡自己的。
  const shape = block => Object.keys(block).filter(key => key !== 'since' && key !== 'until').sort();
  for (const card of [cards.today, cards.week, cards.month]) assert.deepEqual(shape(card), shape(totals));
  const empty = new Store();
  const zero = buildCost({ config, store: empty, now }).cards.today;
  assert.deepEqual([zero.tokens, zero.hitRate, zero.avgCallMicro], [0, null, 0], '空库：除零得 0，不是 NaN');
  empty.close();
  store.close();
});

// T-031a：热力图是固定的 7 × 24 = 168 格，覆盖 28 天（4 个完整周），与 range 无关。
// 同一个「周几 × 小时」格子把 4 周加在一起，这正是它比折线图多的那点信息。
test('the heatmap is a zero-filled 7 x 24 grid over the last 28 China days', () => {
  const store = new Store();
  const config = { inputPrice: 2, outputPrice: 8, cacheHitPrice: 0.04, offPeakRatio: 0.5 };
  const now = Date.UTC(2026, 9, 8, 2, 30); // 北京 2026-10-08（周四）10:30
  const note = (turn, at, miss) => store.noteSample({ turnKey: `private:1:${turn}:1`,
    session: 'private:1', turn, seq: 1, at, miss, hit: 0, out: 0 });
  note(1, Date.UTC(2026, 8, 29, 1, 0), 1000000); // 北京 09-29（周二）09:00
  note(2, Date.UTC(2026, 9, 6, 1, 0), 1000000); // 北京 10-06（周二）09:00：与上一条同格
  note(3, Date.UTC(2026, 9, 7, 1, 0), 500000); // 北京 10-07（周三）09:00
  note(4, Date.UTC(2026, 8, 1, 1, 0), 1000); // 北京 09-01：28 天窗口之外
  const { heatmap } = buildCost({ config, store, now });
  // 上界是下一个整点（北京 11:00），下界正好 28 天之前
  assert.equal(heatmap.until, Date.UTC(2026, 9, 8, 3, 0));
  assert.equal(heatmap.since, heatmap.until - 28 * 86400000);
  assert.deepEqual(heatmap.rows.map(row => row.weekday), [1, 2, 3, 4, 5, 6, 7], '行按周一到周日排好');
  const cells = heatmap.rows.flatMap(row => row.hours);
  assert.equal(cells.length, 168, '恰好 7 × 24 格');
  assert.deepEqual(Object.keys(cells[0]), ['totalMicro', 'calls'], '每格只有两个数字，没有峰谷拆分');
  assert.equal(cells.reduce((sum, cell) => sum + cell.calls, 0), 3, '28 天之外的那条不进图');
  assert.deepEqual(heatmap.rows[1].hours[9], { totalMicro: 4000000, calls: 2 }, '周二 09:00 把两周加在一起');
  assert.deepEqual(heatmap.rows[2].hours[9], { totalMicro: 1000000, calls: 1 }, '周三 09:00 是独立一格');
  assert.equal(cells.filter(cell => cell.calls > 0).length, 2, '其余 166 格都是零填充');
  // 与 range 无关：换区间不挪窗口
  const other = buildCost({ config, store, now, range: '30d' }).heatmap;
  assert.deepEqual([other.since, other.until, other.rows], [heatmap.since, heatmap.until, heatmap.rows]);
  store.close();
});
