// 会话永久繁忙看门狗：判定 + 清理编排（纯逻辑、零依赖、零 I/O、时钟可注入）。
//
// 背景（ISS-001）：事件流断开时若还有 turn 在飞，`deliverPromptNow` 里的
// `await api.sessions.prompt(...)` 永远不会 settle，`promptQueues` 条目的 `running`
// 就恒为 true → `isConversationBusyV2()` 恒真 → 该会话之后永远拒收新投递：
// QQ 上表现为「@ 了没反应」，日志里没有任何异常。
// 事件流 finally 里的 `drainAllPromptQueues()` 只 reject **排队**项，不碰在飞项，
// 也清不掉 `v2TurnStartAt` / `collectors` / `pendingWakeKeys`，所以这种状态只能靠
// 外部计龄收尾 —— 这就是本模块的全部职责。
//
// 为什么按「最近活动」而不是「turn 开始时间」计龄：合法静默是常态
// （qq_wait_for_messages 默认等 10 分钟，静默期内 DSH 一帧都不发；唤醒租约本身 30 分钟）。
// 只看 turn 开始时间会把每一次正常的 10 分钟长轮询都判成僵尸。
//
// 本文件不 import 任何东西，也不碰文件/网络：宿主的 Map/Set/api/log/时钟全部由
// bridge.js 注入，这样单测才能用假时钟 + 假 api 断言清理顺序与幂等。

/** 软阈值：连续 15 分钟没有任何进展 → 只记日志 + /api/status 标 suspect，不动状态。 */
export const STALL_SOFT_MS = 15 * 60 * 1000;
/** 硬阈值：连续 30 分钟没有任何进展，且连续 2 轮扫描确认 → 取消 DSH 回合并清账本。 */
export const STALL_HARD_MS = 30 * 60 * 1000;
/** 扫描周期 60 秒：与既有 checkDsh(5s)/socialLoopTick(5s) 同样走 unref 的 interval。 */
export const STALL_SCAN_INTERVAL_MS = 60 * 1000;
/** 硬清理需要的连续确认轮数（轮间隔 = 扫描周期）：单次越线可能是时钟/事件抖动。 */
export const STALL_CONFIRM_ROUNDS = 2;
/** session.cancel 的等待上限：DSH 卡死时看门狗自己不能被挂住。 */
export const STALL_CANCEL_TIMEOUT_MS = 5000;
/**
 * 「刚杀过」标记的存活时间：只用来吞掉 cancel 之后迟到的 turn/end。
 * 必须有界 —— 没有 turn/end 的僵尸会让标记永久驻留，进而吞掉**下一个正常回合**的收尾。
 */
export const STALL_ZOMBIE_MARK_TTL_MS = 10 * 60 * 1000;

/** 计龄锚点。四个取 max：任何一个在近期出现过，都说明这条链路还活着。 */
export const STALL_ANCHORS = ['lastEventAt', 'turnStartAt', 'activeWaitStartedAt', 'pendingWakeArmAt'];

/**
 * 计算 idle 毫秒数：now − max(四个锚点)。
 * - 缺锚点/非法值一律忽略，不抛错（宿主 Map 里可能是 undefined / 0 / 字符串）；
 * - 全部缺失时返回 known=false，由调用方用「首次看见它 busy 的时刻」兜底；
 * - 未来时间戳（时钟回拨、跨机器）按 now 处理，避免负 idle 把僵尸当成刚活动过。
 */
export function computeIdle(anchors, now = Date.now()) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const source = anchors && typeof anchors === 'object' ? anchors : {};
  const used = [];
  let anchorsAt = 0;
  let dominant = '';
  for (const name of STALL_ANCHORS) {
    const raw = Number(source[name]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const value = raw > at ? at : raw;
    used.push(name);
    if (value > anchorsAt) {
      anchorsAt = value;
      dominant = name;
    }
  }
  if (used.length === 0) return { known: false, idleMs: 0, anchorsAt: 0, dominant: '', used };
  return { known: true, idleMs: Math.max(0, at - anchorsAt), anchorsAt, dominant, used };
}

