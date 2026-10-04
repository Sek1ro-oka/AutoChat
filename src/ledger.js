// 令牌采样与峰谷分时计价（V2 · Phase 5）。
//
// 两条不变量，这个模块存在的唯一理由：
//   1. **不自己造数**：落盘的每个 token 数都来自服务端返回的 `usage`，所有总量
//      都是 SQL 聚合，进程内不维护任何可漂移的累加器。
//   2. **采样一到就落盘**：没有"先攒后写"的 per-turn 缓冲，进程崩溃最多丢掉
//      正在飞的那一次调用，不会丢掉已经拿到的采样。
//
// 与预算的关系：**报表不改预算**。每日预留/结算仍然按高峰、未命中（最贵）价格
// 保守估算（见 docs/cost.md）；本模块算出的"真实折算"只是给人看的报表。

import { BUILTIN_HOLIDAYS, holidaySet } from './holidays.js';
import { CHINA_OFFSET_MS } from './store.js';

// 北京时间固定 UTC+8，无夏令时。
export { CHINA_OFFSET_MS };
// 9:00-12:00、14:00-18:00；右端点取开区间（12:00 整已属空闲）。
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

// DeepSeek：空闲时段价格为高峰时段价格的一半（官方计价文档）。
export const DEFAULT_OFF_PEAK_RATIO = 0.5;
// DeepSeek-Flash：缓存命中价 = 未命中价 ÷ 50（高峰 0.04 / 2.00，空闲 0.02 / 1.00）。
// 仅作为未显式配置 PRICE_CACHE_HIT_CNY_PER_MILLION 时的默认值：
// 不上报缓存字段的服务商，命中数恒为 0，该默认值不会被用到。
export const DEFAULT_CACHE_HIT_RATIO = 50;

const micro = (tokens, price) => Math.ceil((Number(tokens) || 0) * price);

// 一次调用落在高峰还是空闲。判定只看北京时间的工作日 + 时段 + 法定节假日。
export function bucketAt(at, holidays = BUILTIN_HOLIDAYS) {
  const local = new Date(at + CHINA_OFFSET_MS);
  const weekday = local.getUTCDay();
  if (weekday === 0 || weekday === 6) return 'off';
  if (holidays.has(local.toISOString().slice(0, 10))) return 'off';
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to) ? 'peak' : 'off';
}

// 把服务端 `usage` 拆成三个互不重叠的桶：输入未命中 / 输入命中 / 输出。
// 三个桶之和恒等于 prompt_tokens + completion_tokens，同一个 token 不会被记两次。
// 服务商不上报缓存字段时退化为"全部未命中"——只会高估花费，不会低估。
export function splitUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens < 0
      || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens < 0) return null;
  const usable = value => Number.isSafeInteger(value) && value >= 0;
  const hit = usage.prompt_cache_hit_tokens;
  const miss = usage.prompt_cache_miss_tokens;
  const prompt = usage.prompt_tokens;
  const out = usage.completion_tokens;
  if (usable(hit) && usable(miss) && hit + miss === prompt) return { miss, hit, out };
  if (usable(hit) && hit <= prompt) return { miss: prompt - hit, hit, out };
  return { miss: prompt, hit: 0, out };
}

// 某个时段的生效单价（CNY / 百万 token，与 config.inputPrice 同单位）。
export function pricesFor(config, bucket) {
  const miss = Number(config.inputPrice) || 0;
  const hit = Number.isFinite(config.cacheHitPrice) ? config.cacheHitPrice : miss / DEFAULT_CACHE_HIT_RATIO;
  const out = Number(config.outputPrice) || 0;
  if (bucket === 'peak') return { miss, hit, out };
  const ratio = Number.isFinite(config.offPeakRatio) ? config.offPeakRatio : DEFAULT_OFF_PEAK_RATIO;
  return { miss: miss * ratio, hit: hit * ratio, out: out * ratio };
}

// 单条采样的报表金额（微元）。分段取整，误差上界 3 微元（3e-6 元）。
export function sampleCostMicro(sample, config) {
  const prices = pricesFor(config, sample.bucket);
  return micro(sample.miss, prices.miss) + micro(sample.hit, prices.hit) + micro(sample.out, prices.out);
}

// 聚合行（含六个峰/谷分桶列）的报表金额。六个分桶列由 store 的 SQL 聚合产出。
export function reportCost(row, config) {
  if (!row) return { peakMicro: 0, offMicro: 0, totalMicro: 0 };
  const peakMicro = sampleCostMicro({ miss: row.missPeak, hit: row.hitPeak, out: row.outPeak, bucket: 'peak' }, config);
  const offMicro = sampleCostMicro({ miss: row.missOff, hit: row.hitOff, out: row.outOff, bucket: 'off' }, config);
  return { peakMicro, offMicro, totalMicro: peakMicro + offMicro };
}

// 一组六个分桶列的 token 合计，附带缓存命中率。命中率为 null 表示无输入 token。
export function splitTotals(row) {
  if (!row) return { miss: 0, hit: 0, out: 0, tokens: 0, hitRate: null };
  const miss = (row.missPeak ?? 0) + (row.missOff ?? 0);
  const hit = (row.hitPeak ?? 0) + (row.hitOff ?? 0);
  const out = (row.outPeak ?? 0) + (row.outOff ?? 0);
  const input = miss + hit;
  return { miss, hit, out, tokens: input + out, hitRate: input ? hit / input : null };
}

export class Ledger {
  constructor({ store, log = () => {}, now = () => Date.now() } = {}) {
    this.store = store; this.log = log; this.now = now;
  }
  // 一轮 = 一条被处理的用户消息。turn 号由 SQLite 分配且跨重启单调递增，
  // 否则重启后 turn 从 1 重来会让 `session:turn:seq` 撞上上一轮的采样。
  begin(session) { return { session, turn: this.store.nextTurn(), seq: 0 }; }
  // 记录一次模型调用。返回落盘内容，usage 不可用（或调用失败）时返回 null。
  sample(trace, usage, config, at = this.now()) {
    if (!trace) return null;
    const split = splitUsage(usage);
    if (!split) { this.log('ledger_usage_missing'); return null; }
    const seq = trace.seq + 1;
    const bucket = bucketAt(at, holidaySet(config?.costHolidays ?? []));
    const turnKey = `${trace.session}:${trace.turn}:${seq}`;
    this.store.noteSample({ turnKey, session: trace.session, turn: trace.turn, seq, at, bucket, ...split });
    trace.seq = seq;
    return { ...split, bucket, seq };
  }
}
