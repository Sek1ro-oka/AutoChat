#!/usr/bin/env node
/**
 * 杀戮尖塔（1 代）sidecar：把 CommunicationMod 的 stdio 协议翻译成 HTTP。
 *
 * 为什么需要这一层：
 *   游戏侧（ModTheSpire + CommunicationMod）只会「按行读 stdin / 按行写 stdout」，
 *   而且写出去的是**纯文本命令**（PLAY 1 0 / END / CHOOSE 2 …），不是 JSON。
 *   QQ 机器人那侧（agent / 桥接）只方便说 HTTP+JSON。所以这里做三件事：
 *     1. stdin 行 → 解析 JSON → 保存最新 game_state（内存 + state/latest.json）；
 *     2. HTTP GET /state → 返回「瘦身」后的状态（去掉 uuid/贴图/整副牌库这类噪声）；
 *     3. HTTP POST /act → 校验 action 白名单 → 拼成 CommunicationMod 认识的文本命令写回 stdout。
 *
 * 为什么零第三方依赖：
 *   这个进程是**游戏**拉起来的子进程，工作目录/环境由 Steam 决定，不能指望 npm install 过；
 *   只用 node: 内置模块才能保证「游戏一启动它就能跑」。
 *
 * 为什么日志只能写 stderr：
 *   stdout 是给 CommunicationMod 的命令通道，任何一行杂音都会被当成命令（或污染 ready 握手），
 *   轻则报 InvalidCommandException，重则游戏卡住。所以本文件里**不允许出现 console.log**。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, 'state');
const STATE_FILE = path.join(STATE_DIR, 'latest.json');

// 端口/主机：只绑 127.0.0.1。为什么不是 0.0.0.0：这是给本机 agent 用的，暴露到局域网等于把游戏控制权交出去。
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.STS_PORT ?? '47800', 10);
// 多久没收到新状态就算「不新鲜」。游戏停在某个界面不动时不会推状态，所以这只是提示，不影响 ok。
const STALE_MS = Number.parseInt(process.env.STS_STALE_MS ?? '120000', 10);
// POST body 上限：正常指令就几十字节，给到 64KB 已经非常宽松，防止被灌爆内存。
const MAX_BODY = 64 * 1024;

/**
 * action 白名单。
 * 取值来自 CommunicationMod v1.2.1 源码 CommandExecutor.executeCommand() 的 switch 分支
 * （confirm/proceed 同一分支，skip/cancel/return/leave 同一分支），不是我们自己编的。
 */
const ALLOWED_ACTIONS = Object.freeze([
  'play',
  'end',
  'choose',
  'potion',
  'proceed',
  'confirm',
  'return',
  'skip',
  'cancel',
  'leave',
  'start',
  'key',
  'click',
  'wait',
  'state',
]);

/** KEY 命令的合法键名，来自 CommandExecutor.getKeycode()。 */
const KEY_NAMES = Object.freeze([
  'confirm',
  'cancel',
  'map',
  'deck',
  'draw_pile',
  'discard_pile',
  'exhaust_pile',
  'end_turn',
  'up',
  'down',
  'left',
  'right',
  'drop_card',
  'card_1',
  'card_2',
  'card_3',
  'card_4',
  'card_5',
  'card_6',
  'card_7',
  'card_8',
  'card_9',
  'card_10',
]);

/**
 * START 允许的职业名。
 * CommandExecutor 用 PlayerClass.name() 做 equalsIgnoreCase 比较（IRONCLAD / THE_SILENT / DEFECT / WATCHER），
 * 另外单独把 "silent" 映射到 THE_SILENT（源码注释里说明这是为了好用），这里照抄。
 */
const PLAYER_CLASSES = Object.freeze(['ironclad', 'silent', 'the_silent', 'defect', 'watcher']);

