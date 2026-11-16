#!/usr/bin/env node
/**
 * bridge.mjs 的离线自测。
 *
 * 为什么不直接单元测试 trimState()：
 *   真正容易坏的是「进程边界」上的东西 —— ready 握手、stdin 半行/坏行、stdout 是否只输出命令、
 *   HTTP 白名单是否在没连游戏时也能正确拒绝。所以这里把 bridge.mjs 当成真子进程拉起来，
 *   用假的 stdin 喂真实形状的 game_state，再从 HTTP 侧断言。
 *
 * 用法：node selftest.mjs
 * 退出码：0 = 全过；1 = 有断言失败。
 *
 * 依赖：只用 node 内置模块（fetch 是 Node 18+ 自带的，本机 Node 24）。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge.mjs');
// 用非默认端口，避免和真正在跑的 sidecar（47800）抢端口
const PORT = Number(process.env.SELFTEST_PORT ?? '47871');
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}
function section(title) {
  console.log(`\n== ${title} ==`);
}

/**
 * 真实形状的 game_state。
 * 字段名全部照抄 CommunicationMod v1.2.1 的 GameStateConverter.java 输出
 * （README 里那段 Jaw Worm 样例就是同一个结构），刻意保留 uuid / exhausts / ethereal / deck / map
 * 这些「噪声」字段，用来验证 /state 确实把它们削掉了。
 */
function makeStateMessage() {
  const card = (name, id, cost, playable, target, type = 'ATTACK', rarity = 'BASIC') => ({
    exhausts: false,
    is_playable: playable,
    cost,
    name,
    id,
    type,
    ethereal: false,
    uuid: '7b54caef-9c56-4134-82a2-be8f1d5c435f',
    upgrades: 0,
    rarity,
    has_target: target,
  });

  const monster = {
    is_gone: false,
    move_hits: 1,
    move_base_damage: 12,
    half_dead: false,
    move_adjusted_damage: -1,
    max_hp: 46,
    intent: 'ATTACK',
    move_id: 1,
    name: 'Jaw Worm',
    current_hp: 44,
    block: 0,
    id: 'JawWorm',
    powers: [{ id: 'Strength', name: 'Strength', amount: 2 }],
  };

  return {
    available_commands: ['play', 'end', 'key', 'click', 'wait', 'state'],
    ready_for_command: true,
    in_game: true,
    game_state: {
      screen_type: 'NONE',
      // 真实消息里 screen_state 常常是一大坨；这里放个明显不该出现在 /state 里的键来验证裁剪
      screen_state: { should_be_dropped: true },
      seed: -3047511808784702860,
      room_type: 'MonsterRoom',
      room_phase: 'COMBAT',
      action_phase: 'WAITING_ON_USER',
      current_hp: 72,
      max_hp: 80,
      gold: 99,
      floor: 1,
      act: 1,
      act_boss: 'Hexaghost',
      ascension_level: 20,
      class: 'IRONCLAD',
      is_screen_up: false,
      screen_name: 'NONE',
      choice_list: ['Strike', 'Defend'],
      relics: [
        { id: 'Burning Blood', name: 'Burning Blood', counter: -1 },
        { id: 'Bag of Preparation', name: 'Bag of Preparation', counter: -1 },
      ],
      potions: [
        { id: 'Fire Potion', name: 'Fire Potion', can_use: true, can_discard: true, requires_target: false },
        { id: 'Potion Slot', name: 'Potion Slot', can_use: false, can_discard: false, requires_target: false },
      ],
      // 整副牌库：真实消息里很长，/state 里只应该有 hand
      deck: [card('Strike', 'Strike_R', 1, true, true), card('Defend', 'Defend_R', 1, true, false, 'SKILL')],
      map: { current_node: { x: 3, y: 0 }, next_nodes: [{ x: 1, y: 1 }] },
      combat_state: {
        draw_pile: [card('Strike', 'Strike_R', 1, true, true), card('Defend', 'Defend_R', 1, true, false, 'SKILL')],
        discard_pile: [],
        exhaust_pile: [],
        limbo: [],
        hand: [
          card('Strike', 'Strike_R', 1, true, true),
          card('Defend', 'Defend_R', 1, true, false, 'SKILL'),
          card('Bash', 'Bash', 2, true, true),
          card('AscendersBane', 'AscendersBane', -2, false, false, 'CURSE', 'SPECIAL'),
          card('Strike', 'Strike_R', 1, true, true),
          card('Defend', 'Defend_R', 1, true, false, 'SKILL'),
        ],
        monsters: [monster],
        player: {
          max_hp: 80,
          current_hp: 72,
          powers: [{ id: 'Strength', name: 'Strength', amount: 1 }],
          energy: 3,
          block: 0,
          orbs: [],
        },
        turn: 1,
        cards_discarded_this_team_turn_typo_guard: 0,
        cards_discarded_this_turn: 0,
        times_damaged: 0,
      },
    },
  };
}

