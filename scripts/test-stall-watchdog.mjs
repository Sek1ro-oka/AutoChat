// 会话永久繁忙看门狗的单测（假时钟 + 假 bridge 状态 + 假 api，全程不碰真实文件和网络）。
//
// 覆盖任务书 §5 的 7 项：
//   ① 计龄纯函数：四锚点取 max、缺锚点不抛错
//   ② 合法长轮询（10 分钟静默）不被打断
//   ③ 软告警只报一次，恢复后 suspect 清空
//   ④ 硬清理要连续 2 轮确认：第 1 轮只确认，第 2 轮才动手
//   ⑤ 七步顺序与幂等（含 session-not-found 被吞）
//   ⑥ QQ_BRIDGE_WATCHDOG=off 只软不硬
//   ⑦ 清理之后 idle 重算不再命中
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeIdle, judge, parseWatchdogEnabled, stallMinutes, isMissingSessionError,
  cleanZombieSession, createStallWatchdog,
  STALL_SOFT_MS, STALL_HARD_MS, STALL_SCAN_INTERVAL_MS, STALL_CONFIRM_ROUNDS
} from '../src/stall-watchdog.js';

const KEY = 'group:10001';
const SID = 'session-zombie-1';
// 假时钟的基准时刻：所有锚点都是 BASE + 偏移，避免用 0 当时间戳（0 = 「没有锚点」）
const BASE = 1_700_000_000_000;
const MIN = 60_000;

// 假 bridge：把看门狗要读要清的账本全做成内存结构，并记录每次 reject / cancel。
function makeFakeBridge(overrides = {}) {
  const state = {
    key: KEY,
    sessionId: SID,
    collectors: new Map([[SID, { push: () => null }]]),
    v2TurnStartAt: new Map([[SID, BASE]]),
    lastEventAt: new Map([[SID, BASE]]),
    activeWaitStartedAt: new Map(),
    pendingWakeArmAt: new Map(),
    pendingWakeKeys: new Set(),
    pendingWakeLeaseTimers: new Map(),
    activeWaits: new Map(),
    promptQueues: new Map(),
    sendToolSucceededSessions: new Set([SID]),
    pendingSendToolCalls: new Map([[SID, new Set()]]),
    toolCallNames: new Map([[SID, new Map()]]),
    silentTurns: new Map(),
    zombieKilledAt: new Map(),
    cancelCalls: [],
    disarmed: []
  };
  state.api = {
    sessions: {
      cancel: async (payload, signal) => {
        state.cancelCalls.push({ payload, hasSignal: !!signal });
        return { result: { ok: true, value: {} } };
      }
    }
  };
  Object.assign(state, overrides);
  return state;
}

function entryWithInFlight() {
  const rejected = [];
  const entry = {
    queue: [],
    running: true,
    inFlight: { reject: (error) => rejected.push(error) }
  };
  entry.queue.push(
    { reject: (error) => rejected.push(error) },
    { reject: (error) => rejected.push(error) }
  );
  return { entry, rejected };
}

function depsOf(state, extra = {}) {
  return {
    api: state.api,
    promptQueues: state.promptQueues,
    v2TurnStartAt: state.v2TurnStartAt,
    collectors: state.collectors,
    lastEventAt: state.lastEventAt,
    activeWaitStartedAt: state.activeWaitStartedAt,
    pendingWakeKeys: state.pendingWakeKeys,
    pendingWakeArmAt: state.pendingWakeArmAt,
    disarmPendingWakeLease: (key) => state.disarmed.push(key),
    activeWaits: state.activeWaits,
    sendToolSucceededSessions: state.sendToolSucceededSessions,
    pendingSendToolCalls: state.pendingSendToolCalls,
    toolCallNames: state.toolCallNames,
    silentTurns: state.silentTurns,
    zombieKilledAt: state.zombieKilledAt,
    hardMs: STALL_HARD_MS,
    now: () => BASE,
    log: () => {},
    ...extra
  };
}