// ---------------------------------------------------------------- 运行时状态
/** @type {any} 原始 game_state（未瘦身），给 /state?raw=1 用 */
let lastGameState = null;
/** @type {any} 瘦身后的状态，给 /state 用 */
let lastTrimmed = null;
let lastStateAtMs = 0;
let lastError = null;
let lastErrorAtMs = 0;
let lastCommand = null;
let lastCommandAtMs = 0;
let handshakeSent = false;

/** 顶层协议字段（不随 game_state 变化的那部分） */
let proto = { available_commands: [], ready_for_command: false, in_game: false };

const counters = {
  linesIn: 0, // stdin 收到多少行
  statesIn: 0, // 其中合法的 game_state 消息
  badJson: 0, // 非 JSON 行（被跳过，不崩）
  ignoredJson: 0, // 是 JSON 但不认识（既没 game_state 也没 error）
  gameErrors: 0, // 游戏回传的 {"error": ...}
  commandsOut: 0, // 我们往 stdout 写了多少条命令
};

/** 只写 stderr：stdout 是命令通道（见文件头注释）。 */
function log(...parts) {
  try {
    process.stderr.write(`[sts-bridge] ${parts.join(' ')}\n`);
  } catch {
    /* stderr 也断了就算了，绝不能因此抛异常把进程弄死 */
  }
}

/**
 * 往 stdout 写一行命令。
 * 为什么固定用 '\n' 而不是 os.EOL：CommunicationMod 的 DataReader 只认 '\n' 和 '\0' 断行，
 * 写 '\r\n' 会把 '\r' 留在消息里，虽然多数命令靠 split("\\s+") 能吃下，但 CHOOSE 名称匹配会挂。
 */
function writeLine(text) {
  try {
    process.stdout.write(`${text}\n`);
    return true;
  } catch (e) {
    log('写 stdout 失败（管道可能已断开）：', e?.message ?? e);
    return false;
  }
}

// ---------------------------------------------------------------- 状态瘦身
function trimPowers(list) {
  if (!Array.isArray(list)) return [];
  // 只留 name/amount：powers 里还有 misc、just_applied、甚至整张卡对象，模型不需要。
  return list.map((p) => ({ name: p?.name ?? null, amount: p?.amount ?? null }));
}

function trimCard(c) {
  return {
    name: c?.name ?? null,
    id: c?.id ?? null,
    type: c?.type ?? null,
    cost: c?.cost ?? null,
    // 协议里叫 is_playable，这里按「给模型看」的习惯改名 can_play，并保持布尔语义。
    can_play: c?.is_playable === true,
    has_target: c?.has_target === true,
    rarity: c?.rarity ?? null,
    upgrades: c?.upgrades ?? 0,
  };
}

function trimMonster(m) {
  const adjusted = m?.move_adjusted_damage;
  const base = m?.move_base_damage;
  return {
    name: m?.name ?? null,
    id: m?.id ?? null,
    hp: m?.current_hp ?? null,
    max_hp: m?.max_hp ?? null,
    block: m?.block ?? 0,
    intent: m?.intent ?? null,
    // 实际会吃到的伤害优先（move_adjusted_damage），为 -1/缺失时退回到基础伤害。
    damage: typeof adjusted === 'number' && adjusted >= 0 ? adjusted : (base ?? null),
    hits: m?.move_hits ?? 1,
    powers: trimPowers(m?.powers),
    is_gone: m?.is_gone === true,
    half_dead: m?.half_dead === true,
  };
}

function countOf(list) {
  return Array.isArray(list) ? list.length : 0;
}

/**
 * 把 CommunicationMod 的 game_state 压成「够决策用」的字段。
 * 字段名一律来自 GameStateConverter.java 的真实输出，没有一处是臆造的；
 * 唯一例外是 can_play（= is_playable 的别名）与 players/monsters 里的 hp 简写。
 */
