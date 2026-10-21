#!/usr/bin/env node
/**
 * T-023：真机冒烟（真 adb、真平板、真 state 目录）。
 *
 * 为什么单开一个脚本：单测全用假 adb，能证明「解析 / 预算 / 闸门」是对的，但证明不了
 * 「这台平板上的 adb 命令真能用」—— `wm size` 的输出格式、`dumpsys window` 里有没有
 * `mCurrentFocus`、`screencap -p` 出来的到底是不是 PNG，只有真机才知道。
 *
 * 顺序按「从看到动」排，**前一步失败就停**（后面都建立在它成立的前提上）：
 *   device_status → device_list_apps → device_screenshot → device_tap → device_swipe
 *   → device_key(back) → device_open_app（白名单第一个应用；没配就跳过）
 *
 * 跑法：
 *   node scripts/smoke-device.mjs                      （npm run smoke:device）
 *   node scripts/smoke-device.mjs --state-dir state/device-smoke   （独立账本，不占正式额度）
 *
 * 代价：tap / swipe / key / open_app 每一步都会**真的动一下平板**，并按正式账本记 3–4 步
 * （截图与列应用不记步）。平板没连上时第一步就退出，不会空转、不会瞎点。
 * 真机目前还没就绪（`adb devices` 为空）时，这里会给出中文原因并以非 0 退出 —— 这是预期行为。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandEnvPath, normalizeDeviceConfig } from '../src/device-core.js';
import { DEFAULT_STATE_DIR, createDeviceTools, defaultReadConfig } from '../src/device-tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

/** 取 `--name value` 的值（没给 / 后面没跟值 → 空串）。 */
function argValue(name) {
  const at = argv.indexOf(`--${name}`);
  if (at < 0) return '';
  return at + 1 < argv.length ? argv[at + 1] : '';
}

const stateDirArg = argValue('state-dir');
const stateDir = stateDirArg === '' ? DEFAULT_STATE_DIR : path.resolve(ROOT, stateDirArg);

const failures = [];
const say = (message = '') => console.log(message);

function pass(name, detail = '') {
  say(`✅ ${name}${detail === '' ? '' : `：${detail}`}`);
}

function fail(name, result) {
  const reason = result?.reason ?? 'unknown';
  const message = result?.message ?? '（没有给出原因）';
  failures.push(`${name} → ${reason}：${message}`);
  say(`❌ ${name} → ${reason}`);
  say(`   ${message}`);
}