// 与 bridge.js 里 collect() 等价的判定：只要还有任一处理由说明该会话 busy 就纳入候选。
function collectFrom(state) {
  const busy = [];
  const entry = state.promptQueues.get(state.key);
  if (entry?.running) busy.push('在飞投递');
  if (entry?.queue?.length) busy.push(`排队${entry.queue.length}条`);
  if (state.v2TurnStartAt.has(state.sessionId) || state.collectors.has(state.sessionId)) busy.push('turn');
  if (state.pendingWakeKeys.has(state.key) || state.pendingWakeLeaseTimers.has(state.key)) busy.push('唤醒租约');
  if (state.activeWaits.has(state.key)) busy.push('长轮询等待');
  if (busy.length === 0) return [];
  return [{
    key: state.key,
    sessionId: state.sessionId,
    busy,
    anchors: {
      lastEventAt: state.lastEventAt.get(state.sessionId) ?? 0,
      turnStartAt: state.v2TurnStartAt.get(state.sessionId) ?? 0,
      activeWaitStartedAt: state.activeWaitStartedAt.get(state.key) ?? 0,
      pendingWakeArmAt: state.pendingWakeArmAt.get(state.key) ?? 0
    }
  }];
}

function makeWatchdog(state, clock, options = {}) {
  const logs = [];
  const kills = [];
  const watchdog = createStallWatchdog({
    enabled: true,
    softMs: STALL_SOFT_MS,
    hardMs: STALL_HARD_MS,
    scanMs: STALL_SCAN_INTERVAL_MS,
    confirmRounds: STALL_CONFIRM_ROUNDS,
    now: () => clock.at,
    log: (message) => logs.push(message),
    collect: () => collectFrom(state),
    onHard: async (record) => { kills.push(record); },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    ...options
  });
  return { watchdog, logs, kills };
}

// ── ① 计龄：四锚点取 max，缺锚点退化不抛错 ───────────────────────────────
test('① computeIdle 取四锚点最大值，缺锚点不抛错', () => {
  const now = BASE;
  const idle = computeIdle({
    lastEventAt: now - MIN,
    turnStartAt: now - 999 * 1000,
    activeWaitStartedAt: now - 600 * 1000,
    pendingWakeArmAt: now - 30 * 1000
  }, now);
  assert.equal(idle.known, true);
  assert.equal(idle.idleMs, 30 * 1000); // 最近的是 pendingWakeArmAt
  assert.equal(idle.dominant, 'pendingWakeArmAt');

  const onlyTurn = computeIdle({ turnStartAt: now - 120 * 1000 }, now);
  assert.deepEqual([onlyTurn.known, onlyTurn.idleMs, onlyTurn.dominant], [true, 120 * 1000, 'turnStartAt']);

  // 缺锚点/非法值/未来时间戳都不能抛错
  assert.equal(computeIdle(undefined, now).known, false);
  assert.equal(computeIdle({}, now).known, false);
  assert.equal(computeIdle(null, NaN).known, false);
  assert.equal(computeIdle({ lastEventAt: 'oops', turnStartAt: -5 }, now).known, false);
  const future = computeIdle({ lastEventAt: now + MIN }, now);
  assert.deepEqual([future.known, future.idleMs], [true, 0]);
  // 缺省 now 也能跑（走 Date.now）
  assert.equal(typeof computeIdle({ lastEventAt: Date.now() }).idleMs, 'number');
});

test('① judge 的阈值语义：软只告警，硬要累计确认', () => {
  const base = { softMs: STALL_SOFT_MS, hardMs: STALL_HARD_MS, confirmRounds: 2, enabled: true };
  const pass = judge({ ...base, idleMs: 10 * MIN, suspect: true, confirmCount: 3 });
  assert.deepEqual([pass.level, pass.overSoft, pass.kill, pass.confirmCount], ['pass', false, false, 0]);

  const soft = judge({ ...base, idleMs: 15 * MIN, suspect: false });
  assert.deepEqual([soft.level, soft.overHard, soft.softAlert, soft.kill], ['soft', false, true, false]);
  // 同一段连续越线不重复告警
  assert.equal(judge({ ...base, idleMs: 16 * MIN, suspect: true }).softAlert, false);

  const first = judge({ ...base, idleMs: 30 * MIN, suspect: false });
  assert.deepEqual([first.level, first.confirmCount, first.kill], ['hard', 1, false]);
  const second = judge({ ...base, idleMs: 31 * MIN, suspect: true, confirmCount: first.confirmCount });
  assert.deepEqual([second.confirmCount, second.kill], [2, true]);

  // 未越线必须把确认计数清掉，否则下一次卡死会继承旧计数
  assert.equal(judge({ ...base, idleMs: MIN, confirmCount: 1 }).confirmCount, 0);
});

