import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Ledger, bucketAt, splitUsage, pricesFor, sampleCostMicro, reportCost, splitTotals } from '../src/ledger.js';
import { holidaySet, BUILTIN_HOLIDAYS } from '../src/holidays.js';

// Beijing wall time -> epoch ms. 2026-10-04 is a Sunday, so 10-05 is a Monday.
const bj = (month, day, hour, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute);

// Reporting prices: peak input 2 / cache-hit 0.04 / output 8 CNY per million.
const PRICE = { inputPrice: 2, outputPrice: 8, cacheHitPrice: 0.04, offPeakRatio: 0.5 };

test('peak windows follow Beijing workday hours with open right edge', () => {
  // 2026-10-08 is a Thursday and not a statutory holiday.
  assert.equal(bucketAt(bj(10, 8, 8, 59)), 'off');
  assert.equal(bucketAt(bj(10, 8, 9, 0)), 'peak');
  assert.equal(bucketAt(bj(10, 8, 11, 59)), 'peak');
  assert.equal(bucketAt(bj(10, 8, 12, 0)), 'off');
  assert.equal(bucketAt(bj(10, 8, 13, 59)), 'off');
  assert.equal(bucketAt(bj(10, 8, 14, 0)), 'peak');
  assert.equal(bucketAt(bj(10, 8, 17, 59)), 'peak');
  assert.equal(bucketAt(bj(10, 8, 18, 0)), 'off');
  assert.equal(bucketAt(bj(10, 8, 23, 30)), 'off');
  assert.equal(bucketAt(bj(10, 8, 3, 0)), 'off');
});

test('weekends and statutory holidays are off-peak all day', () => {
  assert.equal(bucketAt(bj(10, 10, 10, 0)), 'off'); // Saturday
  assert.equal(bucketAt(bj(10, 11, 10, 0)), 'off'); // Sunday
  assert.equal(bucketAt(bj(10, 5, 10, 0)), 'off'); // Monday, within National Day 10-01..10-07
  assert.equal(bucketAt(bj(10, 1, 10, 0)), 'off');
  assert.equal(bucketAt(bj(5, 4, 10, 0)), 'off'); // Monday, Labour Day 05-01..05-05
  assert.equal(bucketAt(bj(2, 23, 10, 0)), 'off'); // Monday, last day of Spring Festival
  assert.equal(bucketAt(bj(2, 24, 10, 0)), 'peak'); // Tuesday, back to work
  assert.equal(bucketAt(bj(9, 25, 10, 0)), 'off'); // Mid-Autumn 09-25..09-27
});

test('the built-in holiday table covers the current year and extra days can be added', () => {
  assert.equal(BUILTIN_HOLIDAYS.size, 3 + 9 + 3 + 5 + 3 + 3 + 7);
  const extra = holidaySet(['2026-11-11', 'not-a-date']);
  assert.equal(extra.has('2026-11-11'), true);
  assert.equal(extra.has('not-a-date'), false);
  assert.equal(bucketAt(bj(11, 11, 10, 0), extra), 'off');
  assert.equal(bucketAt(bj(11, 11, 10, 0)), 'peak'); // no override -> ordinary workday
});

test('usage splits into three disjoint buckets that always sum to the reported total', () => {
  const cases = [
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }, { miss: 40, hit: 60, out: 20 }],
    [{ prompt_tokens: 100, completion_tokens: 20 }, { miss: 100, hit: 0, out: 20 }],
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 }, { miss: 40, hit: 60, out: 20 }],
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 41 }, { miss: 40, hit: 60, out: 20 }],
    [{ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 500 }, { miss: 100, hit: 0, out: 20 }],
  ];
  for (const [usage, expected] of cases) {
    const split = splitUsage(usage);
    assert.deepEqual(split, expected);
    assert.equal(split.miss + split.hit + split.out, usage.prompt_tokens + usage.completion_tokens);
  }
  assert.equal(splitUsage(null), null);
  assert.equal(splitUsage({ prompt_tokens: -1, completion_tokens: 1 }), null);
  assert.equal(splitUsage({ prompt_tokens: 1 }), null);
  assert.equal(splitUsage({ prompt_tokens: 1.5, completion_tokens: 1 }), null);
});

