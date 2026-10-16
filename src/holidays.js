// 中国法定节假日（放假调休日）—— 仅用于峰谷分时计价的时段判定。
//
// 计价依据（DeepSeek 官方计价文档）：
//   北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
//   其余时段，包括周末及中国法定节假日全天均为空闲时段。
//   空闲时段价格为高峰时段价格的一半。
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//
// 日期依据：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04）。
//   https://politics.people.com.cn/BIG5/n1/2025/1105/c1001-40596810.html
//   注意：调休"上班"的周末不改变判定 —— 规则只看"是否周末/是否法定节假日"，
//   补班的周六仍算周末，全天空闲。
//
// 维护：每年国务院发布次年安排后追加对应年份；表内没有的年份一律按"非节假日"
// 处理（这会高估高峰时长、从而高估花费，属于保守方向）。用户的额外日期走
// .env 的 COST_HOLIDAYS（逗号分隔 YYYY-MM-DD）。

import { CHINA_OFFSET_MS } from './store.js';

const TABLE = {
  2026: [
    ['01-01', '01-03'], // 元旦
    ['02-15', '02-23'], // 春节
    ['04-04', '04-06'], // 清明节
    ['05-01', '05-05'], // 劳动节
    ['06-19', '06-21'], // 端午节
    ['09-25', '09-27'], // 中秋节
    ['10-01', '10-07'], // 国庆节
  ],
};

function expand(table) {
  const days = new Set();
  for (const [year, ranges] of Object.entries(table)) {
    for (const [from, to] of ranges) {
      const start = Date.parse(`${year}-${from}T00:00:00Z`);
      const end = Date.parse(`${year}-${to}T00:00:00Z`);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      for (let at = start; at <= end; at += 86400000) days.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  return days;
}

export const BUILTIN_HOLIDAYS = expand(TABLE);
// Built once: the built-in days never change, so the whole set is materialised a
// single time and shared with callers that pass no extras (see below).
const BUILTIN_SET = new Set(BUILTIN_HOLIDAYS);
export const HOLIDAY_YEARS = Object.keys(TABLE).map(Number).sort();

// Built-in days plus user-supplied extras. Invalid entries are dropped loudly
// rather than silently shifting prices. The returned Set is read-only by
// contract: with no extras it *is* the shared built-in set, so `add`/`delete`/
// `clear` on it would corrupt every later reader — copy it first if you must
// mutate.
export function holidaySet(extra = []) {
  if (!extra.length) return BUILTIN_SET;
  const set = new Set(BUILTIN_SET);
  for (const day of extra) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day))) set.add(day);
  }
  return set;
}

// 启动时的一次性告警：内置表是每年手工维护的，表里没有的年份会被静默按
// "非节假日"计价（见文件头）。把这份沉默变成启动日志里的一行 warn —— 只写一次，
// 不在任何请求路径上重复。`years` 与 `now` 都由调用方传入，因此调用点与测试读的是
// 同一份年份清单、同一个被注入的时刻（不依赖真实时钟）。
// detail 只含数字：春节/元旦前后的年份边界按北京时间算，与计价口径一致。
export function warnStaleHolidayTable(log, years, now = Date.now()) {
  const tableYear = years.length ? Math.max(...years) : null;
  const year = new Date(now + CHINA_OFFSET_MS).getUTCFullYear();
  if (tableYear === null || year <= tableYear) return null;
  const detail = { tableYear, now: year };
  log('holiday_table_stale', detail);
  return detail;
}