function trimState(msg) {
  const gs = msg?.game_state ?? {};
  const cs = gs.combat_state ?? null;

  const out = {
    // 顶层：现在是什么界面、在哪一层、血量金钱这些每步都要看的
    screen_type: gs.screen_type ?? null,
    screen_name: gs.screen_name ?? null,
    is_screen_up: gs.is_screen_up ?? null,
    room_type: gs.room_type ?? null,
    room_phase: gs.room_phase ?? null,
    action_phase: gs.action_phase ?? null,
    floor: gs.floor ?? null,
    act: gs.act ?? null,
    act_boss: gs.act_boss ?? null,
    ascension_level: gs.ascension_level ?? null,
    class: gs.class ?? null,
    current_hp: gs.current_hp ?? null,
    max_hp: gs.max_hp ?? null,
    gold: gs.gold ?? null,

    // 协议元信息：模型要靠 available_commands 判断现在能干什么
    available_commands: Array.isArray(msg?.available_commands) ? msg.available_commands : [],
    ready_for_command: msg?.ready_for_command === true,
    in_game: msg?.in_game === true,

    // 选择项：协议里叫 choice_list（顶层字段），对外同时暴露成 choices 更好读
    choices: Array.isArray(gs.choice_list) ? gs.choice_list : [],

    relics: Array.isArray(gs.relics) ? gs.relics.map((r) => ({ name: r?.name ?? null, counter: r?.counter ?? null })) : [],
    // potions 的数组下标就是药水槽位号，POTION 命令用的就是这个 slot
    potions: Array.isArray(gs.potions)
      ? gs.potions.map((p, i) => ({
          slot: i,
          name: p?.name ?? null,
          can_use: p?.can_use === true,
          can_discard: p?.can_discard === true,
          requires_target: p?.requires_target === true,
        }))
      : [],
  };

  // 只有战斗里才有 combat_state；其余界面（地图/商店/事件）没有，去掉这一坨能省很多 token
  if (cs && typeof cs === 'object') {
    out.turn = cs.turn ?? null;
    out.player = {
      hp: cs.player?.current_hp ?? gs.current_hp ?? null,
      max_hp: cs.player?.max_hp ?? gs.max_hp ?? null,
      block: cs.player?.block ?? 0,
      energy: cs.player?.energy ?? null,
      powers: trimPowers(cs.player?.powers),
      orbs: Array.isArray(cs.player?.orbs)
        ? cs.player.orbs.map((o) => ({ name: o?.name ?? null, passive: o?.passive_amount ?? null, evoke: o?.evoke_amount ?? null }))
        : [],
    };
    out.hand = Array.isArray(cs.hand) ? cs.hand.map(trimCard) : [];
    out.monsters = Array.isArray(cs.monsters) ? cs.monsters.map(trimMonster) : [];
    // 抽牌堆/弃牌堆/消耗堆只给数量：具体牌序对正常决策没用，全量会把上下文撑爆。
    out.piles = {
      draw: countOf(cs.draw_pile),
      discard: countOf(cs.discard_pile),
      exhaust: countOf(cs.exhaust_pile),
    };
  }

  return out;
}

/**
 * 落盘 state/latest.json。
 * 为什么用 tmp + rename：外部（agent/人）可能随时读这个文件，直接覆写会读到半截 JSON。
 * 这里存「瘦身版 + 元信息」，原始状态靠 /state?raw=1 取（避免磁盘上堆一份超大的 deck/map）。
 */
function persistTrimmed() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const payload = {
      receivedAtMs: lastStateAtMs,
      receivedAt: new Date(lastStateAtMs).toISOString(),
      available_commands: proto.available_commands,
      ready_for_command: proto.ready_for_command,
      state: lastTrimmed,
    };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log('写 state/latest.json 失败（不影响服务）：', e?.message ?? e);
  }
}