/**
 * 单轮判定（纯函数，不持有状态）：
 *   pass — 未越软线：同时清掉 suspect 与确认计数（有新帧就必须回落，否则下次卡死会继承计数）；
 *   soft — 越软线但未越硬线：`softAlert` 只在**这一段连续越线的第一轮**为 true（不重复刷日志）；
 *   hard — 越硬线：确认计数 +1；`kill` 还要求 enabled 且累计到 confirmRounds。
 * `enabled=false`（QQ_BRIDGE_WATCHDOG=off）时永远不 kill：只软不硬是逃生口径。
 */
export function judge(input = {}) {
  const softMs = Number.isFinite(Number(input.softMs)) ? Number(input.softMs) : STALL_SOFT_MS;
  const rawHard = Number.isFinite(Number(input.hardMs)) ? Number(input.hardMs) : STALL_HARD_MS;
  const hardMs = Math.max(softMs, rawHard);
  const confirmRounds = Math.max(1, Math.round(Number(input.confirmRounds) || STALL_CONFIRM_ROUNDS));
  const enabled = input.enabled !== false;
  const rawIdle = Number(input.idleMs);
  const idleMs = Number.isFinite(rawIdle) ? Math.max(0, rawIdle) : 0;
  const confirmCount = Math.max(0, Math.round(Number(input.confirmCount) || 0));
  const wasSuspect = input.suspect === true;
  const overSoft = idleMs >= softMs;
  const overHard = idleMs >= hardMs;
  const nextConfirm = overHard ? confirmCount + 1 : 0;
  return {
    level: overHard ? 'hard' : (overSoft ? 'soft' : 'pass'),
    overSoft,
    overHard,
    softAlert: overSoft && !wasSuspect,
    confirmCount: nextConfirm,
    kill: enabled && overHard && nextConfirm >= confirmRounds
  };
}

/**
 * 逃生开关 `QQ_BRIDGE_WATCHDOG=off`：只软不硬（不自动取消）。
 * 未设置/空串/任意其它值都返回 true —— 默认开启，ISS-001 的默认行为就是自愈。
 */
export function parseWatchdogEnabled(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return true;
  return !['off', 'false', '0', 'no', 'disable', 'disabled'].includes(value);
}

/** 日志/错误文案里的分钟数（向上取整：899999ms 要写 15 分钟，不能写 14）。 */
export function stallMinutes(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 60000);
}

/**
 * 判定「session 已不存在」。两种拼写在依赖里都出现过：
 * `session/not-found`（dsh-client.stopSessionWork 按斜杠形式吞）与 `session-not-found`。
 */