// ── ② 合法长轮询（10 分钟静默）不误杀 ───────────────────────────────────
test('② 10 分钟长轮询静默期：15 档不告警、30 档不清理', async () => {
  const state = makeFakeBridge();
  const clock = { at: BASE + 10 * MIN };
  state.activeWaits.set(KEY, BASE);
  state.activeWaitStartedAt.set(KEY, BASE); // 10 分钟前开始等：这是合法静默
  state.lastEventAt.set(SID, BASE - 5 * MIN);
  state.v2TurnStartAt.set(SID, BASE - 5 * MIN);
  const { watchdog, logs, kills } = makeWatchdog(state, clock);

  for (let i = 0; i < 3; i += 1) {
    await watchdog.scan();
    clock.at += STALL_SCAN_INTERVAL_MS;
  }
  assert.equal(kills.length, 0, '合法长轮询不能被硬清理');
  assert.equal(watchdog.snapshot().suspects.length, 0, '合法长轮询不能被标 suspect');
  assert.equal(logs.filter((line) => line.includes('软告警')).length, 0);
});

// ── ③ 软告警只报一次，恢复后 suspect 清空 ───────────────────────────────
test('③ 软告警 15 分钟触发一次，同一段不重复；有新帧后 suspect 清空', async () => {
  const state = makeFakeBridge();
  const clock = { at: BASE + 16 * MIN };
  state.promptQueues.set(KEY, { queue: [], running: true, inFlight: null });
  state.lastEventAt.set(SID, BASE);
  state.v2TurnStartAt.set(SID, BASE);
  const { watchdog, logs } = makeWatchdog(state, clock);

  await watchdog.scan();
  await watchdog.scan();
  await watchdog.scan();
  assert.equal(logs.filter((line) => line.includes('软告警')).length, 1, '同一段连续越线只报一次');
  const suspects = watchdog.snapshot().suspects;
  assert.equal(suspects.length, 1);
  assert.equal(suspects[0].key, KEY);
  assert.equal(suspects[0].sessionId, SID);
  assert.equal(suspects[0].idleMinutes, 16);
  assert.ok(suspects[0].busy.includes('在飞投递'));

  // 来了一帧：idle 归零，suspect 必须清掉（否则下一次卡死会继承状态）
  state.lastEventAt.set(SID, clock.at);
  await watchdog.scan();
  assert.equal(watchdog.snapshot().suspects.length, 0);
  assert.equal(logs.filter((line) => line.includes('已恢复')).length, 1);

  // 再卡一次要能重新告警
  clock.at += 16 * MIN;
  await watchdog.scan();
  assert.equal(watchdog.snapshot().suspects.length, 1);
  assert.equal(logs.filter((line) => line.includes('软告警')).length, 2);
});

// ── ④ 硬清理要连续 2 轮确认 ─────────────────────────────────────────────
test('④ 硬线第 1 轮只确认，第 2 轮才清理', async () => {
  const state = makeFakeBridge();
  const clock = { at: BASE + 31 * MIN };
  state.promptQueues.set(KEY, { queue: [], running: true, inFlight: null });
  state.lastEventAt.set(SID, BASE);
  state.v2TurnStartAt.set(SID, BASE);
  const { watchdog, logs, kills } = makeWatchdog(state, clock);

  await watchdog.scan();
  assert.equal(kills.length, 0, '第 1 轮越线不能立刻清理');
  assert.equal(logs.filter((line) => line.includes('硬线确认')).length, 1);

  clock.at += STALL_SCAN_INTERVAL_MS;
  await watchdog.scan();
  assert.equal(kills.length, 1, '连续第 2 轮越线才清理');
  assert.equal(kills[0].key, KEY);
  assert.equal(watchdog.snapshot().stats.hardKills, 1);
  assert.equal(watchdog.snapshot().stats.lastKillKey, KEY);

  // 清完之后不再重复清理（账本被清空，collect 返回空）
  clock.at += STALL_SCAN_INTERVAL_MS;
  await watchdog.scan();
  assert.equal(kills.length, 1);
});