// ---------------------------------------------------------------- stdin：游戏 → 我们
function handleLine(rawLine) {
  const line = rawLine.replace(/\r$/, '').trim();
  if (!line) return;
  counters.linesIn += 1;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // 非 JSON 行：按需求「跳过并计数」，绝不崩。常见于有人在 stdout 里手打过字、或别的进程串了管道。
    counters.badJson += 1;
    log(`跳过非 JSON 行（累计 ${counters.badJson} 条）：`, JSON.stringify(line.slice(0, 120)));
    return;
  }

  if (!msg || typeof msg !== 'object') {
    counters.badJson += 1;
    return;
  }

  // 游戏执行命令失败时会回一行 {"error": "...", "ready_for_command": true}
  if (typeof msg.error === 'string') {
    counters.gameErrors += 1;
    lastError = msg.error;
    lastErrorAtMs = Date.now();
    if (typeof msg.ready_for_command === 'boolean') proto.ready_for_command = msg.ready_for_command;
    log('游戏回传错误：', msg.error);
    return;
  }

  if (msg.game_state && typeof msg.game_state === 'object') {
    counters.statesIn += 1;
    lastGameState = msg.game_state;
    lastStateAtMs = Date.now();
    lastError = null;
    proto = {
      available_commands: Array.isArray(msg.available_commands) ? msg.available_commands : [],
      ready_for_command: msg.ready_for_command === true,
      in_game: msg.in_game === true,
    };
    lastTrimmed = trimState(msg);
    persistTrimmed();
    return;
  }

  counters.ignoredJson += 1;
  log('忽略了不认识的 JSON 消息（既不是 game_state 也不是 error）');
}

// ---------------------------------------------------------------- 命令构造：HTTP → 游戏
class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/** 取整数字段，越界/非整数一律 400 —— 白名单的另一半：参数也别让模型乱填。 */
function needInt(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') {
    throw new BadRequest(`${field} 必填（整数，范围 ${min}..${max}）`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) {
    throw new BadRequest(`${field} 必须是整数，收到 ${JSON.stringify(value)}`);
  }
  if (n < min || n > max) {
    throw new BadRequest(`${field} 超出范围 ${min}..${max}，收到 ${n}`);
  }
  return n;
}

function optInt(value, field, bounds) {
  if (value === undefined || value === null || value === '') return null;
  return needInt(value, field, bounds);
}

/**
 * action → CommunicationMod 的一行文本命令。
 * 注意几个协议细节（都对着 CommandExecutor.java 抄的）：
 *   - PLAY 的 CardIndex 是 **1 起**（对应界面卡牌左上角编号），0 会被源码特判成第 10 张，这里直接禁掉以免歧义；
 *   - PLAY 的 TargetIndex 是 monsters 数组的 **0 起**下标；
 *   - POTION 的槽位是 0 起（= /state.potions[].slot）；
 *   - START 的顺序是「职业 进阶 种子」，种子可省、进阶不可省（省了就没法给种子）。
 * 返回 { action, line }。
 */
function buildCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequest('body 必须是一个 JSON 对象，例如 {"action":"end"}');
  }
  const action = String(body.action ?? '').trim().toLowerCase();
  if (!action) throw new BadRequest('缺少 action 字段');
  if (!ALLOWED_ACTIONS.includes(action)) {
    // 这就是「防止模型凭空发明指令」的那道闸：不认识的 action 一律 400，绝不透传给游戏
    throw new BadRequest(`action "${action}" 不在白名单内，允许：${ALLOWED_ACTIONS.join(', ')}`);
  }

  const int10 = { min: 1, max: 10 };
  const idx10 = { min: 0, max: 9 };

  switch (action) {
    case 'play': {
      let card;
      if (body.card_index !== undefined && body.card_index !== null) {
        card = needInt(body.card_index, 'card_index', int10);
      } else if (body.hand_index !== undefined && body.hand_index !== null) {
        // 给模型一个 0 起的入口：直接对着 /state.hand 的数组下标说话，省得它自己 +1 算错
        card = needInt(body.hand_index, 'hand_index', idx10) + 1;
      } else {
        throw new BadRequest('play 需要 card_index（1..10，界面编号）或 hand_index（0..9，/state.hand 下标）');
      }
      const target = optInt(body.target_index, 'target_index', idx10);
      return { action, line: target === null ? `PLAY ${card}` : `PLAY ${card} ${target}` };
    }
    case 'end':
      return { action, line: 'END' };
    case 'choose': {
      if (typeof body.choice === 'string' && body.choice.trim()) {
        // 源码 merge_arguments() 把多个 token 用单空格重新拼起来，所以这里先规范空格，避免名字选不中
        const name = body.choice.replace(/\s+/g, ' ').trim();
        if (name.length > 120) throw new BadRequest('choice 名称太长');
        return { action, line: `CHOOSE ${name}` };
      }
      const idx = needInt(body.choice_index, 'choice_index', { min: 0, max: 99 });
      return { action, line: `CHOOSE ${idx}` };
    }
    case 'potion': {
      const mode = String(body.mode ?? '').trim().toLowerCase();
      if (mode !== 'use' && mode !== 'discard') {
        throw new BadRequest('potion 需要 mode: "use" 或 "discard"');
      }
      const slot = needInt(body.slot ?? body.potion_slot, 'slot', idx10);
      const target = optInt(body.target_index, 'target_index', idx10);
      if (mode === 'discard') return { action, line: `POTION Discard ${slot}` };
      return { action, line: target === null ? `POTION Use ${slot}` : `POTION Use ${slot} ${target}` };
    }
    case 'proceed':
    case 'confirm':
      // PROCEED 与 CONFIRM 在协议里等价，统一发 PROCEED
      return { action, line: 'PROCEED' };
    case 'return':
    case 'skip':
    case 'cancel':
    case 'leave':
      // 同理，RETURN = SKIP = CANCEL = LEAVE
      return { action, line: 'RETURN' };
    case 'start': {
      const cls = String(body.class ?? body.player_class ?? '').trim().toLowerCase();
      if (!PLAYER_CLASSES.includes(cls)) {
        throw new BadRequest(`class 必须是 ${PLAYER_CLASSES.join(' / ')} 之一`);
      }
      const asc = optInt(body.ascension_level ?? body.ascension, 'ascension_level', { min: 0, max: 20 });
      let seed = null;
      if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
        seed = String(body.seed).trim().toUpperCase();
        if (!/^[A-Z0-9]{1,20}$/.test(seed)) throw new BadRequest('seed 只能是大写字母/数字（1..20 位）');
      }
      let line = `START ${cls}`;
      if (asc !== null) line += ` ${asc}`;
      else if (seed) throw new BadRequest('要指定 seed 就必须同时给 ascension_level（协议顺序：职业 进阶 种子）');
      if (seed) line += ` ${seed}`;
      return { action, line };
    }
    case 'key': {
      const key = String(body.key ?? body.keyname ?? '').trim().toLowerCase();
      if (!KEY_NAMES.includes(key)) {
        throw new BadRequest(`key 必须是 ${KEY_NAMES.join(' / ')} 之一`);
      }
      const timeout = optInt(body.timeout, 'timeout', { min: 0, max: 1000 });
      return { action, line: timeout === null ? `KEY ${key}` : `KEY ${key} ${timeout}` };
    }
    case 'click': {
      const button = String(body.button ?? 'left').trim().toLowerCase();
      if (button !== 'left' && button !== 'right') throw new BadRequest('button 只能是 "left" 或 "right"');
      const x = needInt(body.x, 'x', { min: 0, max: 1920 });
      const y = needInt(body.y, 'y', { min: 0, max: 1080 });
      return { action, line: `CLICK ${button === 'left' ? 'Left' : 'Right'} ${x} ${y}` };
    }
    case 'wait': {
      const timeout = optInt(body.timeout, 'timeout', { min: 0, max: 1000 });
      return { action, line: `WAIT ${timeout === null ? 100 : timeout}` };
    }
    case 'state':
      return { action, line: 'STATE' };
    default:
      throw new BadRequest(`未实现的 action：${action}`);
  }
}