test('off-peak prices are exactly half of peak and the cache price defaults to 1/50', () => {
  assert.deepEqual(pricesFor(PRICE, 'peak'), { miss: 2, hit: 0.04, out: 8 });
  assert.deepEqual(pricesFor(PRICE, 'off'), { miss: 1, hit: 0.02, out: 4 });
  const fallback = pricesFor({ inputPrice: 2, outputPrice: 8 }, 'peak');
  assert.equal(fallback.hit, 2 / 50);
  const million = { miss: 1000000, hit: 0, out: 0 };
  assert.equal(sampleCostMicro({ ...million, bucket: 'peak' }, PRICE), 2000000);
  assert.equal(sampleCostMicro({ ...million, bucket: 'off' }, PRICE), 1000000);
  assert.equal(sampleCostMicro({ miss: 0, hit: 1000000, out: 0, bucket: 'peak' }, PRICE), 40000);
  assert.equal(sampleCostMicro({ miss: 0, hit: 0, out: 1000000, bucket: 'peak' }, PRICE), 8000000);
});

test('aggregated rows are priced per bucket and never double count', () => {
  const row = { missPeak: 1000000, hitPeak: 0, outPeak: 0, missOff: 2000000, hitOff: 0, outOff: 0 };
  const cost = reportCost(row, PRICE);
  assert.equal(cost.peakMicro, 2000000);
  assert.equal(cost.offMicro, 2000000);
  assert.equal(cost.totalMicro, 4000000);
  assert.deepEqual(splitTotals(row), { miss: 3000000, hit: 0, out: 0, tokens: 3000000, hitRate: 0 });
  assert.deepEqual(reportCost(null, PRICE), { peakMicro: 0, offMicro: 0, totalMicro: 0 });
  assert.equal(splitTotals({ missPeak: 0, hitPeak: 0, outPeak: 0, missOff: 0, hitOff: 0, outOff: 0 }).hitRate, null);
  assert.equal(splitTotals({ missPeak: 0, hitPeak: 30, outPeak: 10, missOff: 10, hitOff: 0, outOff: 0 }).hitRate, 30 / 40);
});

test('the turn counter is monotonic across restarts so keys are never reused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-turn-'));
  const path = join(dir, 'turn.sqlite');
  const first = new Store(path);
  const a = first.nextTurn(), b = first.nextTurn();
  assert.equal(b, a + 1);
  first.close();
  const second = new Store(path);
  assert.equal(second.nextTurn(), b + 1);
  second.close();
  for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
  rmdirSync(dir);
});

test('ledger appends one row per model call and replays cannot double count', () => {
  const store = new Store();
  const ledger = new Ledger({ store, now: () => bj(10, 8, 10, 0) });
  const trace = ledger.begin('private:10000002');
  const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 };
  const first = ledger.sample(trace, usage, PRICE, bj(10, 8, 10, 0));
  const second = ledger.sample(trace, usage, PRICE, bj(10, 8, 10, 1));
  assert.deepEqual(first, { miss: 600, hit: 400, out: 200, bucket: 'peak', seq: 1 });
  assert.equal(second.seq, 2);
  const rows = store.recentSamples(10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].turn_key, `private:10000002:${trace.turn}:2`);
  // A replayed key with an older-or-equal timestamp is a no-op, not a second row.
  assert.equal(store.noteSample({ turnKey: rows[0].turn_key, session: 'private:10000002',
    turn: trace.turn, seq: 2, at: bj(10, 8, 10, 0), miss: 9, hit: 9, out: 9, bucket: 'off' }), 0);
  assert.equal(store.recentSamples(10)[0].miss, 600);
  store.close();
});

test('ledger refuses to invent numbers when usage is unusable', () => {
  const store = new Store();
  const events = [];
  const ledger = new Ledger({ store, log: event => events.push(event) });
  const trace = ledger.begin('group:10000003');
  assert.equal(ledger.sample(trace, undefined, PRICE), null);
  assert.equal(ledger.sample(trace, { prompt_tokens: 'x', completion_tokens: 1 }, PRICE), null);
  assert.equal(ledger.sample(null, { prompt_tokens: 1, completion_tokens: 1 }, PRICE), null);
  assert.equal(store.recentSamples(10).length, 0);
  assert.deepEqual(events, ['ledger_usage_missing', 'ledger_usage_missing']);
  store.close();
});

