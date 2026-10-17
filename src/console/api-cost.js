// Console data builders: the token & cost dashboard.

import { CHINA_OFFSET_MS } from '../store.js';
import { reportCost, sampleCostMicro, splitTotals } from '../ledger.js';

// --- Token & cost dashboard (Phase 5) --------------------------------------
// Ranges are fixed so the chart never renders an unbounded number of bars.
export const COST_RANGES = Object.freeze({
  '24h': { buckets: 24, unitMs: 3600000, unit: 'hour' },
  '3d': { buckets: 72, unitMs: 3600000, unit: 'hour' },
  '7d': { buckets: 7, unitMs: 86400000, unit: 'day' },
  '30d': { buckets: 30, unitMs: 86400000, unit: 'day' },
});

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// One aggregate row -> the metric block shared by `totals` and the three cards.
// There is exactly one builder on purpose: a card that computed its own numbers
// would eventually disagree with the totals rendered next to it.
function metrics(row, config) {
  const block = { ...splitTotals(row), calls: row.calls, turns: row.turns, ...reportCost(row, config) };
  return {
    ...block,
    avgTurnMicro: block.turns ? Math.round(block.totalMicro / block.turns) : 0,
    avgCallMicro: block.calls ? Math.round(block.totalMicro / block.calls) : 0,
  };
}

// Zero-fill empty slots so the chart keeps a stable x-axis instead of collapsing.
function series(rows, { start, buckets, unitMs }, config) {
  const bySlot = new Map(rows.map(row => [row.t, row]));
  const points = [];
  for (let index = 0; index < buckets; index += 1) {
    const t = start + index * unitMs;
    const row = bySlot.get(t);
    const { peakMicro, offMicro, totalMicro } = reportCost(row, config);
    points.push({ t, peakMicro, offMicro, totalMicro, calls: row?.calls ?? 0, ...splitTotals(row) });
  }
  return points;
}

// Start of "today", "this week" (ISO, Monday first) and "this month" in China
// time. `store.costTotals` filters `at >= since AND at < until`, so every window
// here is left-closed and right-open: `until: now` hands a sample stamped
// exactly at `now` to the next window, which costs the dashboard one millisecond.
function cardWindows(now) {
  const shifted = now + CHINA_OFFSET_MS;
  const dayIndex = Math.floor(shifted / DAY_MS);
  const weekday = ((dayIndex + 3) % 7) + 1; // Monday = 1 ... Sunday = 7
  const monthKey = new Date(shifted).toISOString().slice(0, 7);
  return {
    today: { since: dayIndex * DAY_MS - CHINA_OFFSET_MS, until: now },
    week: { since: (dayIndex - (weekday - 1)) * DAY_MS - CHINA_OFFSET_MS, until: now },
    month: { since: Date.parse(`${monthKey}-01T00:00:00.000Z`) - CHINA_OFFSET_MS, until: now },
  };
}

// Weekday x hour grid over four whole weeks (28 days), always zero-filled: the
// page paints a fixed 7 x 24 grid and never compensates for a missing cell. The
// window ignores `range` on purpose — it is a habit view, not a zoom of the
// selected range. A cell carries only the two numbers the grid draws.
function heatGrid({ store, config, now }) {
  const until = Math.ceil((now + CHINA_OFFSET_MS) / HOUR_MS) * HOUR_MS - CHINA_OFFSET_MS;
  // 28 whole days (four whole weeks), not 28 hours: every weekday then appears
  // four times, so one cell averages four weeks instead of five rows staying
  // permanently empty. See work/agent-tasks/T-031a/report.md for the correction.
  const since = until - 28 * DAY_MS;
  const rows = Array.from({ length: 7 }, (_, index) => ({
    weekday: index + 1,
    hours: Array.from({ length: 24 }, () => ({ totalMicro: 0, calls: 0 })),
  }));
  for (const row of store.costSeries({ since, until, unitMs: HOUR_MS })) {
    const shifted = row.t + CHINA_OFFSET_MS;
    const dayIndex = Math.floor(shifted / DAY_MS);
    const weekday = ((dayIndex + 3) % 7) + 1;
    const hour = Math.floor((shifted - dayIndex * DAY_MS) / HOUR_MS);
    const cell = rows[weekday - 1].hours[hour];
    cell.totalMicro += reportCost(row, config).totalMicro;
    cell.calls += Number(row.calls) || 0;
  }
  return { since, until, rows };
}

// The three spend cards, on their own so the instance hub can fill one per row
// without rebuilding a whole /api/cost payload for every database it opens.
export function costCards({ config, store, now = Date.now() }) {
  const windows = cardWindows(now);
  const card = window => ({ ...window, ...metrics(store.costTotals(window), config) });
  return { today: card(windows.today), week: card(windows.week), month: card(windows.month) };
}

export function buildCost({ config, store, range = '24h', sessions = 50, samples = 20, now = Date.now() }) {
  const spec = COST_RANGES[range] ?? COST_RANGES['24h'];
  // Align to China-time bucket boundaries (`epoch multiples` would put a "day"
  // boundary at 08:00 Beijing, splitting a real billing day in half).
  const until = Math.ceil((now + CHINA_OFFSET_MS) / spec.unitMs) * spec.unitMs - CHINA_OFFSET_MS;
  const since = until - spec.buckets * spec.unitMs;
  const span = { since, until };
  return {
    range: COST_RANGES[range] ? range : '24h', ranges: Object.keys(COST_RANGES),
    unit: spec.unit, unitMs: spec.unitMs, since, until,
    pricing: {
      inputPrice: config.inputPrice ?? null, outputPrice: config.outputPrice ?? null,
      cacheHitPrice: config.cacheHitPrice ?? null, offPeakRatio: config.offPeakRatio ?? 0.5,
    },
    totals: metrics(store.costTotals(span), config),
    cards: costCards({ config, store, now }),
    heatmap: heatGrid({ store, config, now }),
    series: series(store.costSeries({ ...span, unitMs: spec.unitMs }), { start: since, ...spec }, config),
    sessions: store.costSessions({ ...span, limit: sessions }).map(row => ({
      session: row.session, calls: row.calls, turns: row.turns, last: row.last,
      ...splitTotals(row), ...reportCost(row, config),
    })),
    recent: store.recentSamples(samples).map(row => ({
      session: row.session, turn: row.turn, seq: row.seq, at: row.at, bucket: row.bucket,
      miss: row.miss, hit: row.hit, out: row.out,
      tokens: row.miss + row.hit + row.out, costMicro: sampleCostMicro(row, config),
    })),
  };
}

export function buildCostTurns({ config, store, session = '', limit = 100 }) {
  return {
    session,
    turns: store.costTurns({ session, limit }).map(row => ({
      turn: row.turn, at: row.at, last: row.last, calls: row.calls,
      ...splitTotals(row), ...reportCost(row, config),
    })),
  };
}