/** 当前状态下的 available_commands 里，这个 action 有没有对得上的名字（只用来提示，不拦）。 */
function availabilityWarning(action) {
  const names = proto.available_commands.map((s) => String(s).toLowerCase());
  if (names.length === 0) return null;
  const aliases = {
    proceed: ['proceed', 'confirm'],
    confirm: ['confirm', 'proceed'],
    return: ['return', 'skip', 'cancel', 'leave'],
    skip: ['skip', 'cancel', 'return', 'leave'],
    cancel: ['cancel', 'skip', 'return', 'leave'],
    leave: ['leave', 'skip', 'cancel', 'return'],
  };
  const want = aliases[action] ?? [action];
  if (want.some((w) => names.includes(w))) return null;
  return `当前 available_commands 不含 ${action}（当前可用：${names.join(', ')}），命令可能被游戏拒绝`;
}

// ---------------------------------------------------------------- HTTP 服务
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest(`请求体超过 ${MAX_BODY} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function healthPayload() {
  const now = Date.now();
  const stateAgeMs = lastStateAtMs ? now - lastStateAtMs : null;
  return {
    // ok 的语义：当前手里有没有一份可用的游戏状态。没启动游戏时必须是 false（README/agent 靠它判断）。
    // 特意不用 counters.statesIn > 0：counter 是累计量，POST /reset 之后它仍然是正数，
    // 会导致「重置完了还说自己 ok」，把「有没有状态」和「收到过多少次」两件事混在一起。
    ok: Boolean(lastTrimmed),
    pid: process.pid,
    host: HOST,
    port: PORT,
    handshakeSent,
    lastStateAtMs: lastStateAtMs || null,
    stateAgeMs,
    stale: stateAgeMs === null ? true : stateAgeMs > STALE_MS,
    screenType: lastTrimmed?.screen_type ?? null,
    screenName: lastTrimmed?.screen_name ?? null,
    inGame: proto.in_game,
    readyForCommand: proto.ready_for_command,
    availableCommands: proto.available_commands,
    allowed_actions: ALLOWED_ACTIONS,
    lastError,
    lastErrorAtMs: lastErrorAtMs || null,
    lastCommand,
    lastCommandAtMs: lastCommandAtMs || null,
    counters,
    stateFile: STATE_FILE,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad_url' });
  }
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /health') {
      return sendJson(res, 200, healthPayload());
    }

    if (route === 'GET /state') {
      if (!lastTrimmed) {
        // 如实返回：游戏没起来/还没连上，而不是编一份空状态
        return sendJson(res, 503, {
          ok: false,
          error: 'no_state_yet',
          hint: '还没收到 game_state：确认游戏是用 MTS.cmd 启动的、CommunicationMod 已在 ModTheSpire 界面勾选',
        });
      }
      const wantRaw = url.searchParams.get('raw') === '1' || url.searchParams.get('full') === '1';
      if (wantRaw) {
        // 逃生口：调试/写解析器时要看原始字段（含 deck、map、screen_state）
        return sendJson(res, 200, { ok: true, updatedAtMs: lastStateAtMs, raw: true, state: lastGameState });
      }
      return sendJson(res, 200, {
        ok: true,
        updatedAtMs: lastStateAtMs,
        available_commands: proto.available_commands,
        ready_for_command: proto.ready_for_command,
        state: lastTrimmed,
      });
    }

    if (route === 'POST /act') {
      const text = await readBody(req);
      let body;
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid_json', hint: 'body 必须是 JSON 对象' });
      }
      // 先校验（白名单/参数），再判断连接状态：这样即使游戏没开，非法 action 也稳定返回 400
      const built = buildCommand(body);
      // 用 lastTrimmed 而不是累计计数：/reset 之后没有状态，就不该再往 stdout 写命令。
      // 例外是 state —— 它只是让游戏立刻回传一份状态，没有状态时正是最需要它的场景。
      if (!lastTrimmed && built.action !== 'state') {
        return sendJson(res, 503, {
          ok: false,
          error: 'no_state_yet',
          hint: '还没收到 game_state，命令没发出去（避免盲发到不存在的游戏）',
          would_send: built,
        });
      }
      const warning = availabilityWarning(built.action);
      if (!writeLine(built.line)) {
        return sendJson(res, 502, { ok: false, error: 'stdout_write_failed', would_send: built });
      }
      counters.commandsOut += 1;
      lastCommand = built.line;
      lastCommandAtMs = Date.now();
      const payload = { ok: true, sent: { action: built.action, line: built.line } };
      if (warning) payload.warnings = [warning];
      return sendJson(res, 200, payload);
    }

    if (route === 'POST /reset') {
      lastGameState = null;
      lastTrimmed = null;
      lastStateAtMs = 0;
      lastError = null;
      lastErrorAtMs = 0;
      proto = { available_commands: [], ready_for_command: false, in_game: false };
      try {
        fs.rmSync(STATE_FILE, { force: true });
      } catch (e) {
        log('删除 state/latest.json 失败：', e?.message ?? e);
      }
      log('状态已重置（重开游戏时用）');
      return sendJson(res, 200, { ok: true, cleared: true });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found', routes: ['GET /health', 'GET /state', 'POST /act', 'POST /reset'] });
  } catch (e) {
    if (e instanceof BadRequest) {
      return sendJson(res, 400, { ok: false, error: 'bad_request', message: e.message });
    }
    log('HTTP 处理异常：', e?.stack ?? e);
    return sendJson(res, 500, { ok: false, error: 'internal_error', message: String(e?.message ?? e) });
  }
});

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    // 端口被占（多半是上一次的 sidecar 没退干净）：HTTP 用不了，但 stdio 通道必须继续活着，
    // 否则 CommunicationMod 会认为子进程死了并卡住游戏。
    log(`端口 ${PORT} 已被占用：HTTP 不可用，stdio 通道继续工作。用 STS_PORT 换端口或先关掉占用者。`);
  } else {
    log('HTTP 服务启动失败（stdio 通道继续工作）：', e?.message ?? e);
  }
});

server.listen(PORT, HOST, () => {
  log(`HTTP 已监听 http://${HOST}:${PORT}（pid ${process.pid}）`);
});