test('sample buckets honour configured holidays and the ledger writes them through', () => {
  const store = new Store();
  const ledger = new Ledger({ store });
  const trace = ledger.begin('group:10000003');
  const usage = { prompt_tokens: 100, completion_tokens: 10 };
  // 2026-10-08 is a workday, but a user can declare it a holiday.
  const at = bj(10, 8, 10, 0);
  assert.equal(ledger.sample({ ...trace, seq: 0 }, usage, { ...PRICE, costHolidays: ['2026-10-08'] }, at).bucket, 'off');
  store.close();
});

test('cost aggregates group by China-time day and hour with no gaps in totals', () => {
  const store = new Store();
  const ledger = new Ledger({ store });
  const trace = ledger.begin('group:10000003');
  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 250, prompt_cache_miss_tokens: 750 };
  ledger.sample(trace, usage, PRICE, bj(10, 8, 10, 30));
  ledger.sample(trace, usage, PRICE, bj(10, 8, 11, 30));
  ledger.sample(trace, usage, PRICE, bj(10, 9, 2, 0)); // 02:00 next day -> off, different day

  const totals = store.costTotals({ since: 0 });
  assert.equal(totals.calls, 3);
  assert.equal(totals.turns, 1);
  assert.deepEqual(splitTotals(totals), { miss: 2250, hit: 750, out: 300, tokens: 3300, hitRate: 0.25 });

  const hourly = store.costSeries({ since: bj(10, 8, 0, 0), until: bj(10, 9, 0, 0), unitMs: 3600000 });
  assert.deepEqual(hourly.map(row => row.t), [bj(10, 8, 10, 0), bj(10, 8, 11, 0)]);
  assert.equal(hourly[0].missPeak + hourly[0].missOff, 750);
  assert.equal(hourly[1].calls, 1);

  const daily = store.costSeries({ since: bj(10, 8, 0, 0), until: bj(10, 10, 0, 0), unitMs: 86400000 });
  assert.deepEqual(daily.map(row => row.t), [bj(10, 8, 0, 0), bj(10, 9, 0, 0)]);
  assert.equal(daily[1].missOff, 750); // 02:00 is off-peak
  assert.equal(daily[0].missPeak, 1500);

  const sessions = store.costSessions({ since: 0 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session, 'group:10000003');
  assert.equal(sessions[0].turns, 1);
  // Two peak calls (10:30, 11:30) and one off-peak call (next-day 02:00) must be
  // priced with their own tariffs: 2x(750/250/100) peak, 1x the same off-peak.
  const sessionCost = reportCost(sessions[0], PRICE);
  assert.equal(sessionCost.peakMicro, 1500 * 2 + Math.ceil(500 * 0.04) + 200 * 8);
  assert.equal(sessionCost.offMicro, 750 * 1 + Math.ceil(250 * 0.02) + 100 * 4);
  assert.equal(sessionCost.totalMicro, sessionCost.peakMicro + sessionCost.offMicro);

  const turns = store.costTurns({ session: 'group:10000003' });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn, trace.turn);
  assert.equal(turns[0].calls, 3);
  assert.equal(store.costTurns({ session: 'nobody' }).length, 0);
  store.close();
});

test('sample pruning keeps the newest rows only', () => {
  const store = new Store();
  for (let index = 0; index < 150; index += 1) {
    store.noteSample({ turnKey: `s:${index}:1`, session: 's', turn: index, seq: 1,
      at: 1700000000000 + index, miss: 1, hit: 0, out: 0, bucket: 'peak' });
  }
  assert.equal(store.pruneSamples(150), 0); // nothing exceeds the cap
  assert.equal(store.pruneSamples(120), 30);
  const left = store.recentSamples(200);
  assert.equal(left.length, 120);
  assert.equal(left[0].turn, 149);
  assert.equal(left.at(-1).turn, 30);
  store.close();
});
