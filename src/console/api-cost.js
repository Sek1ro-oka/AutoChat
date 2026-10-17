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

export function buildCost({ config, store, range = '24h', sessions = 50, samples = 20, now = Date.now() }) {
  const spec = COST_RANGES[range] ?? COST_RANGES['24h'];
  // Align to China-time bucket boundaries (`epoch multiples` would put a "day"
  // boundary at 08:00 Beijing, splitting a real billing day in half).
  const until = Math.ceil((now + CHINA_OFFSET_MS) / spec.unitMs) * spec.unitMs - CHINA_OFFSET_MS;
  const since = until - spec.buckets * spec.unitMs;
  const span = { since, until };
  const totalRow = store.costTotals(span);
  const totals = { ...splitTotals(totalRow), calls: totalRow.calls, turns: totalRow.turns, ...reportCost(totalRow, config) };
  return {
    range: COST_RANGES[range] ? range : '24h', ranges: Object.keys(COST_RANGES),
    unit: spec.unit, unitMs: spec.unitMs, since, until,
    pricing: {
      inputPrice: config.inputPrice ?? null, outputPrice: config.outputPrice ?? null,
      cacheHitPrice: config.cacheHitPrice ?? null, offPeakRatio: config.offPeakRatio ?? 0.5,
    },
    totals: {
      ...totals,
      avgTurnMicro: totals.turns ? Math.round(totals.totalMicro / totals.turns) : 0,
      avgCallMicro: totals.calls ? Math.round(totals.totalMicro / totals.calls) : 0,
    },
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