function summary() {
  say('');
  if (failures.length === 0) {
    say('🎉 冒烟通过：状态 / 列应用 / 截图 / 点击 / 滑动 / 按键 全部成功。');
    return;
  }
  say(`冒烟失败 ${failures.length} 项：`);
  for (const item of failures) say(`  - ${item}`);
  say('');
  say('排查顺序：① `adb devices` 里有且只有一台 device ② 平板上点了「允许 USB 调试」'
    + ' ③ config.json 的 device.adbPath 指向真的 adb。');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 读的是 config.json 的 device 段（与 MCP 侧同一个 readConfig），再按出厂规则归一。
  const cfg = normalizeDeviceConfig((defaultReadConfig() ?? {}).device);

  say('平板真机冒烟（T-023）');
  // 默认 adbPath 是 `%LOCALAPPDATA%\...` 占位，existsSync / spawn 都不认它，先展开。
  const adbPath = expandEnvPath(cfg.adbPath);
  say(`adb：${adbPath}`);
  say(`状态目录：${stateDir}`);
  say('');

  // adb 不存在时先说清楚「该改哪里」——不然 status 只会回一句「adb 出错了」，
  // 而真正的原因是配置里那条路径在这台机器上不存在。
  if (!fs.existsSync(adbPath)) {
    say(`❌ 找不到 adb：${adbPath}`);
    say('   把 config.json 的 device.adbPath 改成**你自己** platform-tools 里 adb(.exe) 的绝对路径；');
    say('   默认值是 `%LOCALAPPDATA%\\Android\\platform-tools\\adb.exe`（可用 %NAME% 占位）。');
    process.exitCode = 1;
    return;
  }

  const tools = createDeviceTools({ stateDir });
  // 两步之间至少等 minGapMs（默认 1 秒）+ 200ms 余量：闸门按毫秒卡，抖动会把第二步判成 cooldown。
  const gapMs = Math.max(200, cfg.minGapMs) + 200;

  // 1. device_status（不记步）：没设备 / 未授权 / 离线都在这一步暴露。
  const status = await tools.deviceStatus();
  if (!status || status.ok !== true) {
    fail('device_status', status);
    // `unknown` 最容易被误读成「平板坏了」，而这里其实有两大类原因，都要点名：
    // 要么 adb 进程根本起不来（沙箱/杀软拦子进程，报 spawn EPERM），要么是别的罕见报错。
    if (status?.reason === 'unknown') {
      say('   提示：在 DSH 沙箱 / 受限终端里，Node 起子进程会被拒（`spawn EPERM`），');
      say('   这种环境请换一个普通 PowerShell 窗口再跑本脚本；也先手动执行一次 `adb devices` 看原始输出。');
    }
    summary();
    process.exitCode = 1;
    return;
  }
  pass('device_status', `${status.model || status.serial} · 电量 ${status.battery?.level ?? '?'}%`
    + ` · 屏幕 ${status.screen?.width}x${status.screen?.height}`
    + ` · 剩余 ${status.leftMinutes} 分钟 / ${status.leftSteps} 步`
    + ` · 前台 ${status.foreground ?? '(解析不出)'}`);

  // 额度 / 暂停：不是代码问题，继续跑只会得到一串假的失败，所以直接停。
  if (status.canPlay !== true) {
    say(`❌ 现在不能动手：${status.budgetMessage}`);
    say('   想验证 adb 链路而不占正式额度：加 `--state-dir state/device-smoke` 换一份独立账本再跑。');
    summary();
    process.exitCode = 1;
    return;
  }

  // 2. device_list_apps（不记步）：证明 `pm list packages` 这条路通，顺便看黑名单命中几个。
  const listed = await tools.deviceListApps({});
  if (!listed || listed.ok !== true) {
    fail('device_list_apps', listed);
    summary();
    process.exitCode = 1;
    return;
  }
  pass('device_list_apps', `${listed.total} 个第三方应用（本次列出 ${listed.shown} 个）`
    + ` · 黑名单命中 ${listed.apps.filter((app) => app.blocked).length} 个`);

  // 3. device_screenshot（不记步）：截图的宽高就是后面给坐标的尺寸，所以必须成功。
  const shot = await tools.deviceScreenshot();
  if (!shot || shot.ok !== true) {
    fail('device_screenshot', shot);
    summary();
    process.exitCode = 1;
    return;
  }
  pass('device_screenshot', `${shot.width}x${shot.height} · ${shot.bytes} 字节 → ${path.relative(ROOT, shot.path)}`);

  const width = shot.width || status.screen?.width || 1280;
  const height = shot.height || status.screen?.height || 800;
  const centerX = Math.floor(width / 2);

  // 4. device_tap（记 1 步）：点屏幕正中，验坐标这条路。
  await sleep(gapMs);
  const tap = await tools.deviceTap({ x: centerX, y: Math.floor(height / 2) });
  if (tap.ok === true) pass('device_tap', `${tap.x},${tap.y}${tap.clamped ? '（越界已夹取）' : ''}`);
  else fail('device_tap', tap);

  // 5. device_swipe（记 1 步）：从下往上滑一屏（durationMs 用闸门允许的 300）。
  await sleep(gapMs);
  const swipe = await tools.deviceSwipe({
    x1: centerX,
    y1: Math.floor(height * 0.75),
    x2: centerX,
    y2: Math.floor(height * 0.35),
    durationMs: 300,
  });
  if (swipe.ok === true) pass('device_swipe', `(${swipe.x1},${swipe.y1}) → (${swipe.x2},${swipe.y2}) · ${swipe.durationMs}ms`);
  else fail('device_swipe', swipe);

  // 6. device_key(back)（记 1 步）：退回到上一屏（也顺手验 keyevent）。
  await sleep(gapMs);
  const back = await tools.deviceKey({ key: 'back' });
  if (back.ok === true) pass('device_key', `${back.key} → ${back.keycode}`);
  else fail('device_key', back);

  // 7. device_open_app（记 1 步）：白名单第一个应用；白名单为空时没有「默认该开的应用」，跳过。
  const target = cfg.apps.find((pkg) => !cfg.blockedApps.includes(pkg)) ?? '';
  if (target === '') {
    say('⏭  device_open_app：config.json 的 device.apps 是空的（= 不限制包名），没有默认应用可开，跳过');
  } else {
    await sleep(gapMs);
    const opened = await tools.deviceOpenApp({ package: target });
    if (opened.ok === true) pass('device_open_app', target);
    else fail('device_open_app', opened);
  }

  summary();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  // 冒烟脚本自己崩了也要给一句人话（例如 state 目录没权限）。
  say(`❌ 冒烟脚本自己出错：${String(error?.stack ?? error)}`);
  process.exitCode = 1;
}