// ---------------------------------------------------------------- 启动：先握手，再接 stdin
// CommunicationMod 拉起本进程后会阻塞等第一行输出（默认最多 10 秒），收不到就杀掉我们。
// 官方 FAQ 要求打印 "Ready"，所以这里必须是第一行，且要在任何日志/耗时操作之前。
handshakeSent = writeLine('Ready');
log(`已发出 ready 握手（pid ${process.pid}）`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  try {
    handleLine(line);
  } catch (e) {
    // 单行处理出错不能让进程挂掉：我们一死，MTS 的读线程会在 EOF 上空转，游戏就卡住了
    log('处理 stdin 行时出错（已忽略该行）：', e?.stack ?? e);
  }
});
rl.on('close', () => {
  log('stdin 已关闭：游戏进程可能已退出。HTTP 继续服务（/health 仍是最后一次收到的状态）。');
});

process.stdin.on('error', (e) => {
  log('stdin 出错（继续运行）：', e?.message ?? e);
});

// 最后一道保险：任何漏网的异常都只记日志，不让进程退出
process.on('uncaughtException', (e) => log('未捕获异常（继续运行）：', e?.stack ?? e));
process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝（继续运行）：', e?.stack ?? e));

process.on('SIGINT', () => {
  log('收到 SIGINT，退出');
  process.exit(0);
});