export function isMissingSessionError(error) {
  const raw = typeof error === 'string' ? error : `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  return /session[-_/ ]?not[-_ ]?found/i.test(raw);
}

/** 给 cancel 加硬超时：拿不到 AbortSignal.timeout 就退化成不加超时（不能让看门狗自己抛错）。 */
function cancelSignal(timeoutMs) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(timeoutMs);
    }
  } catch {}
  return undefined;
}

/**
 * 硬清理：取消 DSH 回合并清掉会让会话「永久繁忙」的全部本地账本。
 *
 * 七步顺序不可换（任务书 §3.3），每一步独立 try/catch —— 任何一步失败都不能影响后面的清理：
 *   1. 先**同步**打 zombieKilledAt：必须早于 cancel。cancel 会触发 turn/end，而那个迟到的
 *      turn/end 若走进正常收尾，就会给用户补发一条回复（或补一次积压唤醒）；
 *   2. 真取消（session.cancel），吞掉 session-not-found（会话已经被退役/归档是正常情况）；
 *   3. promptQueues 在飞项 + 排队项全部 reject，然后 **delete 整条**：只置 running=false
 *      会让 processPromptQueue 的 `promptQueues.get(key) === entry` 守卫失效 → 重复投递；
 *   4/5/6/7. 清计龄锚点、唤醒租约、长轮询租约、per-turn 残留。
 *
 * 幂等：重复调用时第二次各步都是空操作。不会重复 reject —— Promise 只 settle 一次，
 * 且队列条目第一次就被整条删掉了。
 */
export async function cleanZombieSession(record = {}, deps = {}) {
  const key = String(record?.key ?? '');
  const sessionId = String(record?.sessionId ?? '');
  const hardMs = Number.isFinite(Number(deps.hardMs)) ? Number(deps.hardMs) : STALL_HARD_MS;
  const cancelTimeoutMs = Math.max(1000, Number(deps.cancelTimeoutMs) || STALL_CANCEL_TIMEOUT_MS);
  const nowAt = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const safeLog = (message) => { try { log(message); } catch {} };
  const tag = sessionId ? `${key} / ${sessionId}` : key;
  const message = `回合静默超 ${stallMinutes(hardMs)} 分钟，已被看门狗清理（${key}）`;
  const result = { key, sessionId, marked: false, cancelOk: false, cancelError: null, rejected: 0, errors: [] };
  const failed = (step, error) => {
    const text = `${step}: ${error?.message ?? error}`;
    result.errors.push(text);
    safeLog(`[watchdog] 硬清理 ${tag} 第 ${step} 步失败（已继续）：${error?.message ?? error}`);
  };

  // 1/7 先打僵尸标记（同步、早于 cancel）
  try {
    const killedAt = deps.zombieKilledAt;
    if (killedAt && typeof killedAt.has === 'function') {
      if (!killedAt.has(sessionId)) killedAt.set(sessionId, nowAt());
      result.marked = true;
      safeLog(`[watchdog] 硬清理 1/7 ${tag}：已打僵尸标记（早于 cancel，用来吞掉迟到的 turn/end）`);
    } else {
      safeLog(`[watchdog] 硬清理 1/7 ${tag}：宿主未提供 zombieKilledAt（跳过）`);
    }
  } catch (error) {
    failed('1', error);
  }

  // 2/7 真取消
  try {
    const cancel = deps.api?.sessions?.cancel;
    if (typeof cancel !== 'function') throw new Error('api.sessions.cancel 不可用');
    safeLog(`[watchdog] 硬清理 2/7 ${tag}：调用 session.cancel（上限 ${stallMinutes(cancelTimeoutMs) || 1} 分钟）`);
    const response = await cancel.call(deps.api.sessions, { sessionId }, cancelSignal(cancelTimeoutMs));
    const failure = response?.result && response.result.ok === false ? response.result.error : null;
    if (!failure) {
      result.cancelOk = true;
      safeLog(`[watchdog] session.cancel 已被接受（${tag}）`);
    } else {
      const text = `${failure.code ?? ''}: ${failure.message ?? ''}`;
      result.cancelError = text;
      if (isMissingSessionError(text)) {
        result.cancelOk = true;
        safeLog(`[watchdog] session 已不存在（${failure.code ?? 'unknown'}），按已取消处理（${tag}）`);
      } else {
        failed('2', new Error(text));
      }
    }
  } catch (error) {
    result.cancelError = String(error?.message ?? error);
    if (isMissingSessionError(error)) {
      result.cancelOk = true;
      safeLog(`[watchdog] session 已不存在（${result.cancelError}），按已取消处理（${tag}）`);
    } else {
      failed('2', error);
    }
  }

  // 3/7 在飞项 + 排队项全部 reject，然后整条删除
  try {
    const queues = deps.promptQueues;
    const entry = queues && typeof queues.get === 'function' ? queues.get(key) : null;
    if (entry) {
      const inFlight = entry.inFlight;
      if (inFlight && typeof inFlight.reject === 'function') {
        entry.inFlight = null;
        try {
          inFlight.reject(new Error(message));
          result.rejected += 1;
        } catch (error) {
          failed('3.inFlight', error);
        }
      }
      const queuedItems = Array.isArray(entry.queue) ? entry.queue.slice() : [];
      for (const item of queuedItems) {
        if (!item || typeof item.reject !== 'function') continue;
        try {
          item.reject(new Error(message));
          result.rejected += 1;
        } catch (error) {
          failed('3.queued', error);
        }
      }
      if (Array.isArray(entry.queue)) entry.queue.length = 0;
      entry.running = false;
      entry.inFlight = null;
      queues.delete(key);
      safeLog(`[watchdog] 硬清理 3/7 ${tag}：已 reject ${result.rejected} 条投递并删除队列条目`);
    } else {
      safeLog(`[watchdog] 硬清理 3/7 ${tag}：没有排队条目（跳过）`);
    }
  } catch (error) {
    failed('3', error);
  }

  // 4/7 计龄锚点
  try {
    deps.v2TurnStartAt?.delete?.(sessionId);
    deps.collectors?.delete?.(sessionId);
    deps.lastEventAt?.delete?.(sessionId);
    deps.activeWaitStartedAt?.delete?.(key);
    safeLog(`[watchdog] 硬清理 4/7 ${tag}：已清计龄锚点（turnStartAt/collector/lastEventAt/activeWaitStartedAt）`);
  } catch (error) {
    failed('4', error);
  }

  // 5/7 唤醒租约
  try {
    deps.pendingWakeKeys?.delete?.(key);
    if (typeof deps.disarmPendingWakeLease === 'function') deps.disarmPendingWakeLease(key);
    deps.pendingWakeArmAt?.delete?.(key);
    safeLog(`[watchdog] 硬清理 5/7 ${tag}：已解除唤醒租约与 pendingWake 标记`);
  } catch (error) {
    failed('5', error);
  }

  // 6/7 长轮询等待租约
  try {
    deps.activeWaits?.delete?.(key);
    safeLog(`[watchdog] 硬清理 6/7 ${tag}：已清长轮询等待租约`);
  } catch (error) {
    failed('6', error);
  }

  // 7/7 per-turn 残留
  try {
    deps.sendToolSucceededSessions?.delete?.(sessionId);
    deps.pendingSendToolCalls?.delete?.(sessionId);
    deps.toolCallNames?.delete?.(sessionId);
    deps.silentTurns?.delete?.(sessionId);
    safeLog(`[watchdog] 硬清理 7/7 ${tag}：已清 per-turn 残留（发送标记/工具名/静默名额）`);
  } catch (error) {
    failed('7', error);
  }

  safeLog(`[watchdog] 硬清理完成 ${tag}：cancel=${result.cancelOk ? 'ok' : 'fail'}，reject ${result.rejected} 条`
    + `${result.errors.length ? `，失败步骤 ${result.errors.length} 处` : ''}`);
  return result;
}

/**
 * 创建看门狗实例（不自动启动；由宿主调用 start()）。
 *
 * options:
 *   collect     () => [{ key, sessionId, busy: string[], anchors: {...} }]  —— 只返回**当前 busy** 的会话
 *   onHard      (record) => Promise —— 硬清理（通常直接调 cleanZombieSession）
 *   now/log/setIntervalFn/clearIntervalFn  注入点（单测传假时钟、假 interval）
 *   softMs/hardMs/scanMs/confirmRounds/enabled  阈值与逃生开关
 *
 * 返回 { scan, start, stop, isRunning, snapshot, setEnabled }。
 * setEnabled 是运行时逃生开关（控制台「开关」页用），只切硬清理，不动扫描本身。
 * scan() 可 await：单测用它推进假时钟，生产由 interval 触发（不 await，异常只记日志）。
 */
export function createStallWatchdog(options = {}) {
  const collect = typeof options.collect === 'function' ? options.collect : () => [];
  const onHard = typeof options.onHard === 'function' ? options.onHard : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : (fn, ms) => setInterval(fn, ms);
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : (timer) => clearInterval(timer);
  const softMs = Number.isFinite(Number(options.softMs)) ? Number(options.softMs) : STALL_SOFT_MS;
  const hardMs = Math.max(softMs, Number.isFinite(Number(options.hardMs)) ? Number(options.hardMs) : STALL_HARD_MS);
  const scanMs = Math.max(1000, Number(options.scanMs) || STALL_SCAN_INTERVAL_MS);
  const confirmRounds = Math.max(1, Math.round(Number(options.confirmRounds) || STALL_CONFIRM_ROUNDS));
  // 硬清理的开关：初始值来自 QQ_BRIDGE_WATCHDOG，之后可由控制台运行时切换（setEnabled）。
  // 只门控 kill（见 judge），扫描、软告警、suspects 观测一律照常——关掉开关不等于停掉监视。
  let enabled = options.enabled !== false;

  const suspects = new Map();   // key -> 软告警记录（/api/status 的 suspects 就是它）
  const confirms = new Map();   // key -> 连续越硬线的轮数
  const firstSeen = new Map();  // key -> 没有任何锚点时的兜底计龄起点
  const killing = new Set();    // key -> 正在清理（防止同一 key 重入）
  const stats = { softHits: 0, hardKills: 0, lastKillAt: 0, lastKillKey: null };
  let timer = null;
  let scanning = false;
  let scans = 0;

  const safeLog = (message) => { try { log(message); } catch {} };

  async function scan() {
    // 上一轮清理还挂着就不重入：否则确认计数会在同一个窗口里连加两轮，
    // 「连续 2 轮确认」就退化成「一轮就杀」。
    if (scanning) return [];
    scanning = true;
    const at = now();
    const seen = new Set();
    const results = [];
    const jobs = [];
    try {
      scans += 1;
      let candidates = [];
      try {
        const listed = collect();
        if (Array.isArray(listed)) candidates = listed;
      } catch (error) {
        safeLog(`[watchdog] 收集候选失败，跳过本轮：${error?.message ?? error}`);
      }
      for (const candidate of candidates) {
        const key = String(candidate?.key ?? '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const sessionId = String(candidate?.sessionId ?? '');
        const busy = Array.isArray(candidate?.busy) ? candidate.busy.map(String) : [];
        let idle = computeIdle(candidate?.anchors, at);
        if (!idle.known) {
          // 一个锚点都没有（例如 prompt 刚投递、turn/start 还没到）：用「首次被看见 busy」兜底。
          // 既不因为缺锚点就永远不判，也不拿 0 当基准立刻误杀。
          const first = firstSeen.get(key) ?? at;
          firstSeen.set(key, first);
          idle = { known: true, idleMs: Math.max(0, at - first), anchorsAt: first, dominant: 'firstSeen', used: [] };
        } else if (firstSeen.has(key)) {
          firstSeen.delete(key);
        }
        const wasSuspect = suspects.has(key);
        const verdict = judge({
          idleMs: idle.idleMs,
          softMs,
          hardMs,
          confirmRounds,
          enabled,
          confirmCount: confirms.get(key) ?? 0,
          suspect: wasSuspect
        });
        if (verdict.overSoft) {
          if (!wasSuspect) {
            suspects.set(key, {
              key,
              sessionId,
              idleMs: idle.idleMs,
              dominant: idle.dominant,
              busy: [...busy],
              suspectSince: at
            });
            stats.softHits += 1;
            safeLog(`[watchdog] 软告警 ${sessionId ? `${key} / ${sessionId}` : key}：已 ${stallMinutes(idle.idleMs)} 分钟没有进展`
              + `（依据 ${idle.dominant}），当前忙：${busy.join('+') || 'unknown'}；`
              + `连续 ${stallMinutes(hardMs)} 分钟且连续 ${confirmRounds} 轮确认后会取消回合`);
          } else {
            const known = suspects.get(key);
            if (known) {
              known.idleMs = idle.idleMs;
              known.dominant = idle.dominant;
              known.busy = [...busy];
            }
          }
        } else if (wasSuspect) {
          suspects.delete(key);
          safeLog(`[watchdog] 已恢复 ${key}：最近一次活动在 ${stallMinutes(idle.idleMs)} 分钟内，清除 suspect 标记`);
        }
        if (verdict.confirmCount > 0) confirms.set(key, verdict.confirmCount);
        else confirms.delete(key);
        if (verdict.kill) {
          jobs.push({ key, sessionId, idleMs: idle.idleMs, dominant: idle.dominant, busy: [...busy] });
        } else if (verdict.overHard) {
          safeLog(`[watchdog] 硬线确认 ${key}：第 ${verdict.confirmCount}/${confirmRounds} 轮`
            + `（连续 ${stallMinutes(idle.idleMs)} 分钟无进展），下一轮仍越线才清理`);
        }
        results.push({ key, sessionId, idleMs: idle.idleMs, level: verdict.level, kill: verdict.kill });
      }
      // 本轮没出现的 key（已不再 busy 或被清理掉）必须把 suspect/确认计数一起清掉，
      // 否则下一次卡死会继承上一次的状态。
      for (const key of [...suspects.keys()]) if (!seen.has(key)) suspects.delete(key);
      for (const key of [...confirms.keys()]) if (!seen.has(key)) confirms.delete(key);
      for (const key of [...firstSeen.keys()]) if (!seen.has(key)) firstSeen.delete(key);
      // 硬清理串行执行：并发取消多个回合会让日志与状态难以对应，收益也不大。
      for (const job of jobs) {
        if (killing.has(job.key)) continue;
        killing.add(job.key);
        suspects.delete(job.key);
        confirms.delete(job.key);
        firstSeen.delete(job.key);
        safeLog(`[watchdog] 硬清理开始 ${job.key}${job.sessionId ? ` / ${job.sessionId}` : ''}：`
          + `连续 ${stallMinutes(job.idleMs)} 分钟无进展（依据 ${job.dominant}），当前忙：${job.busy.join('+') || 'unknown'}`);
        try {
          if (!onHard) throw new Error('未注入 onHard');
          await onHard({ ...job });
          stats.hardKills += 1;
          stats.lastKillAt = now();
          stats.lastKillKey = job.key;
          safeLog(`[watchdog] 硬清理完成 ${job.key}：会话已从「永久繁忙」状态解锁，新投递可以重新排队`);
        } catch (error) {
          safeLog(`[watchdog] 硬清理失败 ${job.key}：${error?.message ?? error}`);
        } finally {
          killing.delete(job.key);
        }
      }
      return results;
    } finally {
      scanning = false;
    }
  }

  function start() {
    if (timer) return false;
    try {
      timer = setIntervalFn(() => {
        scan().catch((error) => safeLog(`[watchdog] 扫描异常：${error?.message ?? error}`));
      }, scanMs);
      timer?.unref?.();
    } catch (error) {
      timer = null;
      safeLog(`[watchdog] 启动失败（不影响主链路）：${error?.message ?? error}`);
      return false;
    }
    // 这里不再指名 QQ_BRIDGE_WATCHDOG：开关的初始值来自那个环境变量，但运行中还能被
    // 控制台改（setEnabled），定时器若被 stop/start 重建，指名环境变量就会说错话。
    safeLog(`[watchdog] 已启动：每 ${Math.round(scanMs / 1000)} 秒扫描一次，软 ${stallMinutes(softMs)} 分钟，`
      + `硬 ${stallMinutes(hardMs)} 分钟 × ${confirmRounds} 轮${enabled ? '' : '（自动硬清理已关闭：只软不硬）'}`);
    return true;
  }

  function stop() {
    if (!timer) return false;
    try { clearIntervalFn(timer); } catch {}
    timer = null;
    safeLog('[watchdog] 已停止扫描');
    return true;
  }

  function isRunning() {
    return !!timer;
  }

  /**
   * 运行时切换「自动硬清理」开关，返回**是否发生了状态变化**（宿主用它决定要不要记日志）。
   *
   * 三条纪律：
   *   1. 只认 `next === true`：`'true'`、`1`、`{}` 一律当 false —— 调用方必须给真布尔值，
   *      免得一个拼错的字符串悄悄把逃生开关关掉。
   *   2. 这里**不打日志**（本模块零 I/O）：要记就由宿主按返回值记。
   *   3. 不动扫描、不动 confirms/软告警。所以关掉再打开，之前累计的确认轮数还在：
   *      会话若仍越硬线，重新打开后的下一轮就会清理——这正是"还卡着就清掉"的期望语义。
   * @param {boolean} next
   * @returns {boolean} 状态是否变化
   */
  function setEnabled(next) {
    const previous = enabled;
    enabled = next === true;
    return previous !== enabled;
  }

  /** /api/status 的 watchdog 字段：suspects 只带 key/时长/忙的原因，不带消息内容。 */
  function snapshot() {
    return {
      enabled,
      softMs,
      hardMs,
      scanMs,
      confirmRounds,
      scans,
      running: !!timer,
      suspects: [...suspects.values()].map((item) => ({
        key: item.key,
        sessionId: item.sessionId,
        idleMs: item.idleMs,
        idleMinutes: stallMinutes(item.idleMs),
        dominant: item.dominant,
        busy: [...item.busy],
        since: item.suspectSince
      })),
      stats: { ...stats }
    };
  }

  return { scan, start, stop, isRunning, snapshot, setEnabled };
}
