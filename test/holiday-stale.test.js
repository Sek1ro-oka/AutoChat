import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLIDAY_YEARS, warnStaleHolidayTable } from '../src/holidays.js';

// Beijing wall time -> epoch ms, same helper shape as test/ledger.test.js.
const bj = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute);

// The year the built-in table currently ends at. Derived, not hard-coded, so that
// the annual table update does not turn these tests red for the wrong reason.
const TABLE_YEAR = Math.max(...HOLIDAY_YEARS);

// Records what the logger would have written. `now` is injected at every call site
// below, so nothing here reads the real clock.
const recorder = () => {
  const events = [];
  return { events, log: (event, detail) => events.push({ event, detail }) };
};

test('a year covered by the built-in table writes no event', () => {
  const { events, log } = recorder();
  assert.equal(warnStaleHolidayTable(log, HOLIDAY_YEARS, bj(TABLE_YEAR, 10, 17, 12)), null);
  assert.deepEqual(events, []);
});

test('a year past the built-in table writes exactly one event with numeric detail', () => {
  const { events, log } = recorder();
  const detail = warnStaleHolidayTable(log, HOLIDAY_YEARS, bj(TABLE_YEAR + 1, 3, 9, 12));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'holiday_table_stale');
  // Exactly these two keys, both numbers: no user content, no lengths, no hashes.
  assert.deepEqual(events[0].detail, { tableYear: TABLE_YEAR, now: TABLE_YEAR + 1 });
  assert.deepEqual(Object.keys(events[0].detail).sort(), ['now', 'tableYear']);
  assert.equal(typeof events[0].detail.tableYear, 'number');
  assert.equal(typeof events[0].detail.now, 'number');
  assert.deepEqual(detail, events[0].detail);
});

test('the year boundary is Beijing time, not the host clock', () => {
  // 23:59 on 12-31 Beijing is still inside the table year.
  const before = recorder();
  assert.equal(warnStaleHolidayTable(before.log, HOLIDAY_YEARS, bj(TABLE_YEAR, 12, 31, 23, 59)), null);
  assert.deepEqual(before.events, []);
  // 00:00 on 01-01 Beijing has already rolled over.
  const after = recorder();
  assert.notEqual(warnStaleHolidayTable(after.log, HOLIDAY_YEARS, bj(TABLE_YEAR + 1, 1, 1, 0)), null);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].detail.now, TABLE_YEAR + 1);
});

test('an empty year list stays quiet instead of crashing', () => {
  const { events, log } = recorder();
  assert.equal(warnStaleHolidayTable(log, [], bj(TABLE_YEAR + 5, 1, 1, 0)), null);
  assert.deepEqual(events, []);
});