// ── ⑤ 七步顺序与幂等 ───────────────────────────────────────────────────
test('⑤ cleanZombieSession 先打标记再 cancel，七步都执行', async () => {
  const state = makeFakeBridge();
  const { entry, rejected } = entryWithInFlight();
  state.promptQueues.set(KEY, entry);
  state.pendingWakeKeys.add(KEY);
  state.pendingWakeArmAt.set(KEY, BASE);
  state.activeWaits.set(KEY, BASE);
  state.activeWaitStartedAt.set(KEY, BASE);
  const logs = [];
  // 顺序断言：cancel 被调用时，僵尸标记必须已经写进 zombieKilledAt
  state.api.sessions.cancel = async () => {
    assert.equal(state.zombieKilledAt.has(SID), true, '僵尸标记必须先于 cancel 打上');
    logs.push('cancel');
    return { result: { ok: true, value: {} } };
  };

  const result = await cleanZombieSession({ key: KEY, sessionId: SID }, depsOf(state, {
    log: (message) => logs.push(message)
  }));

  assert.equal(result.cancelOk, true);
  assert.equal(logs.filter((line) => line === 'cancel').length, 1, '只调用一次 cancel');
  // 七步日志齐全且顺序正确
  const steps = logs.filter((line) => /硬清理 \d\/7/.test(line)).map((line) => line.match(/硬清理 (\d)\/7/)[1]);
  assert.deepEqual(steps, ['1', '2', '3', '4', '5', '6', '7']);
  assert.ok(logs.indexOf('cancel') > logs.findIndex((line) => line.includes('硬清理 1/7')));

  // 第 3 步：在飞项 + 排队项全部 reject，并且整条删除（不能只置 running=false）
  assert.equal(rejected.length, 3, '在飞 1 条 + 排队 2 条都要 reject');
  assert.match(rejected[0].message, /看门狗清理/);
  assert.equal(state.promptQueues.has(KEY), false, '第 3 步必须 delete 整条');
  assert.equal(entry.inFlight, null);

  // 第 4/5/6/7 步
  assert.deepEqual([state.v2TurnStartAt.has(SID), state.collectors.has(SID), state.lastEventAt.has(SID)], [false, false, false]);
  assert.equal(state.activeWaitStartedAt.has(KEY), false);
  assert.deepEqual([state.pendingWakeKeys.has(KEY), state.pendingWakeArmAt.has(KEY)], [false, false]);
  assert.deepEqual(state.disarmed, [KEY]);
  assert.equal(state.activeWaits.has(KEY), false);
  assert.deepEqual([
    state.sendToolSucceededSessions.has(SID),
    state.pendingSendToolCalls.has(SID),
    state.toolCallNames.has(SID)
  ], [false, false, false]);
});

test('⑤ 幂等：重复清理不抛错、不重复 reject；session-not-found 被吞', async () => {
  const state = makeFakeBridge();
  const { entry, rejected } = entryWithInFlight();
  state.promptQueues.set(KEY, entry);
  state.pendingWakeKeys.add(KEY);
  // 依赖里两种拼写都出现过：这里用斜杠形式（dsh-client 内部就是这么吞的）
  state.api.sessions.cancel = async () => ({
    result: { ok: false, error: { code: 'session/not-found', message: 'no such session' } }
  });
  const logs = [];
  const deps = depsOf(state, { log: (message) => logs.push(message) });

  const first = await cleanZombieSession({ key: KEY, sessionId: SID }, deps);
  assert.equal(first.cancelOk, true, 'session-not-found 应当按「已不存在」处理');
  assert.deepEqual(first.errors, []);
  assert.equal(first.rejected, 3);
  // 即便 cancel 报 not-found，后面各步也都执行了
  assert.equal(logs.filter((line) => /硬清理 \d\/7/.test(line)).length, 7);
  assert.equal(rejected.length, 3);

  // 第二次：不抛错、不重复 reject
  const second = await cleanZombieSession({ key: KEY, sessionId: SID }, deps);
  assert.equal(second.rejected, 0);
  assert.equal(rejected.length, 3);
});

test('⑤ 每步独立 try/catch：cancel 抛普通错误也不影响后续清理', async () => {
  const state = makeFakeBridge();
  const { entry, rejected } = entryWithInFlight();
  state.promptQueues.set(KEY, entry);
  state.pendingWakeKeys.add(KEY);
  state.api.sessions.cancel = async () => { throw new Error('boom'); };
  const logs = [];
  const result = await cleanZombieSession({ key: KEY, sessionId: SID }, depsOf(state, {
    log: (message) => logs.push(message)
  }));
  assert.equal(result.cancelOk, false);
  assert.equal(result.errors.length, 1, '只记录失败，不抛出');
  assert.equal(rejected.length, 3, 'cancel 失败也要继续 reject');
  assert.equal(state.promptQueues.has(KEY), false);
  assert.equal(state.pendingWakeKeys.has(KEY), false);
  assert.equal(logs.filter((line) => /硬清理 \d\/7/.test(line)).length, 7);
});