async function httpJson(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function waitFor(fn, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function main() {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: HERE,
    env: { ...process.env, STS_PORT: String(PORT), STS_STALE_MS: '600000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // 收集子进程 stdout：第一行应该是 ready 握手，后面应该只有我们发出去的命令（不能有日志混进来）
  const stdoutLines = [];
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (l) => stdoutLines.push(l));
  // stderr 是它自己的日志：这里吞掉，但保留在数组里方便失败时打印
  const stderrLines = [];
  readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (l) => stderrLines.push(l));

  const onExit = new Promise((r) => child.once('exit', (code) => r(code)));

  try {
    section('1) 握手与启动');
    const ready = await waitFor(() => (stdoutLines.length > 0 ? stdoutLines[0] : null), 5000);
    check('stdout 第一行是 ready 握手（CommunicationMod 靠它判断子进程就绪）', ready === 'Ready', ready);

    const up = await waitFor(async () => {
      try {
        const r = await httpJson('GET', '/health');
        return r.status === 200;
      } catch {
        return false;
      }
    }, 5000);
    check(`HTTP 在 127.0.0.1:${PORT} 起来了`, Boolean(up));

    section('2) 未连游戏时的诚实响应');
    let r = await httpJson('GET', '/health');
    check('/health 在没收到状态时 ok=false', r.json?.ok === false, r.json);
    check('/health 带上 allowed_actions 白名单', Array.isArray(r.json?.allowed_actions) && r.json.allowed_actions.includes('play'), r.json?.allowed_actions);
    r = await httpJson('GET', '/state');
    check('/state 在没有状态时返回 503 + no_state_yet', r.status === 503 && r.json?.error === 'no_state_yet', r.json);
    r = await httpJson('POST', '/act', { action: 'end' });
    check('/act 在没有状态时返回 503（不盲发命令）', r.status === 503, r.json);

    section('3) 喂一段真实形状的 game_state');
    const msg = makeStateMessage();
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    const ready2 = await waitFor(async () => {
      const h = await httpJson('GET', '/health');
      return h.json?.ok === true ? h.json : null;
    });
    check('收到状态后 /health ok=true', Boolean(ready2), ready2);
    check('/health.screenType 正确', ready2?.screenType === 'NONE', ready2?.screenType);
    check('/health.inGame 正确', ready2?.inGame === true, ready2?.inGame);

    section('4) /state 瘦身结果');
    r = await httpJson('GET', '/state');
    const st = r.json?.state ?? {};
    check('hand 有 6 张牌', st.hand?.length === 6, st.hand?.length);
    check('hand[0] 是 Strike 且 can_play=true', st.hand?.[0]?.name === 'Strike' && st.hand?.[0]?.can_play === true, st.hand?.[0]);
    check('hand[0] 不带 uuid（噪声已剥离）', st.hand?.[0]?.uuid === undefined, st.hand?.[0]);
    check('第 4 张诅咒 can_play=false（is_playable=false 映射正确）', st.hand?.[3]?.can_play === false, st.hand?.[3]);
    check('monsters[0].hp/max_hp 映射正确', st.monsters?.[0]?.hp === 44 && st.monsters?.[0]?.max_hp === 46, st.monsters?.[0]);
    check('monsters[0].damage 回退到基础伤害 12（adjusted=-1 时）', st.monsters?.[0]?.damage === 12, st.monsters?.[0]?.damage);
    check('monsters[0].intent 保留', st.monsters?.[0]?.intent === 'ATTACK', st.monsters?.[0]?.intent);
    check('player.energy 保留', st.player?.energy === 3, st.player?.energy);
    check('piles 只给数量', st.piles?.draw === 2 && st.piles?.discard === 0, st.piles);
    check('relics 只剩 name/counter', st.relics?.[0]?.name === 'Burning Blood' && st.relics?.[0]?.id === undefined, st.relics?.[0]);
    check('potions 带槽位号与可用性', st.potions?.[0]?.slot === 0 && st.potions?.[0]?.can_use === true, st.potions?.[0]);
    check('choices 来自 choice_list', Array.isArray(st.choices) && st.choices[0] === 'Strike', st.choices);
    check('deck 被丢掉（省 token）', st.deck === undefined, Object.keys(st).join(','));
    check('seed 被丢掉', st.seed === undefined, st.seed);
    check('screen_state 被丢掉', st.screen_state === undefined, st.screen_state);

    section('5) /state?raw=1 保留原始字段');
    r = await httpJson('GET', '/state?raw=1');
    check('raw 里有 deck/seed（调试用逃生口）', r.json?.state?.deck?.length === 2 && r.json?.state?.seed === -3047511808784702860, r.json?.state?.seed);

    section('6) /act 合法指令 → 正确文本命令');
    const cases = [
      [{ action: 'play', card_index: 1, target_index: 0 }, 'PLAY 1 0'],
      [{ action: 'play', hand_index: 2 }, 'PLAY 3'],
      [{ action: 'end' }, 'END'],
      [{ action: 'choose', choice_index: 1 }, 'CHOOSE 1'],
      [{ action: 'choose', choice: 'Strike' }, 'CHOOSE Strike'],
      [{ action: 'potion', mode: 'use', slot: 0, target_index: 1 }, 'POTION Use 0 1'],
      [{ action: 'potion', mode: 'discard', slot: 1 }, 'POTION Discard 1'],
      [{ action: 'proceed' }, 'PROCEED'],
      [{ action: 'return' }, 'RETURN'],
      [{ action: 'key', key: 'end_turn' }, 'KEY end_turn'],
      [{ action: 'click', button: 'left', x: 960, y: 540 }, 'CLICK Left 960 540'],
      [{ action: 'wait', timeout: 50 }, 'WAIT 50'],
      [{ action: 'state' }, 'STATE'],
      [{ action: 'start', class: 'watcher', ascension_level: 20, seed: 'abc123' }, 'START watcher 20 ABC123'],
    ];
    for (const [body, expected] of cases) {
      const resp = await httpJson('POST', '/act', body);
      check(`${JSON.stringify(body)} → ${expected}`, resp.status === 200 && resp.json?.sent?.line === expected, resp.json);
    }

    section('7) /act 非法输入必须 400');
    const bad = [
      { action: 'rm -rf' },
      { action: 'shutdown' },
      { action: 'PLAY; DROP TABLE' },
      { action: '' },
      {},
      { action: 'play' },
      { action: 'play', card_index: 'abc' },
      { action: 'play', card_index: 0 },
      { action: 'play', card_index: 11 },
      { action: 'play', card_index: 1, target_index: 99 },
      { action: 'potion', mode: 'drink', slot: 0 },
      { action: 'key', key: 'q' },
      { action: 'click', x: 960 },
      { action: 'start', class: 'bard' },
      { action: 'start', class: 'ironclad', seed: 'ABC' }, // 有 seed 没进阶：协议里会错位，直接拒
    ];
    for (const body of bad) {
      const resp = await httpJson('POST', '/act', body);
      check(`${JSON.stringify(body)} 被 400 拒绝`, resp.status === 400 && resp.json?.ok === false, resp.json);
    }
    r = await fetch(`${BASE}/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    check('坏 JSON body 被 400 拒绝', r.status === 400, r.status);

    section('8) 坏行 / 非 JSON 行不能崩');
    child.stdin.write('这一行不是 JSON\n');
    child.stdin.write('{"hello":"world"}\n');
    child.stdin.write('\n');
    const counted = await waitFor(async () => {
      const h = await httpJson('GET', '/health');
      // 两行是连着写的，bridge 处理有先后：必须等两个计数都到位再断言，否则读到的是中间快照
      const c = h.json?.counters;
      return c && c.badJson >= 1 && c.ignoredJson >= 1 ? h.json : null;
    }, 2000);
    check('非 JSON 行被计数而不是崩溃', counted?.counters?.badJson === 1, counted?.counters);
    check('未知 JSON 被单独计数', counted?.counters?.ignoredJson === 1, counted?.counters?.ignoredJson);
    r = await httpJson('GET', '/state');
    check('坏行没有破坏已有状态', r.status === 200 && r.json?.state?.hand?.length === 6, r.status);
    check('子进程还活着', child.exitCode === null);

    section('9) stdout 只出现 ready + 我们发的命令');
    // 13 条合法 act + 1 条 STATE 之类都在里面；关键是不能混进任何日志文本
    const nonCommand = stdoutLines.slice(1).filter((l) => !/^(PLAY|END|CHOOSE|POTION|PROCEED|RETURN|KEY|CLICK|WAIT|STATE|START)\b/.test(l));
    check('stdout 除 ready 外只有命令行', nonCommand.length === 0, nonCommand);

    section('10) /reset 清空状态');
    r = await httpJson('POST', '/reset');
    check('/reset 返回 ok', r.status === 200 && r.json?.ok === true, r.json);
    r = await httpJson('GET', '/state');
    check('reset 后 /state 回到 503', r.status === 503, r.status);
    r = await httpJson('GET', '/health');
    check('reset 后 /health ok=false', r.json?.ok === false, r.json?.ok);
    r = await httpJson('GET', '/nope');
    check('未知路由 404', r.status === 404, r.status);
  } finally {
    child.stdin.end();
    child.kill();
    await Promise.race([onExit, new Promise((r) => setTimeout(r, 3000))]);
    if (failures > 0 && stderrLines.length > 0) {
      console.log('\n-- 子进程 stderr（便于排查）--');
      console.log(stderrLines.slice(-30).join('\n'));
    }
  }

  console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项断言通过`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('selftest 自身异常：', e);
  process.exit(1);
});