// ── ⑥ 逃生开关：只软不硬 ────────────────────────────────────────────────
test('⑥ QQ_BRIDGE_WATCHDOG=off 时只软不硬', async () => {
  const state = makeFakeBridge();
  const clock = { at: BASE + 60 * MIN };
  state.promptQueues.set(KEY, { queue: [], running: true, inFlight: null });
  state.lastEventAt.set(SID, BASE);
  state.v2TurnStartAt.set(SID, BASE);
  const { watchdog, logs, kills } = makeWatchdog(state, clock, {
    enabled: parseWatchdogEnabled('off')
  });

  for (let i = 0; i < 5; i += 1) {
    await watchdog.scan();
    clock.at += STALL_SCAN_INTERVAL_MS;
  }
  assert.equal(kills.length, 0, '关掉之后永远不自动清理');
  assert.equal(watchdog.snapshot().suspects.length, 1, '软告警仍然照常工作');
  assert.ok(logs.some((line) => line.includes('软告警')));
  // 逃生开关解析：默认开启
  assert.equal(parseWatchdogEnabled(undefined), true);
  assert.equal(parseWatchdogEnabled(''), true);
  assert.equal(parseWatchdogEnabled('on'), true);
  assert.equal(parseWatchdogEnabled('OFF'), false);
});

// ── ⑦ 清理之后 idle 重算不再命中 ────────────────────────────────────────
test('⑦ 清理后账本清空，重算 idle 不再命中，新投递可以重新排队', async () => {
  const state = makeFakeBridge();
  const clock = { at: BASE + 40 * MIN };
  const { entry } = entryWithInFlight();
  state.promptQueues.set(KEY, entry);
  state.lastEventAt.set(SID, BASE);
  state.v2TurnStartAt.set(SID, BASE);
  state.pendingWakeKeys.add(KEY);
  state.pendingWakeArmAt.set(KEY, BASE);
  const { watchdog } = makeWatchdog(state, clock, {
    onHard: (record) => cleanZombieSession(record, depsOf(state, { now: () => clock.at }))
  });

  await watchdog.scan();
  clock.at += STALL_SCAN_INTERVAL_MS;
  await watchdog.scan();
  assert.equal(state.promptQueues.size, 0);
  assert.equal(watchdog.snapshot().stats.hardKills, 1);

  // 之后同一会话再投递：一切从零开始
  state.promptQueues.set(KEY, { queue: [{ reject() {} }], running: true, inFlight: null });
  const idle = computeIdle({
    lastEventAt: state.lastEventAt.get(SID) ?? 0,
    turnStartAt: state.v2TurnStartAt.get(SID) ?? 0,
    activeWaitStartedAt: state.activeWaitStartedAt.get(KEY) ?? 0,
    pendingWakeArmAt: state.pendingWakeArmAt.get(KEY) ?? 0
  }, clock.at);
  assert.equal(idle.known, false, '旧锚点必须全部消失');
  await watchdog.scan();
  assert.equal(watchdog.snapshot().stats.hardKills, 1, '刚清理过的会话不会被立刻二次清理');
});

// ── 工具函数 ────────────────────────────────────────────────────────────
test('工具函数：分钟数向上取整、错误码两种拼写都识别', () => {
  assert.equal(stallMinutes(0), 0);
  assert.equal(stallMinutes(899_999), 15);
  assert.equal(stallMinutes(900_000), 15);
  assert.equal(stallMinutes(900_001), 16);
  assert.equal(isMissingSessionError({ code: 'session/not-found' }), true);
  assert.equal(isMissingSessionError({ message: 'session.cancel failed: session-not-found: gone' }), true);
  assert.equal(isMissingSessionError({ code: 'agent-busy', message: 'busy' }), false);
  assert.equal(isMissingSessionError(undefined), false);
});

test('start/stop 用注入的定时器，且 unref，不阻塞进程退出', () => {
  let captured = null;
  let unrefed = 0;
  const watchdog = createStallWatchdog({
    collect: () => [],
    onHard: async () => {},
    now: () => 0,
    log: () => {},
    setIntervalFn: (fn, ms) => { captured = { fn, ms }; return { unref: () => { unrefed += 1; } }; },
    clearIntervalFn: () => {}
  });
  assert.equal(watchdog.start(), true);
  assert.equal(captured.ms, STALL_SCAN_INTERVAL_MS);
  assert.equal(unrefed, 1);
  assert.equal(watchdog.isRunning(), true);
  assert.equal(watchdog.start(), false, '重复 start 不重复挂定时器');
  assert.equal(watchdog.stop(), true);
  assert.equal(watchdog.isRunning(), false);
});
