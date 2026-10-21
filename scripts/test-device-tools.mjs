// src/device-tools.js 的单测：全部用假 `runAdb`（返回预置 stdout / buffer），
// 临时 state 目录，绝不连真设备、不调真 adb。
//
// 覆盖（对应任务要求的「≥70 条断言」）：
// status（设备/电量/额度/前台包名/未连接/未授权） / screenshot（路径、PNG 尺寸、文件落盘、图片形状） /
// tap（夹取、越界、参数校验、预算拦截、冷却、**截图宽高优先 / 未截图回退 wm size**） /
// swipe（时长钳制、参数校验、截图宽高） /
// type（ASCII 编码、中文拒绝、敏感词、超长） / key（back/home 映射） /
// open_app（白名单、黑名单、包名校验、monkey 报错） / **黑名单前台闸门（五个动作）** /
// **list_apps（解析/过滤/截断/黑名单标记）** / **窗口闸门（PC 模式浮窗，T-026）** /
// 记账与不记账 / adb 报错映射 / 工具注册。
//
// 跑法：node scripts/test-device-tools.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGrant } from '../src/device-grant.js';
import { serializeDeviceState } from '../src/device-core.js';
import {
  DEVICE_ACTION_LOG,
  DEVICE_GRANT_FILE,
  DEVICE_SHOT_DIR,
  DEVICE_STATE_FILE,
  DEVICE_TOOL_NAMES,
  DEVICE_WINDOW_FILE,
  createDeviceTools,
  encodeAdbText,
  parseBattery,
  parsePackageList,
  parseWmSize,
  registerDeviceTools,
} from '../src/device-tools.js';

// ── 脚手架 ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    return;
  }
  failed += 1;
  const detail = extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  console.error(`❌ ${name}${detail}`);
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'device-tools-test-'));
const MIN = 60 * 1000;
// 固定假时钟：本地时间 2026-03-15 14:30，日界与预算都按它算。
const T0 = new Date(2026, 2, 15, 14, 30, 0, 0).getTime();

/** 造一个最小但合法的 PNG（只到 IHDR 就够读宽高）。 */
function makePng(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt8(8, 24);
  buffer.writeUInt8(6, 25);
  return buffer;
}

function okReply(stdout = '') {
  return { ok: true, code: 0, stdout, stderr: '', stdoutBuffer: Buffer.from(stdout, 'utf8') };
}

function failReply(stderr) {
  return { ok: false, code: 1, stdout: '', stderr, stdoutBuffer: Buffer.alloc(0) };
}

/** 默认的「一切正常」路由：设备在、屏幕 1280x800、电量 87、前台在桌面、能截图。 */
function baseRoutes(png = makePng(1280, 800)) {
  return {
    devices: okReply('List of devices attached\nFAKE123\tdevice model:Pad_Pro\n'),
    'wm size': okReply('Physical size: 1280x800\n'),
    'dumpsys battery': okReply('Current Battery Service state:\n  AC powered: false\n  level: 87\n  status: 3\n'),
    // 默认停在桌面：黑名单闸门放行，各动作测试才跑得下去。
    'dumpsys window': okReply('mCurrentFocus=Window{1a2b3c u0 com.android.launcher3/com.android.launcher3.Launcher}\n'),
    'pm list packages': okReply('package:com.example.game\npackage:com.example.bili\npackage:com.tencent.mm\n'),
    'input tap': okReply(),
    'input swipe': okReply(),
    'input text': okReply(),
    'input keyevent': okReply(),
    monkey: okReply('Events injected: 1\n'),
    screencap: { ok: true, code: 0, stdout: '', stderr: '', stdoutBuffer: png },
  };
}

/**
 * 假 adb：按「命令串包含关键字」路由，记录每次调用。
 * 没命中任何路由 → 返回 ok:true 的空结果（纯噪声调用不该让测试炸）。
 */
function makeRunAdb(routes) {
  const calls = [];
  const runAdb = async (args, options = {}) => {
    const argv = Array.isArray(args) ? args : [];
    const line = argv.join(' ');
    calls.push({ argv, line, options });
    for (const [key, reply] of Object.entries(routes)) {
      if (line.includes(key)) return typeof reply === 'function' ? reply(argv, options) : reply;
    }
    return okReply();
  };
  runAdb.calls = calls;
  runAdb.count = (key) => calls.filter((call) => call.line.includes(key)).length;
  runAdb.last = (key) => [...calls].reverse().find((call) => call.line.includes(key));
  return runAdb;
}

/**
 * 造一套工具：独立临时 state 目录 + 假 adb + 可拨的时钟。
 * `seed` 会先写进 device-state.json（模拟「昨天/今天已经玩过」）。
 *
 * 授权（T-024）默认**是有效的**（`grant` 缺省 `makeGrant()`）：否则每个用例都会先撞
 * `not_granted`，把「预算 / 黑名单 / 收尾」这些本来要验的东西全挡住。
 * 要验没授权就用 `grant: null`，要验过期/撤销就传一份改过的授权对象。
 * `grantFile` 可以换一个路径（验「测试可注入临时路径」这条）。
 */
function makeEnv({ device = {}, routes = {}, seed = null, clock = T0, grant = makeGrant(), grantFile = null } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'env-'));
  fs.mkdirSync(dir, { recursive: true });
  if (seed) fs.writeFileSync(path.join(dir, DEVICE_STATE_FILE), serializeDeviceState(seed), 'utf8');
  const grantPath = grantFile === null ? path.join(dir, DEVICE_GRANT_FILE) : grantFile;
  if (grant) {
    fs.mkdirSync(path.dirname(grantPath), { recursive: true });
    fs.writeFileSync(grantPath, JSON.stringify(grant), 'utf8');
  }
  const runAdb = makeRunAdb({ ...baseRoutes(), ...routes });
  let at = clock;
  const tools = createDeviceTools({
    runAdb,
    readConfig: () => ({ device }),
    now: () => at,
    stateDir: dir,
    ...(grantFile === null ? {} : { grantFile }),
  });
  return {
    dir,
    runAdb,
    tools,
    grantPath,
    now: () => at,
    advance: (ms) => {
      at += ms;
      return at;
    },
    readState: () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, DEVICE_STATE_FILE), 'utf8'));
      } catch {
        return null;
      }
    },
    readGrant: () => {
      try {
        return JSON.parse(fs.readFileSync(grantPath, 'utf8'));
      } catch {
        return null;
      }
    },
    writeGrant: (value) => {
      fs.writeFileSync(grantPath, JSON.stringify(value), 'utf8');
    },
    stateExists: () => fs.existsSync(path.join(dir, DEVICE_STATE_FILE)),
    actionLog: () => {
      try {
        return fs.readFileSync(path.join(dir, DEVICE_ACTION_LOG), 'utf8');
      } catch {
        return '';
      }
    },
  };
}

/** 缺省授权：管理员 1691642607 在 T0 说了一句「去玩平板 30 分钟」。 */
function makeGrant(overrides = {}) {
  return { ...createGrant(T0, { grantedBy: 1691642607, viaKey: 'private:1691642607', minutes: 30 }), ...overrides };
}

/** 今天还没玩的状态。 */
function todayState(overrides = {}) {
  return { day: '2026-03-15', usedMs: 0, steps: 0, lastTs: 0, pausedUntil: 0, pausedReason: '', ...overrides };
}

/** 昨天（已玩满）的状态，用来验跨日重置。 */
const YESTERDAY_FULL = { day: '2026-03-14', usedMs: 30 * MIN, steps: 60, lastTs: T0 - 60 * MIN, pausedUntil: 0, pausedReason: '' };

// ── 1. 输出解析小函数 ──────────────────────────────────────────────────────
{
  check('wm size 解析物理尺寸', JSON.stringify(parseWmSize('Physical size: 2560x1600\n')) === '{"width":2560,"height":1600}');
  check(
    'Override size 优先（截图就是这个尺寸）',
    JSON.stringify(parseWmSize('Physical size: 2560x1600\nOverride size: 1280x800\n')) === '{"width":1280,"height":800}',
  );
  check('wm size 看不懂 → null', parseWmSize('garbage') === null);
  check('wm size 非字符串 → null', parseWmSize(null) === null);
  check('wm size 0 宽 → null', parseWmSize('Physical size: 0x0') === null);

  const battery = parseBattery('  level: 87\n  status: 3\n');
  check('电量解析 level', battery.level === 87);
  check('电量解析状态码', battery.status === 3);
  check('状态码翻成人话', battery.state === 'discharging');
  const emptyBattery = parseBattery('nothing here');
  check('电量解析失败给 null', emptyBattery.level === null && emptyBattery.state === 'unknown');
  check('电量非字符串不崩', parseBattery(undefined).level === null);

  // PNG 宽高解析（parsePngSize）是 device-core 的纯函数，用例见 test-device-core.mjs §5.5。

  check('字母数字原样', encodeAdbText('abc123') === 'abc123');
  check('空格转 %s', encodeAdbText('a b') === 'a%sb');
  check('感叹号转义', encodeAdbText('hi!') === 'hi%21');
  check('& 转义（防 shell 语法）', encodeAdbText('a&b') === 'a%26b');
  check('中文按码点转义', encodeAdbText('中') === '%4E2D');
  check('空串编码成空串', encodeAdbText('') === '');

  // pm list packages 输出 -> 包名数组
  check(
    '解析 pm list packages',
    JSON.stringify(parsePackageList('package:com.a.b\npackage:com.c.d\n')) === '["com.a.b","com.c.d"]',
  );
  check(
    '忽略非 package 行与空行',
    JSON.stringify(parsePackageList('Package [com.a.b] (1):\npackage:com.c.d\n\n  noise\n')) === '["com.c.d"]',
  );
  check('包名去重', parsePackageList('package:com.a.b\npackage:com.a.b\n').length === 1);
  check('package: 后面是空的 → 跳过', parsePackageList('package:\npackage:com.a.b\n').length === 1);
  check('非字符串 → 空数组', parsePackageList(null).length === 0 && parsePackageList(undefined).length === 0);
  check('CRLF 也行', parsePackageList('package:com.a.b\r\npackage:com.c.d\r\n').length === 2);
  check('带空格的 package 行也能认', parsePackageList('  package:com.a.b  \n')[0] === 'com.a.b');
}

// ── 2. device_status ───────────────────────────────────────────────────────
{
  const env = makeEnv({ device: {} });
  const status = await env.tools.deviceStatus();
  check('status 成功', status.ok === true, status);
  check('status 给出序列号', status.serial === 'FAKE123');
  check('status 给出型号（下划线还原）', status.model === 'Pad Pro', status.model);
  check('status 报告已连接', status.connected === true);
  check('status 解析电量', status.battery.level === 87 && status.battery.state === 'discharging');
  check('status 保留原始状态码', status.battery.status === 3);
  check('status 解析屏幕尺寸', status.screen.width === 1280 && status.screen.height === 800);
  check('status 初始额度 30 分钟 / 60 步', status.leftMinutes === 30 && status.leftSteps === 60);
  check('status 现在可以玩', status.canPlay === true && status.budgetReason === 'ok');
  check('status 不消耗步数', env.stateExists() === false);
  check('status 白名单为空', Array.isArray(status.apps) && status.apps.length === 0);
  check('status 未暂停时 pausedUntil 为 0', status.pausedUntil === 0);
  check('status 报前台包名', status.foreground === 'com.android.launcher3', status.foreground);
  check('status 回带黑名单', Array.isArray(status.blockedApps) && status.blockedApps.length === 5);
  check('status 回带黑名单里的微信', status.blockedApps.includes('com.tencent.mm'));

  const blockedFg = await makeEnv({
    routes: { 'dumpsys window': okReply('mCurrentFocus=Window{9 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}\n') },
  }).tools.deviceStatus();
  check('停在被禁应用时 status 照实说前台', blockedFg.foreground === 'com.tencent.mm', blockedFg.foreground);
  check('停在被禁应用仍可看 status（只是不许动）', blockedFg.ok === true && blockedFg.canPlay === true);

  const noFocus = await makeEnv({ routes: { 'dumpsys window': failReply('error: device offline') } }).tools.deviceStatus();
  check('前台读不到 → foreground null（不编名字）', noFocus.ok === true && noFocus.foreground === null);

  const disabled = await makeEnv({ device: { enabled: false } }).tools.deviceStatus();
  check('功能关闭 → status ok:false', disabled.ok === false && disabled.reason === 'disabled');
  check('功能关闭 → connected:false', disabled.connected === false);
  check('功能关闭给出中文原因', String(disabled.message).includes('关着'));

  const noDevice = await makeEnv({ routes: { devices: okReply('List of devices attached\n') } }).tools.deviceStatus();
  check('没插设备 → ok:false', noDevice.ok === false && noDevice.reason === 'no_device');
  check('没插设备说实话', String(noDevice.message).includes('没找到平板'));

  const broken = await makeEnv({ routes: { devices: failReply('error: no devices/emulators found') } }).tools.deviceStatus();
  check('adb devices 报错 → no_device', broken.ok === false && broken.reason === 'no_device');

  const unauthorized = await makeEnv({ routes: { devices: okReply('List of devices attached\nFAKE123\tunauthorized\n') } }).tools.deviceStatus();
  check('未授权 → unauthorized', unauthorized.ok === false && unauthorized.reason === 'unauthorized');
  check('未授权提示去点允许', String(unauthorized.message).includes('允许'));

  const offlineTap = await makeEnv({ routes: { devices: okReply('List of devices attached\nFAKE123\toffline\n') } }).tools.deviceTap({ x: 1, y: 2 });
  check('离线设备 → offline', offlineTap.ok === false && offlineTap.reason === 'offline');

  const multi = await makeEnv({
    routes: { devices: okReply('List of devices attached\nA\tdevice\nB\tdevice\n') },
  }).tools.deviceStatus();
  check('多设备 → multiple_devices', multi.ok === false && multi.reason === 'multiple_devices');
  check('多设备说明只插一台', String(multi.message).includes('只插一台'));

  const exhausted = await makeEnv({ seed: todayState({ usedMs: 30 * MIN, steps: 5 }) }).tools.deviceStatus();
  check('额度用完 status 仍可用', exhausted.ok === true);
  check('额度用完 → canPlay:false', exhausted.canPlay === false && exhausted.budgetReason === 'daily_budget');
  check('额度用完给出明天再来的话', String(exhausted.budgetMessage).includes('明天'));
  check('额度用完剩余 0 分钟', exhausted.leftMinutes === 0);

  const paused = await makeEnv({ seed: todayState({ pausedUntil: T0 + 10 * MIN, pausedReason: 'conversation' }) }).tools.deviceStatus();
  check('暂停中 status 说暂停', paused.canPlay === false && paused.budgetReason === 'paused');
  check('暂停中回带原因与解除时间', paused.pausedReason === 'conversation' && paused.pausedUntil === T0 + 10 * MIN);

  const noBattery = await makeEnv({ routes: { 'dumpsys battery': failReply('error: device offline') } }).tools.deviceStatus();
  check('电量读不到也给空', noBattery.ok === true && noBattery.battery.level === null);

  const noScreen = await makeEnv({ routes: { 'wm size': failReply('error: oops') } }).tools.deviceStatus();
  check('屏幕尺寸读不到也给 null', noScreen.ok === true && noScreen.screen.width === null);

  const reset = await makeEnv({ seed: YESTERDAY_FULL }).tools.deviceStatus();
  check('跨日重置额度', reset.leftMinutes === 30 && reset.leftSteps === 60 && reset.usedSteps === 0);

  // 截图宽高才是输入坐标空间（横屏时 `wm size` 报的是竖屏物理尺寸）：status 也跟着截图走。
  const shotFirst = makeEnv({
    routes: { screencap: { ok: true, code: 0, stderr: '', stdout: '', stdoutBuffer: makePng(2944, 1840) } },
  });
  await shotFirst.tools.deviceScreenshot();
  const afterShot = await shotFirst.tools.deviceStatus();
  check('截过图后 status 的 screen 跟截图走', afterShot.screen.width === 2944 && afterShot.screen.height === 1840, afterShot.screen);
}

// ── 3. device_screenshot ──────────────────────────────────────────────────
{
  const png = makePng(1280, 800);
  const env = makeEnv({ routes: { screencap: { ok: true, code: 0, stderr: '', stdout: '', stdoutBuffer: png } } });
  const shot = await env.tools.deviceScreenshot();
  check('截图成功', shot.ok === true, shot);
  check('截图返回尺寸', shot.width === 1280 && shot.height === 800);
  check('截图 mimeType 是 png', shot.mimeType === 'image/png');
  check('截图路径落在 state/device 下', shot.path.includes(DEVICE_SHOT_DIR) && shot.path.endsWith('.png'), shot.path);
  check('截图文件真的写盘了', fs.existsSync(shot.path) && fs.readFileSync(shot.path).length === png.length);
  check('截图字节数对得上', shot.bytes === png.length);
  check('截图不计步（不写状态）', env.stateExists() === false);
  check('截图写进了动作日志', env.actionLog().includes('screenshot'));
  check('截图用的是 exec-out screencap -p', env.runAdb.last('screencap')?.line.includes('exec-out screencap -p') === true);
  check('截图调用带 -s 序列号', env.runAdb.last('screencap')?.line.startsWith('-s FAKE123') === true);

  const bad = await makeEnv({ routes: { screencap: { ok: true, code: 0, stderr: '', stdout: 'x', stdoutBuffer: Buffer.from('garbage data here') } } }).tools.deviceScreenshot();
  check('不是 PNG → bad_image', bad.ok === false && bad.reason === 'bad_image');

  const failed = await makeEnv({ routes: { screencap: failReply('error: device offline') } }).tools.deviceScreenshot();
  check('截图失败 → offline', failed.ok === false && failed.reason === 'offline' && String(failed.message).includes('截图失败'));

  const disabled = await makeEnv({ device: { enabled: false } }).tools.deviceScreenshot();
  check('功能关闭时不许截图', disabled.ok === false && disabled.reason === 'disabled');

  const paused = await makeEnv({ seed: todayState({ pausedUntil: T0 + MIN }) }).tools.deviceScreenshot();
  check('暂停时不许截图', paused.ok === false && paused.reason === 'paused');

  const exhausted = await makeEnv({ seed: todayState({ usedMs: 30 * MIN }) });
  const stillShot = await exhausted.tools.deviceScreenshot();
  check('额度用完仍能截图（要看自己在哪一屏）', stillShot.ok === true);
}

// ── 4. device_tap ─────────────────────────────────────────────────────────
{
  const env = makeEnv({ seed: todayState() });
  const tap = await env.tools.deviceTap({ x: 100, y: 200 });
  check('point 成功', tap.ok === true, tap);
  check('坐标原样传下去', tap.x === 100 && tap.y === 200 && tap.clamped === false);
  check('回带剩余额度', tap.leftSteps === 59 && tap.leftMinutes === 30);
  check('adb 收到 tap 100 200', env.runAdb.last('input tap')?.line.includes('input tap 100 200') === true);
  check('成功动作记一步', env.readState()?.steps === 1);
  check('状态文件日键是今天', env.readState()?.day === '2026-03-15');
  check('动作日志记下 tap', env.actionLog().includes('"action":"tap"'));

  // 视觉闭环是「点 → 等 0.8 秒 → 看图」，所以截图必须能穿过 minGapMs 冷却。
  const shotAfterTap = await env.tools.deviceScreenshot();
  check('刚点完立刻截图不被冷却拦', shotAfterTap.ok === true, shotAfterTap);
  check('截图不往账本上加步数', env.readState()?.steps === 1);

  const far = await makeEnv({ seed: todayState() }).tools.deviceTap({ x: 9999, y: 9999 });
  check('越界坐标夹到屏幕内', far.x === 1279 && far.y === 799);
  check('夹取后标 clamped', far.clamped === true);
  check('adb 收到夹过的坐标', far.ok === true);

  const neg = await makeEnv({ seed: todayState() }).tools.deviceTap({ x: -20, y: -5 });
  check('负坐标夹到 0', neg.x === 0 && neg.y === 0 && neg.clamped === true);

  const bad = await makeEnv({ seed: todayState() }).tools.deviceTap({ x: 'abc' });
  check('坐标不是数字 → invalid_params', bad.ok === false && bad.reason === 'invalid_params');
  check('参数错误不记账', env.runAdb.count('input tap') === 1 && (await makeEnv({}).tools.deviceTap({})).ok === false);

  const missing = await makeEnv({ seed: todayState() });
  const noParam = await missing.tools.deviceTap();
  check('没给坐标 → invalid_params 且不碰 adb', noParam.ok === false && missing.runAdb.count('input tap') === 0);

  const blocked = await makeEnv({ seed: todayState({ steps: 60 }) });
  const blockedTap = await blocked.tools.deviceTap({ x: 1, y: 1 });
  check('60 步后用满 → step_budget', blockedTap.ok === false && blockedTap.reason === 'step_budget');
  check('预算拦截不调 adb tap', blocked.runAdb.count('input tap') === 0);
  check('预算拦截不改状态', blocked.readState()?.steps === 60);
  check('预算拦截给中文原因', String(blockedTap.message).includes('60 步'));

  const cooldownEnv = makeEnv({ seed: todayState() });
  const firstTap = await cooldownEnv.tools.deviceTap({ x: 10, y: 10 });
  cooldownEnv.advance(300);
  const secondTap = await cooldownEnv.tools.deviceTap({ x: 20, y: 20 });
  check('两次点击间隔 300ms → cooldown', secondTap.ok === false && secondTap.reason === 'cooldown');
  check('冷却不记第二步', cooldownEnv.readState()?.steps === 1);
  cooldownEnv.advance(800);
  const thirdTap = await cooldownEnv.tools.deviceTap({ x: 20, y: 20 });
  check('等够 1000ms 后放行', thirdTap.ok === true && cooldownEnv.readState()?.steps === 2);
  check('第一下确实记了账', firstTap.ok === true);

  const disabledEnv = makeEnv({ device: { enabled: false } });
  const disabledTap = await disabledEnv.tools.deviceTap({ x: 1, y: 1 });
  check('功能关闭 → 不许点', disabledTap.ok === false && disabledTap.reason === 'disabled');
  check('功能关闭不调 adb', disabledEnv.runAdb.calls.length === 0);

  const errEnv = makeEnv({ seed: todayState(), routes: { 'input tap': failReply('error: device offline') } });
  const errTap = await errEnv.tools.deviceTap({ x: 1, y: 1 });
  check('adb 报错 → offline', errTap.ok === false && errTap.reason === 'offline');
  check('adb 报错不记账', errEnv.readState()?.steps === 0);
  check('adb 报错给中文原因', String(errTap.message).includes('离线'));

  const noScreenEnv = makeEnv({ seed: todayState(), routes: { 'wm size': failReply('error: nope') } });
  const noScreenTap = await noScreenEnv.tools.deviceTap({ x: 5000, y: 5000 });
  check('读不到屏幕尺寸也不拦截点击', noScreenTap.ok === true);
  check('读不到屏幕尺寸就不夹取', noScreenTap.x === 5000 && noScreenTap.screen.width === null);

  // 真机 TB375FC：竖持时 `wm size` 是 1840x2944，横屏应用的实际输入空间是 2944x1840。
  // 截过图就必须按截图宽高夹取 —— x=2400 是合法的，不能被夹成 1840。
  const wideEnv = makeEnv({
    seed: todayState(),
    routes: { screencap: { ok: true, code: 0, stderr: '', stdout: '', stdoutBuffer: makePng(2944, 1840) } },
  });
  await wideEnv.tools.deviceScreenshot();
  const wideTap = await wideEnv.tools.deviceTap({ x: 2400, y: 900 });
  check('截过图后横屏坐标原样下发（不被夹）', wideTap.x === 2400 && wideTap.y === 900 && wideTap.clamped === false, wideTap);
  check('回执 screen 是截图宽高', wideTap.screen.width === 2944 && wideTap.screen.height === 1840, wideTap.screen);
  check('adb 收到 2400 900', wideEnv.runAdb.last('input tap')?.line.includes('input tap 2400 900') === true);
  wideEnv.advance(1200);
  const wideEdge = await wideEnv.tools.deviceTap({ x: 9999, y: 9999 });
  check('横屏下越界仍夹到截图边界', wideEdge.x === 2943 && wideEdge.y === 1839 && wideEdge.clamped === true);

  // 没截过图 → 回退 `wm size`（1280x800），宽坐标照旧被夹。
  const fallbackEnv = makeEnv({ seed: todayState() });
  const fallbackTap = await fallbackEnv.tools.deviceTap({ x: 2400, y: 900 });
  check('没截过图回退 wm size 并夹取', fallbackTap.x === 1279 && fallbackTap.y === 799 && fallbackTap.clamped === true, fallbackTap);
  check('回退时 screen 是 wm size', fallbackTap.screen.width === 1280 && fallbackTap.screen.height === 800);

  const used = await makeEnv({ seed: todayState({ usedMs: 29 * MIN, lastTs: T0 - 10 * MIN }) }).tools.deviceTap({ x: 5, y: 5 });
  check('剩最后 1 分钟还能点', used.ok === true);
  check('用满 30 分钟后拦下一下', (await makeEnv({ seed: todayState({ usedMs: 30 * MIN, lastTs: T0 - 10 * MIN }) }).tools.deviceTap({ x: 5, y: 5 })).reason === 'daily_budget');
}

// ── 5. device_swipe ───────────────────────────────────────────────────────
{
  const env = makeEnv({ seed: todayState() });
  const swipe = await env.tools.deviceSwipe({ x1: 100, y1: 700, x2: 100, y2: 100 });
  check('swipe 成功', swipe.ok === true, swipe);
  check('swipe 默认 300ms', swipe.durationMs === 300);
  check('adb 收到 swipe 命令', env.runAdb.last('input swipe')?.line.includes('input swipe 100 700 100 100 300') === true);
  check('swipe 记一步', env.readState()?.steps === 1);

  const short = await makeEnv({ seed: todayState() }).tools.deviceSwipe({ x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 10 });
  check('时长下限钳到 100ms', short.durationMs === 100);
  const long = await makeEnv({ seed: todayState() }).tools.deviceSwipe({ x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 99999 });
  check('时长上限钳到 2000ms', long.durationMs === 2000);
  const mid = await makeEnv({ seed: todayState() }).tools.deviceSwipe({ x1: 1, y1: 1, x2: 2, y2: 2, durationMs: 800 });
  check('合法时长原样保留', mid.durationMs === 800);

  const clamped = await makeEnv({ seed: todayState() }).tools.deviceSwipe({ x1: -100, y1: -100, x2: 9999, y2: 9999, durationMs: 300 });
  check('滑动两端都夹到屏幕内', clamped.x1 === 0 && clamped.y1 === 0 && clamped.x2 === 1279 && clamped.y2 === 799);
  check('夹取后标 clamped', clamped.clamped === true);

  // 滑动同样按截图宽高夹：横屏终点 x=2400 不该被夹回去。
  const wideSwipeEnv = makeEnv({
    seed: todayState(),
    routes: { screencap: { ok: true, code: 0, stderr: '', stdout: '', stdoutBuffer: makePng(2944, 1840) } },
  });
  await wideSwipeEnv.tools.deviceScreenshot();
  const wideSwipe = await wideSwipeEnv.tools.deviceSwipe({ x1: 100, y1: 900, x2: 2400, y2: 900 });
  check('截过图后滑动终点不被夹', wideSwipe.x2 === 2400 && wideSwipe.clamped === false, wideSwipe);
  check('滑动回执 screen 是截图宽高', wideSwipe.screen.width === 2944 && wideSwipe.screen.height === 1840);
  check('adb 收到横屏滑动端点', wideSwipeEnv.runAdb.last('input swipe')?.line.includes('input swipe 100 900 2400 900 300') === true);

  const brokenEnv = makeEnv({ seed: todayState() });
  const broken = await brokenEnv.tools.deviceSwipe({ x1: 1, y1: 1, x2: 'x', y2: 2 });
  check('坐标非法 → invalid_params', broken.ok === false && broken.reason === 'invalid_params');
  check('坐标非法不调 adb、不记账', brokenEnv.runAdb.count('input swipe') === 0 && brokenEnv.readState()?.steps === 0);

  const blockedSwipe = await makeEnv({ seed: todayState({ usedMs: 30 * MIN, lastTs: T0 - 10 * MIN }) }).tools.deviceSwipe({
    x1: 1,
    y1: 1,
    x2: 2,
    y2: 2,
  });
  check('swipe 也受日额度约束', blockedSwipe.ok === false && blockedSwipe.reason === 'daily_budget');
}

// ── 6. device_type ────────────────────────────────────────────────────────
{
  const env = makeEnv({ seed: todayState() });
  const typed = await env.tools.deviceType({ text: 'hello world' });
  check('ASCII 文本可以输入', typed.ok === true, typed);
  check('回带字符数', typed.chars === 11);
  check('空格转义成 %s 再交给 adb', env.runAdb.last('input text')?.line.endsWith('hello%sworld') === true);
  check('输入记一步', env.readState()?.steps === 1);

  const special = await makeEnv({ seed: todayState() }).tools.deviceType({ text: 'a&b!' });
  check('特殊字符被转义', special.ok === true);

  const chineseEnv = makeEnv({ seed: todayState() });
  const chinese = await chineseEnv.tools.deviceType({ text: '你好' });
  check('中文被拒绝（ascii_only）', chinese.ok === false && chinese.reason === 'ascii_only');
  check('中文拒绝的文案指向点击', String(chinese.message).includes('中文') && String(chinese.message).includes('点击'));
  check('中文拒绝不碰 adb', chineseEnv.runAdb.count('input text') === 0);
  check('中文拒绝不记账', chineseEnv.readState()?.steps === 0);

  const empty = await makeEnv({ seed: todayState() }).tools.deviceType({ text: '' });
  check('空文本 → invalid_params', empty.ok === false && empty.reason === 'invalid_params');

  const sensitive = await makeEnv({ seed: todayState() }).tools.deviceType({ text: 'password123' });
  check('密码类文本 → risky', sensitive.ok === false && sensitive.reason === 'risky');
  check('敏感文本不打进设备', String(sensitive.message).includes('不打'));

  const longText = await makeEnv({ seed: todayState() }).tools.deviceType({ text: 'a'.repeat(201) });
  check('超长文本 → too_long', longText.ok === false && longText.reason === 'too_long');
  const okText = await makeEnv({ seed: todayState() }).tools.deviceType({ text: 'a'.repeat(200) });
  check('正好 200 字符可以', okText.ok === true);

  const failedType = await makeEnv({ seed: todayState(), routes: { 'input text': failReply('error: device offline') } }).tools.deviceType({ text: 'hi' });
  check('输入失败不记账', failedType.ok === false && failedType.reason === 'offline');
}

// ── 7. device_key ─────────────────────────────────────────────────────────
{
  const backEnv = makeEnv({ seed: todayState() });
  const back = await backEnv.tools.deviceKey({ key: 'back' });
  check('back 成功', back.ok === true && back.key === 'back');
  check('back 映射 KEYCODE_BACK', back.keycode === 'KEYCODE_BACK');
  check('adb 收到 keyevent KEYCODE_BACK', backEnv.runAdb.last('input keyevent')?.line.endsWith('KEYCODE_BACK') === true);
  check('按键记一步', backEnv.readState()?.steps === 1);

  const home = await makeEnv({ seed: todayState() }).tools.deviceKey({ key: 'HOME' });
  check('home 大写也认', home.ok === true && home.key === 'home');
  check('home 映射 KEYCODE_HOME', home.keycode === 'KEYCODE_HOME');

  const invalidEnv = makeEnv({ seed: todayState() });
  const invalid = await invalidEnv.tools.deviceKey({ key: 'power' });
  check('power 不被允许', invalid.ok === false && invalid.reason === 'invalid_params');
  check('非法按键不碰 adb', invalidEnv.runAdb.count('input keyevent') === 0);
  check('没给 key 也是 invalid_params', (await makeEnv({ seed: todayState() }).tools.deviceKey({})).ok === false);
}

// ── 8. device_open_app ────────────────────────────────────────────────────
{
  const openEnv = makeEnv({ seed: todayState() });
  const opened = await openEnv.tools.deviceOpenApp({ package: 'com.example.game' });
  check('空白名单 → 允许开', opened.ok === true, opened);
  check('启动用 monkey 命令', openEnv.runAdb.last('monkey')?.line.includes('monkey -p com.example.game') === true);
  check('monkey 带上 LAUNCHER 类别', openEnv.runAdb.last('monkey')?.line.includes('android.intent.category.LAUNCHER') === true);
  check('开应用记一步', openEnv.readState()?.steps === 1);

  const listed = makeEnv({ seed: todayState(), device: { apps: ['com.example.game'] } });
  check('白名单内可以开', (await listed.tools.deviceOpenApp({ package: 'com.example.game' })).ok === true);
  listed.advance(1500);
  const outside = await listed.tools.deviceOpenApp({ package: 'com.other.chat' });
  check('白名单外拒绝', outside.ok === false && outside.reason === 'not_allowed');
  check('白名单外说清是白名单', String(outside.message).includes('白名单'));
  check('白名单外不调 adb', listed.runAdb.count('monkey') === 1);

  // 黑名单：白名单里写了也不许开（黑名单永远优先）。
  const blockedOpen = makeEnv({ seed: todayState(), device: { apps: ['com.tencent.mm'] } });
  blockedOpen.advance(1500);
  const wechat = await blockedOpen.tools.deviceOpenApp({ package: 'com.tencent.mm' });
  check('黑名单包 → blocked_app', wechat.ok === false && wechat.reason === 'blocked_app', wechat);
  check('黑名单包文案带中文名', String(wechat.message).includes('微信'));
  check('黑名单包文案带包名', String(wechat.message).includes('com.tencent.mm'));
  check('黑名单包不调 adb', blockedOpen.runAdb.count('monkey') === 0);
  check('黑名单包不记账', blockedOpen.readState()?.steps === 0);
  check('黑名单包留痕（blocked_app）', blockedOpen.actionLog().includes('blocked_app'));

  const alipay = await makeEnv({ seed: todayState() }).tools.deviceOpenApp({ package: 'com.eg.android.AlipayGphone' });
  check('支付宝永远不许开', alipay.ok === false && alipay.reason === 'blocked_app' && String(alipay.message).includes('支付宝'));

  // 前台停在被禁应用：连白名单内的包也不许开（先把界面切走）。
  const openOnBlocked = makeEnv({
    seed: todayState(),
    routes: { 'dumpsys window': okReply('mCurrentFocus=Window{7 u0 com.eg.android.AlipayGphone/.Main}\n') },
  });
  const openWhileBlocked = await openOnBlocked.tools.deviceOpenApp({ package: 'com.example.game' });
  check('前台在黑名单时开应用也拒', openWhileBlocked.ok === false && openWhileBlocked.reason === 'blocked_foreground');
  check('前台在黑名单时不调 monkey', openOnBlocked.runAdb.count('monkey') === 0);
  check('前台闸门也不记账', openOnBlocked.readState()?.steps === 0);

  const invalidPkg = await makeEnv({ seed: todayState() }).tools.deviceOpenApp({ package: 'not a package' });
  check('包名不合法 → invalid_package', invalidPkg.ok === false && invalidPkg.reason === 'invalid_package');
  const emptyPkg = await makeEnv({ seed: todayState() }).tools.deviceOpenApp({});
  check('没给包名 → invalid_package', emptyPkg.ok === false && emptyPkg.reason === 'invalid_package');
  const trimmed = await makeEnv({ seed: todayState() }).tools.deviceOpenApp({ package: '  com.example.game  ' });
  check('包名首尾空白被 trim', trimmed.ok === true);

  const missing = await makeEnv({ seed: todayState(), routes: { monkey: okReply('** No activities found to run, monkey aborted.\n') } });
  const missingApp = await missing.tools.deviceOpenApp({ package: 'com.example.gone' });
  check('monkey 找不到入口 → app_not_found', missingApp.ok === false && missingApp.reason === 'app_not_found');
  check('找不到应用不记账', missing.readState()?.steps === 0);

  const monkeyFail = await makeEnv({ seed: todayState(), routes: { monkey: failReply('error: device offline') } });
  check('monkey 报错 → offline', (await monkeyFail.tools.deviceOpenApp({ package: 'com.example.game' })).reason === 'offline');
}

// ── 9. 工具注册与图片形状 ─────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'register-'));
  fs.writeFileSync(path.join(dir, DEVICE_STATE_FILE), serializeDeviceState(todayState()), 'utf8');
  // 注册层不传 grantFile，所以授权文件要落在 stateDir 下的默认位置（否则每个工具都 not_granted）。
  fs.writeFileSync(path.join(dir, DEVICE_GRANT_FILE), JSON.stringify(makeGrant()), 'utf8');
  const runAdb = makeRunAdb({ ...baseRoutes(), screencap: { ok: true, code: 0, stderr: '', stdout: '', stdoutBuffer: makePng(800, 1280) } });
  const registered = [];
  const server = { tool: (name, description, schema, handler) => registered.push({ name, description, schema, handler }) };

  const built = registerDeviceTools(server, {
    runAdb,
    readConfig: () => ({ device: {} }),
    now: () => T0,
    stateDir: dir,
  });

  check('注册了 8 个工具', registered.length === 8, registered.map((item) => item.name));
  check('工具名与约定一致', JSON.stringify(registered.map((item) => item.name)) === JSON.stringify([...DEVICE_TOOL_NAMES]));
  check('注册函数返回工具实现', typeof built.deviceTap === 'function' && typeof built.deviceScreenshot === 'function');
  check('注册函数也返回 list_apps', typeof built.deviceListApps === 'function');
  check('每个工具都有描述', registered.every((item) => typeof item.description === 'string' && item.description.length > 10));
  check('描述里写了边界', registered.every((item) => item.description.includes('只玩不越界')));
  check('输入工具描述里写了中文限制', registered.find((item) => item.name === 'device_type').description.includes('中文'));
  check('tap 工具带坐标参数', Object.keys(registered.find((item) => item.name === 'device_tap').schema).sort().join(',') === 'x,y');
  check('swipe 工具参数齐全', Object.keys(registered.find((item) => item.name === 'device_swipe').schema).sort().join(',') === 'durationMs,x1,x2,y1,y2');
  check('list_apps 只接受可选 filter', Object.keys(registered.find((item) => item.name === 'device_list_apps').schema).join(',') === 'filter');
  const keySchema = registered.find((item) => item.name === 'device_key').schema.key;
  check('key 工具只接受 back/home', keySchema.safeParse('back').success === true && keySchema.safeParse('power').success === false);

  const shotHandler = registered.find((item) => item.name === 'device_screenshot').handler;
  const shotResult = await shotHandler({});
  check('截图 handler 返回两个 content', Array.isArray(shotResult.content) && shotResult.content.length === 2);
  check('第一个 content 是文字说明', shotResult.content[0].type === 'text' && shotResult.content[0].text.includes('平板截图'));
  check('文字说明带尺寸（模型据此给坐标）', shotResult.content[0].text.includes('800x1280'));
  check('第二个 content 是图片', shotResult.content[1].type === 'image');
  check('图片 mimeType 是 image/png', shotResult.content[1].mimeType === 'image/png');
  check('图片 data 是 base64 字符串', typeof shotResult.content[1].data === 'string' && shotResult.content[1].data.length > 0);
  check(
    'base64 能还原成 PNG',
    Buffer.from(shotResult.content[1].data, 'base64').slice(0, 4).toString('hex') === '89504e47',
  );

  // 注意顺序：账本类检查要排在「成功动作」之前 —— 成功动作会写 lastTs，紧接着的下一动
  // 会被 minGapMs 判成 cooldown（这是设计要求，不是 bug）。这里先测失败返回，再测成功。
  const failHandler = registered.find((item) => item.name === 'device_open_app').handler;
  const failResult = await failHandler({ package: 'bad pkg' });
  check('失败结果标 isError', failResult.isError === true);
  check('失败结果是中文原因', JSON.parse(failResult.content[0].text).reason === 'invalid_package');

  const tapHandler = registered.find((item) => item.name === 'device_tap').handler;
  const tapResult = await tapHandler({ x: 10, y: 20 });
  check('tap handler 回 JSON 文本', tapResult.content[0].type === 'text');
  check('tap handler 结果 ok:true', JSON.parse(tapResult.content[0].text).ok === true);
  check('tap handler 结果回带坐标', JSON.parse(tapResult.content[0].text).x === 10);
}

// ── 10. 注册层的兜底：工具函数抛异常也不能把会话弄断 ─────────────────────────
{
  const captured = [];
  const boomDir = fs.mkdtempSync(path.join(TMP_ROOT, 'boom-'));
  // 授权先给上：这个用例验的是「adb 抛异常也要兜住」，不能先被 not_granted 拦住。
  fs.writeFileSync(path.join(boomDir, DEVICE_GRANT_FILE), JSON.stringify(makeGrant()), 'utf8');
  registerDeviceTools(
    { tool: (name, description, schema, handler) => captured.push({ name, handler }) },
    {
      // 注入一个「直接抛」的 adb：真实 adb 进程起不来时会走到这条路径。
      runAdb: () => {
        throw new Error('boom: adb 起不来');
      },
      readConfig: () => ({ device: {} }),
      now: () => T0,
      stateDir: boomDir,
    },
  );
  const boomTap = await captured.find((item) => item.name === 'device_tap').handler({ x: 1, y: 1 });
  check('adb 抛异常 → 结果标 isError', boomTap.isError === true);
  check('adb 抛异常 → reason internal', JSON.parse(boomTap.content[0].text).reason === 'internal');
  check('adb 抛异常 → 文案带原始消息', String(JSON.parse(boomTap.content[0].text).message).includes('boom'));
}

// ── 11. 多步连续：预算与记账 ──────────────────────────────────────────────
{
  const env = makeEnv({ seed: todayState() });
  for (let i = 0; i < 3; i += 1) {
    env.advance(1500);
    await env.tools.deviceTap({ x: 10 + i, y: 10 });
  }
  check('连做 3 步记 3 步', env.readState()?.steps === 3);
  // 第一步没有上一步可比（lastTs=0），只从第二、三步各计 1.5 秒 → 3.0 秒。
  check('连做 3 步累计 2×1.5 秒', env.readState()?.usedMs === 3000);
  check('动作日志有 3 行', env.actionLog().trim().split('\n').length === 3);

  const busy = makeEnv({ seed: todayState({ steps: 59, lastTs: T0 - 5000 }) });
  const last = await busy.tools.deviceTap({ x: 1, y: 1 });
  check('第 60 步放行', last.ok === true && busy.readState()?.steps === 60);
  busy.advance(2000);
  const over = await busy.tools.deviceTap({ x: 2, y: 2 });
  check('第 61 步被拦', over.ok === false && over.reason === 'step_budget');
  check('被拦后步数不变', busy.readState()?.steps === 60);

  const paused = makeEnv({ seed: todayState({ pausedUntil: T0 + 5 * MIN }) });
  const pausedTap = await paused.tools.deviceTap({ x: 1, y: 1 });
  check('暂停中不许动', pausedTap.ok === false && pausedTap.reason === 'paused');
  check('暂停中给解除时间', String(pausedTap.message).includes('暂停'));
}

// ── 12. 黑名单前台闸门（T-023 收尾） ────────────────────────────────────────
{
  const WECHAT = 'mCurrentFocus=Window{9f1 u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}\n';
  const LAUNCHER = 'mCurrentFocus=Window{1a2 u0 com.android.launcher3/com.android.launcher3.Launcher}\n';
  let focus = WECHAT;
  const env = makeEnv({ seed: todayState(), routes: { 'dumpsys window': () => okReply(focus) } });

  const tap = await env.tools.deviceTap({ x: 10, y: 10 });
  check('前台是微信 → tap 被拒', tap.ok === false && tap.reason === 'blocked_foreground', tap);
  check('拒绝文案点名微信', String(tap.message).includes('微信'));
  check('拒绝结果回带前台包名', tap.foreground === 'com.tencent.mm');
  check('被拒时不调 input tap', env.runAdb.count('input tap') === 0);

  const swipe = await env.tools.deviceSwipe({ x1: 10, y1: 100, x2: 10, y2: 200, durationMs: 300 });
  check('前台是微信 → swipe 被拒', swipe.ok === false && swipe.reason === 'blocked_foreground');
  check('被拒时不调 input swipe', env.runAdb.count('input swipe') === 0);

  const typed = await env.tools.deviceType({ text: 'abc' });
  check('前台是微信 → type 被拒', typed.ok === false && typed.reason === 'blocked_foreground');
  check('被拒时不调 input text', env.runAdb.count('input text') === 0);

  env.advance(1500);
  const key = await env.tools.deviceKey({ key: 'back' });
  check('前台是微信 → key 被拒（连返回键也不代按）', key.ok === false && key.reason === 'blocked_foreground');
  check('被拒时不调 input keyevent', env.runAdb.count('input keyevent') === 0);

  check('被拒的四个动作都没记步', (env.readState()?.steps ?? 0) === 0);
  check('被拒也留痕', env.actionLog().includes('blocked_foreground'));
  check('留痕里带前台包名', env.actionLog().includes('com.tencent.mm'));

  const shotOnBlocked = await env.tools.deviceScreenshot();
  check('停在被禁应用时仍可截图（看不见就更退不出去）', shotOnBlocked.ok === true && shotOnBlocked.width === 1280, shotOnBlocked);

  const listedOnBlocked = await env.tools.deviceListApps();
  check('停在被禁应用时仍可列应用', listedOnBlocked.ok === true);

  // 被拒的动作不算「上一步」：把界面切走后立刻能点，不用等 minGapMs。
  focus = LAUNCHER;
  const tapAfter = await env.tools.deviceTap({ x: 10, y: 10 });
  check('被拒不算上一步（不触发 cooldown）', tapAfter.ok === true, tapAfter);
  check('放行后正常记一步', env.readState()?.steps === 1);

  // 前台解析不出来 = 不知道，放行（理由见 device-tools 里 foregroundBlock 的注释）。
  const nullFocus = makeEnv({ seed: todayState(), routes: { 'dumpsys window': okReply('mCurrentFocus=null\n') } });
  check('前台 null（锁屏/无焦点）→ 放行', (await nullFocus.tools.deviceTap({ x: 1, y: 1 })).ok === true);

  const brokenFocus = makeEnv({ seed: todayState(), routes: { 'dumpsys window': failReply('error: closed') } });
  check('dumpsys window 报错 → 放行（不因为读不到就瘫）', (await brokenFocus.tools.deviceTap({ x: 1, y: 1 })).ok === true);

  // 用户自己追加的黑名单也生效。
  const customBlocked = makeEnv({
    seed: todayState(),
    device: { blockedApps: ['com.example.game'] },
    routes: { 'dumpsys window': okReply('mCurrentFocus=Window{3 u0 com.example.game/.Main}\n') },
  });
  const customTap = await customBlocked.tools.deviceTap({ x: 2, y: 2 });
  check('追加黑名单也拦（带包名）', customTap.ok === false && String(customTap.message).includes('com.example.game'));

  // 逃生口（2026-10-21 指挥官决策）：前台停在黑名单上时 home 放行 —— 只回桌面，不碰应用里任何东西。
  const escape = makeEnv({ seed: todayState(), routes: { 'dumpsys window': okReply(WECHAT) } });
  const backFirst = await escape.tools.deviceKey({ key: 'back' });
  check('逃生口：back 仍被拒', backFirst.ok === false && backFirst.reason === 'blocked_foreground', backFirst);
  check('逃生口：back 不记步', (escape.readState()?.steps ?? 0) === 0);
  check('逃生口：back 不调 keyevent', escape.runAdb.count('input keyevent') === 0);
  escape.advance(1500);
  const home = await escape.tools.deviceKey({ key: 'home' });
  check('逃生口：home 放行', home.ok === true && home.keycode === 'KEYCODE_HOME', home);
  check('逃生口：home 真的按了 keyevent', escape.runAdb.count('input keyevent') === 1);
  check('逃生口：home 照常记一步', escape.readState()?.steps === 1);
  check('逃生口：日志里记的是 home', escape.actionLog().includes('"action":"home"'));

  // fail-open 也要留痕：读不到前台时，动作日志要能看出这一步是「盲着做的」。
  const blind = makeEnv({ seed: todayState(), routes: { 'dumpsys window': failReply('error: closed') } });
  const blindTap = await blind.tools.deviceTap({ x: 3, y: 4 });
  check('读不到前台仍放行（fail-open）', blindTap.ok === true, blindTap);
  check('盲着做也要留痕：foreground=unknown', blind.actionLog().includes('"foreground":"unknown"'));
  check('盲着做也要留痕：foregroundKnown=false', blind.actionLog().includes('"foregroundKnown":false'));
  check('盲着做也照常记步', (blind.readState()?.steps ?? 0) === 1);

  const nullAgain = makeEnv({ seed: todayState(), routes: { 'dumpsys window': okReply('mCurrentFocus=null\n') } });
  await nullAgain.tools.deviceTap({ x: 5, y: 6 });
  check('mCurrentFocus=null 也留 unknown 记号', nullAgain.actionLog().includes('"foreground":"unknown"'));

  const known = makeEnv({ seed: todayState() });
  await known.tools.deviceTap({ x: 7, y: 8 });
  check('看得见前台（桌面）时不写 unknown 噪音', known.actionLog().includes('"foreground":"unknown"') === false);
}

// ── 13. device_list_apps ──────────────────────────────────────────────────
{
  const pkgs = ['package:com.example.game', 'package:com.example.bili', 'package:com.tencent.mm', 'package:com.android.settings', ''].join('\n');
  const env = makeEnv({ seed: todayState(), routes: { 'pm list packages': okReply(pkgs) } });
  const list = await env.tools.deviceListApps();
  check('list_apps 成功', list.ok === true, list);
  check('list_apps 总数与展示数', list.total === 4 && list.shown === 4);
  check(
    'list_apps 按包名排序',
    JSON.stringify(list.apps.map((item) => item.package)) === '["com.android.settings","com.example.bili","com.example.game","com.tencent.mm"]',
    list.apps,
  );
  check('list_apps 不消耗步数', (env.readState()?.steps ?? 0) === 0);
  check('list_apps 用 pm list packages -3', env.runAdb.last('pm list packages')?.line.includes('-3') === true);
  check('list_apps 写 action log', env.actionLog().includes('list_apps'));
  const settings = list.apps.find((item) => item.package === 'com.android.settings');
  check('黑名单项标 blocked', settings?.blocked === true);
  check('黑名单项带中文名', settings?.label === '系统设置');
  const game = list.apps.find((item) => item.package === 'com.example.game');
  check('普通应用 blocked:false 且不给 label', game?.blocked === false && game?.label === undefined);

  const filtered = await env.tools.deviceListApps({ filter: 'BILI' });
  check('filter 大小写不敏感', filtered.total === 1 && filtered.apps[0].package === 'com.example.bili');
  const noHit = await env.tools.deviceListApps({ filter: 'zzz' });
  check('filter 没命中 → 空列表', noHit.ok === true && noHit.total === 0 && noHit.apps.length === 0);
  const blankFilter = await env.tools.deviceListApps({ filter: '   ' });
  check('空白 filter 当没给', blankFilter.total === 4 && blankFilter.filter === '');

  const manyPkgs = Array.from({ length: 90 }, (_, i) => `package:com.junk.app${String(i).padStart(2, '0')}`).join('\n');
  const capped = await makeEnv({ seed: todayState(), routes: { 'pm list packages': okReply(manyPkgs) } }).tools.deviceListApps();
  check('超过 80 个截断', capped.shown === 80 && capped.total === 90 && capped.truncated === true, capped);
  const exactPkgs = Array.from({ length: 80 }, (_, i) => `package:com.junk.a${i}`).join('\n');
  const exact = await makeEnv({ seed: todayState(), routes: { 'pm list packages': okReply(exactPkgs) } }).tools.deviceListApps();
  check('正好 80 个不算截断', exact.shown === 80 && exact.truncated === false);

  const failEnv = makeEnv({ seed: todayState(), routes: { 'pm list packages': failReply('error: device offline') } });
  check('pm 报错 → offline', (await failEnv.tools.deviceListApps()).reason === 'offline');

  check('功能关闭 → disabled', (await makeEnv({ device: { enabled: false } }).tools.deviceListApps()).reason === 'disabled');
  const paused = await makeEnv({ seed: todayState({ pausedUntil: T0 + 5 * MIN }) }).tools.deviceListApps();
  check('暂停中列应用也拒', paused.ok === false && paused.reason === 'paused');
  const exhausted = await makeEnv({ seed: todayState({ usedMs: 30 * MIN, steps: 60 }) }).tools.deviceListApps();
  check('额度用完仍可列应用', exhausted.ok === true, exhausted);
  const noDev = await makeEnv({ routes: { devices: okReply('List of devices attached\n') } }).tools.deviceListApps();
  check('没设备 → no_device', noDev.ok === false && noDev.reason === 'no_device');
}

// ── 14. 授权闸门（T-024） ─────────────────────────────────────────────────
{
  // ① 没授权：每个工具都拒，且**不碰 adb、不记步**
  const env = makeEnv({ grant: null });
  const tap = await env.tools.deviceTap({ x: 10, y: 20 });
  check('无授权 device_tap 被拒', tap.ok === false && tap.reason === 'not_granted', tap);
  check('无授权提示要管理员说「去玩平板」', String(tap.message).includes('去玩平板'), tap.message);
  check('无授权回执带 granted:false / canPlay:false', tap.granted === false && tap.canPlay === false);
  check('无授权时一次 adb 都没调', env.runAdb.calls.length === 0, env.runAdb.calls.length);
  check('无授权不写 device-state.json（不记步）', env.stateExists() === false);
  check('无授权不写动作日志', env.actionLog() === '');

  const swipe = await env.tools.deviceSwipe({ x1: 0, y1: 0, x2: 10, y2: 10 });
  check('无授权 device_swipe 也被拒', swipe.reason === 'not_granted', swipe);
  const typed = await env.tools.deviceType({ text: 'hi' });
  check('无授权 device_type 也被拒', typed.reason === 'not_granted', typed);
  const key = await env.tools.deviceKey({ key: 'home' });
  check('无授权 device_key 也被拒（home 逃生口也不通）', key.reason === 'not_granted', key);
  const openApp = await env.tools.deviceOpenApp({ package: 'com.example.game' });
  check('无授权 device_open_app 也被拒', openApp.reason === 'not_granted', openApp);
  const listApps = await env.tools.deviceListApps();
  check('无授权 device_list_apps 也被拒（只读工具同样要授权）', listApps.reason === 'not_granted', listApps);
  const shot = await env.tools.deviceScreenshot();
  check('无授权 device_screenshot 也被拒', shot.reason === 'not_granted', shot);
  check('以上全拒之后仍然没有 adb 调用', env.runAdb.calls.length === 0, env.runAdb.calls.length);
  check('以上全拒之后仍然没有状态文件', env.stateExists() === false);

  // ② status 是唯一的例外：能回答，但必须说清楚「不能玩」
  const status = await env.tools.deviceStatus();
  check('无授权 device_status 仍能回答', status.ok === true, status);
  check('无授权 status 带 granted:false', status.granted === false, status.granted);
  check('无授权 status 的 canPlay:false', status.canPlay === false, status.canPlay);
  check('无授权 status 不带 grant 详情', status.grant === null, status.grant);
  check('无授权 status 的 grantMessage 说明还没授权', String(status.grantMessage).includes('还没有'), status.grantMessage);
  check('无授权 status 仍然报设备信息', status.connected === true && status.battery.level === 87);
  check('无授权 status 不消耗步数', env.stateExists() === false);

  // ③ 有授权：照常干活、照常记步
  const allowed = makeEnv({ seed: todayState() });
  const allowedTap = await allowed.tools.deviceTap({ x: 3, y: 4 });
  check('有授权时 device_tap 正常', allowedTap.ok === true, allowedTap);
  check('有授权时真的调了 adb', allowed.runAdb.count('input tap') === 1);
  check('有授权时记了一步', allowed.readState()?.steps === 1);
  const allowedStatus = await allowed.tools.deviceStatus();
  check('有授权时 status 带 granted:true', allowedStatus.granted === true);
  check('有授权时 status 带剩余分钟', allowedStatus.grant?.leftMinutes === 30, allowedStatus.grant);
  // 刚点完还在 minGapMs 冷却里，往前拨 1.5 秒再看额度（否则 canPlay 会被 cooldown 判 false）。
  allowed.advance(1500);
  check('有授权时 status 的 canPlay 由额度决定', (await allowed.tools.deviceStatus()).canPlay === true);

  // ④ 授权过期：与「从来没授权」分开说
  const expiredEnv = makeEnv({ seed: todayState(), grant: makeGrant({ expiresAt: T0 - 1 }) });
  const expiredTap = await expiredEnv.tools.deviceTap({ x: 1, y: 1 });
  check('授权过期 → not_granted', expiredTap.reason === 'not_granted', expiredTap);
  check('授权过期文案点名「过期」', String(expiredTap.message).includes('过期'), expiredTap.message);
  check('授权过期不调 adb', expiredEnv.runAdb.calls.length === 0);
  const expiredStatus = await expiredEnv.tools.deviceStatus();
  check('授权过期 status 的 granted:false / canPlay:false', expiredStatus.granted === false && expiredStatus.canPlay === false);
  check('授权过期 status 说「过期」', String(expiredStatus.grantMessage).includes('过期'), expiredStatus.grantMessage);

  // ⑤ 撤销：立刻失效（哪怕 expiresAt 还没到）
  const revokedEnv = makeEnv({ seed: todayState(), grant: makeGrant({ revokedAt: T0 - 1000 }) });
  const revokedTap = await revokedEnv.tools.deviceTap({ x: 2, y: 2 });
  check('撤销后 → not_granted', revokedTap.reason === 'not_granted', revokedTap);
  check('撤销文案点名「撤销」', String(revokedTap.message).includes('撤销'), revokedTap.message);

  // ⑥ 时间往前走：同一个 env 里「先能玩、到点就不能玩」
  const live = makeEnv({ seed: todayState(), grant: makeGrant({ minutes: 5, expiresAt: T0 + 5 * MIN }) });
  const before = await live.tools.deviceTap({ x: 5, y: 5 });
  check('授权期内可以动', before.ok === true, before);
  live.advance(5 * MIN);
  const after = await live.tools.deviceTap({ x: 6, y: 6 });
  check('授权到期那一刻就不能动', after.ok === false && after.reason === 'not_granted', after);

  // ⑦ 坏授权文件只能是「没授权」（fail-closed）
  const broken = makeEnv({ grant: null });
  fs.writeFileSync(broken.grantPath, '{ not json', 'utf8');
  const brokenTap = await broken.tools.deviceTap({ x: 1, y: 1 });
  check('授权文件坏 JSON → not_granted', brokenTap.reason === 'not_granted', brokenTap);
  check('授权文件坏 JSON 不调 adb', broken.runAdb.calls.length === 0);

  // ⑧ grantFile 可注入：授权放在别的目录也能被读到
  const outer = fs.mkdtempSync(path.join(TMP_ROOT, 'grant-'));
  const customGrantPath = path.join(outer, 'custom-grant.json');
  fs.writeFileSync(customGrantPath, JSON.stringify(makeGrant()), 'utf8');
  const custom = makeEnv({ seed: todayState(), grant: null, grantFile: customGrantPath });
  const customTap = await custom.tools.deviceTap({ x: 7, y: 8 });
  check('grantFile 注入的自定义路径生效', customTap.ok === true, customTap);
  check('默认路径没有授权文件（确认读的是注入的那份）', fs.existsSync(path.join(custom.dir, DEVICE_GRANT_FILE)) === false);

  // ⑨ 授权与预算互不替代：额度用完，授权在也照样拒
  const noBudget = await makeEnv({ seed: todayState({ usedMs: 30 * MIN, steps: 60 }) }).tools.deviceTap({ x: 9, y: 9 });
  check('授权在、额度用完 → daily_budget（不是 not_granted）', noBudget.reason === 'daily_budget', noBudget);
}

// ── 15. 窗口感知（T-026）：PC 模式浮窗只许在窗口里点 ────────────────────────
// 真机取证（TB375FC / Android 16）：小黑盒在 ZUI PC 模式下是 [737,0]-[2208,1840] 的浮窗，
// 截图却是整屏 2944x1840。模型照截图给的坐标有两类会出事：窗口外（落到桌面、没反应）与
// 底部手势区（把 App 切走）。全屏应用没有「窗口外」，但**底部手势区同样挡**（2026-10-21 验收后修正：
// 真机上就是点在一个应用底边把另一个应用切走的）。
{
  const PKG = 'com.max.xiaoheihe';
  const FOCUS = (pkg) => `mCurrentFocus=Window{1a2 u0 ${pkg}/${pkg}.MainActivity}\n`;

  /** 一段 `dumpsys window windows`：给某个包一个窗口矩形。 */
  function windowDump(pkg, [l, t, r, b]) {
    return [
      'WINDOW MANAGER WINDOWS (dumpsys window windows):',
      `  Window #1 Window{8f2c u0 ${pkg}/${pkg}.MainActivity}:`,
      '    Frames: containing=[0,0][2944,1840] parent=[0,0][2944,1840] display=[0,0][2944,1840]',
      `      frame=[${l},${t}][${r},${b}] last=[${l},${t}][${r},${b}]`,
    ].join('\n');
  }

  /**
   * 路由：屏幕按真机横屏 2944x1840；`dumpsys window` 给焦点行、`dumpsys window windows`
   * 给窗口段。假 adb 是按「命令串包含关键字」路由的，所以同一个 key 要按 argv 分流
   * （`dumpsys window windows` 也包含 `dumpsys window`，顺序在前者会被后者吃掉）。
   */
  function windowRoutes({ focus, win }) {
    return {
      'wm size': okReply('Physical size: 2944x1840\n'),
      'dumpsys window': (argv) => (argv.includes('windows') ? okReply(win) : okReply(focus)),
    };
  }

  const FLOATING = windowDump(PKG, [737, 0, 2208, 1840]);
  const FULLSCREEN = windowDump('com.example.bili', [0, 0, 2944, 1840]);

  // ① 点在窗口外：拒绝、带矩形、不调 adb、不记步
  const outEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const outTap = await outEnv.tools.deviceTap({ x: 543, y: 1097 });
  check('窗口模式：窗口外的点被拒（outside_window）', outTap.ok === false && outTap.reason === 'outside_window', outTap);
  check('窗口外文案带窗口矩形', String(outTap.message).includes('(737,0)-(2208,1840)'), outTap.message);
  check('窗口外文案带用户给的坐标', String(outTap.message).includes('(543,1097)'));
  check('窗口外文案说清「落到桌面」', String(outTap.message).includes('桌面'));
  check('窗口外被拒不调 input tap', outEnv.runAdb.count('input tap') === 0);
  check('窗口外被拒不记步', (outEnv.readState()?.steps ?? 0) === 0);
  check('窗口外被拒写动作日志', outEnv.actionLog().includes('outside_window'));
  check('回执回带窗口矩形（fullscreen:false）', outTap.window?.left === 737 && outTap.window?.fullscreen === false, outTap.window);

  const leftEdgeOut = await makeEnv({
    seed: todayState(),
    routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }),
  }).tools.deviceTap({ x: 736, y: 900 });
  check('窗口左边界再往左 1px 就是窗口外', leftEdgeOut.reason === 'outside_window', leftEdgeOut);

  // ② 点在底部手势区：拒绝、提示往上挪、不调 adb、不记步
  const gestureEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const gestureTap = await gestureEnv.tools.deviceTap({ x: 1179, y: 1796 });
  check('窗口模式：手势区被拒（gesture_zone）', gestureTap.ok === false && gestureTap.reason === 'gesture_zone', gestureTap);
  check('手势区文案说会把应用切走', String(gestureTap.message).includes('切走'));
  check('手势区文案给出安全 y', String(gestureTap.message).includes('1759'));
  check('手势区被拒不调 input tap', gestureEnv.runAdb.count('input tap') === 0);
  check('手势区被拒不记步', (gestureEnv.readState()?.steps ?? 0) === 0);
  check('手势区被拒写动作日志', gestureEnv.actionLog().includes('gesture_zone'));
  const zoneTopEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  check('手势区上沿 y=1760 就被拒', (await zoneTopEnv.tools.deviceTap({ x: 1500, y: 1760 })).reason === 'gesture_zone');
  const zoneSafeEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  check('手势区上方一像素 y=1759 放行', (await zoneSafeEnv.tools.deviceTap({ x: 1500, y: 1759 })).ok === true);

  // ③ 窗口内：正常下发、正常记步
  const inEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const inTap = await inEnv.tools.deviceTap({ x: 1500, y: 900 });
  check('窗口模式：窗口内正常下发', inTap.ok === true, inTap);
  check('adb 收到窗口内的坐标', inEnv.runAdb.last('input tap')?.line.includes('input tap 1500 900') === true);
  check('窗口内点击照常记一步', inEnv.readState()?.steps === 1);
  check('回执 screen 仍是截图坐标空间（整屏）', inTap.screen.width === 2944 && inTap.screen.height === 1840);

  // ④ 全屏应用：没有「窗口外」这回事，但底部手势区同样挡（2026-10-21 验收后修正）
  const fullEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS('com.example.bili'), win: FULLSCREEN }) });
  const fullMidTap = await fullEnv.tools.deviceTap({ x: 1472, y: 920 });
  check('全屏应用：中部正常放行', fullMidTap.ok === true, fullMidTap);
  check('全屏应用：adb 真的收到了这一下', fullEnv.runAdb.last('input tap')?.line.includes('input tap 1472 920') === true);
  check('全屏应用：中部点击照常记一步', fullEnv.readState()?.steps === 1);
  const tapsBeforeBottom = fullEnv.runAdb.count('input tap');
  fullEnv.advance(1500);
  const bottomTap = await fullEnv.tools.deviceTap({ x: 1179, y: 1796 });
  check('全屏应用：底部手势区的点被拒（gesture_zone）', bottomTap.ok === false && bottomTap.reason === 'gesture_zone', bottomTap);
  check('全屏应用：手势区被拒不调 input tap', fullEnv.runAdb.count('input tap') === tapsBeforeBottom, fullEnv.runAdb.count('input tap'));
  check('全屏应用：手势区被拒不记步', fullEnv.readState()?.steps === 1);
  check('全屏应用：手势区文案说会把应用切走', String(bottomTap.message).includes('切走'));
  check('全屏应用：回执的窗口标 fullscreen:true', bottomTap.window?.fullscreen === true, bottomTap.window);
  fullEnv.advance(1500);
  const cornerTap = await fullEnv.tools.deviceTap({ x: 2943, y: 900 });
  check('全屏应用：右下贴边（不在手势区）仍放行', cornerTap.ok === true, cornerTap);
  fullEnv.advance(1500);
  const fullSwipeBottom = await fullEnv.tools.deviceSwipe({ x1: 1472, y1: 1700, x2: 1472, y2: 1830 });
  check('全屏应用：滑到手势区也被拒', fullSwipeBottom.ok === false && fullSwipeBottom.reason === 'gesture_zone', fullSwipeBottom);
  check('全屏应用：手势区滑动被拒不调 input swipe', fullEnv.runAdb.count('input swipe') === 0);
  fullEnv.advance(1500);
  const fullSwipe = await fullEnv.tools.deviceSwipe({ x1: 1472, y1: 1400, x2: 1472, y2: 900 });
  check('全屏应用：不在手势区的滑动正常放行', fullSwipe.ok === true, fullSwipe);
  check('全屏应用：不在手势区时滑动坐标没有被改写', fullSwipe.clamped === false && fullSwipe.y2 === 900);

  // ⑤ 滑动：两个端点都要在窗口里
  const swipeOutEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const swipeOut = await swipeOutEnv.tools.deviceSwipe({ x1: 1500, y1: 900, x2: 300, y2: 900 });
  check('窗口模式：滑动终点在窗口外被拒', swipeOut.ok === false && swipeOut.reason === 'outside_window', swipeOut);
  check('滑动被窗口外拦住时不调 adb', swipeOutEnv.runAdb.count('input swipe') === 0);
  const swipeGestureEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const swipeGesture = await swipeGestureEnv.tools.deviceSwipe({ x1: 1500, y1: 900, x2: 1500, y2: 1800 });
  check('窗口模式：滑动终点落在手势区被拒', swipeGesture.ok === false && swipeGesture.reason === 'gesture_zone', swipeGesture);
  check('手势区滑动被拒也不调 adb', swipeGestureEnv.runAdb.count('input swipe') === 0);
  const swipeOkEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const swipeOk = await swipeOkEnv.tools.deviceSwipe({ x1: 1500, y1: 1400, x2: 1500, y2: 800 });
  check('窗口模式：窗口内的滑动正常下发', swipeOk.ok === true, swipeOk);
  check('窗口内滑动记一步', swipeOkEnv.readState()?.steps === 1);

  // ⑥ fail-open：读不到窗口信息就当不知道，放行（与黑名单闸门同一取舍）
  const noWinEnv = makeEnv({ seed: todayState(), routes: { 'wm size': okReply('Physical size: 2944x1840\n') } });
  const noWinTap = await noWinEnv.tools.deviceTap({ x: 543, y: 1097 });
  check('读不到窗口信息 → 放行（fail-open）', noWinTap.ok === true, noWinTap);
  const brokenWinEnv = makeEnv({
    seed: todayState(),
    routes: windowRoutes({ focus: FOCUS(PKG), win: 'garbage without any window section\n' }),
  });
  check('dumpsys 解析不出窗口 → 放行', (await brokenWinEnv.tools.deviceTap({ x: 543, y: 1097 })).ok === true);
  const adbErrWinEnv = makeEnv({
    seed: todayState(),
    routes: {
      'wm size': okReply('Physical size: 2944x1840\n'),
      'dumpsys window': (argv) => (argv.includes('windows') ? failReply('error: device offline') : okReply(FOCUS(PKG))),
    },
  });
  const adbErrTap = await adbErrWinEnv.tools.deviceTap({ x: 543, y: 1097 });
  check('读窗口的 adb 报错也不拦动作（窗口只是加分项）', adbErrTap.ok === true, adbErrTap);

  // ⑦ 读不到屏幕尺寸：窗口外的点照样拒（矩形本身就是证据），手势区不判（算不出来）
  const noScreenEnv = makeEnv({
    seed: todayState(),
    routes: {
      'wm size': failReply('error: nope'),
      'dumpsys window': (argv) => (argv.includes('windows') ? okReply(FLOATING) : okReply(FOCUS(PKG))),
    },
  });
  const noScreenOut = await noScreenEnv.tools.deviceTap({ x: 100, y: 900 });
  check('没有屏幕尺寸时窗口外仍然拒', noScreenOut.ok === false && noScreenOut.reason === 'outside_window', noScreenOut);
  noScreenEnv.advance(1200);
  const noScreenBottom = await noScreenEnv.tools.deviceTap({ x: 1500, y: 1796 });
  check('没有屏幕尺寸时手势区不判（放行）', noScreenBottom.ok === true, noScreenBottom);

  // ⑧ 缓存：2 秒内不重复跑 dumpsys；超过 2 秒重读
  const cacheEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  await cacheEnv.tools.deviceTap({ x: 1500, y: 900 });
  cacheEnv.advance(1500);
  await cacheEnv.tools.deviceTap({ x: 1600, y: 900 });
  check('2 秒内复用窗口矩形（只跑一次 dumpsys）', cacheEnv.runAdb.count('window windows') === 1, cacheEnv.runAdb.count('window windows'));
  cacheEnv.advance(2100);
  await cacheEnv.tools.deviceTap({ x: 1700, y: 900 });
  check('超过 2 秒重新读窗口', cacheEnv.runAdb.count('window windows') === 2, cacheEnv.runAdb.count('window windows'));

  // ⑨ 缓存按包名：切 App 立刻重读，不会拿上一个应用的矩形判这一个
  let focus = FOCUS(PKG);
  let win = FLOATING;
  const switchEnv = makeEnv({
    seed: todayState(),
    routes: {
      'wm size': okReply('Physical size: 2944x1840\n'),
      'dumpsys window': (argv) => (argv.includes('windows') ? okReply(win) : okReply(focus)),
    },
  });
  await switchEnv.tools.deviceTap({ x: 1500, y: 900 });
  switchEnv.advance(1200);
  focus = FOCUS('com.example.bili');
  win = FULLSCREEN;
  const switchedTap = await switchEnv.tools.deviceTap({ x: 543, y: 1097 });
  check('切到全屏应用后立刻按新窗口判（x=543 放行）', switchedTap.ok === true, switchedTap);
  check('切包后重新读了窗口', switchEnv.runAdb.count('window windows') === 2, switchEnv.runAdb.count('window windows'));

  // ⑩ device_status 的 foregroundWindow + 给 prompt 的快照
  const statusEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS(PKG), win: FLOATING }) });
  const status = await statusEnv.tools.deviceStatus();
  check('status 回带 foregroundWindow', status.foregroundWindow?.left === 737, status.foregroundWindow);
  check('foregroundWindow 标 fullscreen:false', status.foregroundWindow?.fullscreen === false);
  check('foregroundWindow 带宽高', status.foregroundWindow?.width === 1471 && status.foregroundWindow?.height === 1840);
  check('foregroundWindow 与 foreground 指向同一个应用', status.foreground === PKG);
  check('status 的 screen 仍是整屏', status.screen.width === 2944 && status.screen.height === 1840);
  check('窗口模式不影响 status 的额度与授权', status.ok === true && status.canPlay === true && status.leftSteps === 60);

  const fullStatusEnv = makeEnv({ seed: todayState(), routes: windowRoutes({ focus: FOCUS('com.example.bili'), win: FULLSCREEN }) });
  const fullStatus = await fullStatusEnv.tools.deviceStatus();
  check('全屏应用的 foregroundWindow 标 fullscreen:true', fullStatus.foregroundWindow?.fullscreen === true, fullStatus.foregroundWindow);

  const noWinStatus = await makeEnv({ seed: todayState() }).tools.deviceStatus();
  check('读不到窗口时 foregroundWindow 是 null', noWinStatus.foregroundWindow === null, noWinStatus.foregroundWindow);

  // 给桥接 prompt 用的快照（state/device-window.json）：本模块写、桥接只读
  const snapshotFile = path.join(statusEnv.dir, DEVICE_WINDOW_FILE);
  check('status 写下给 prompt 用的窗口快照', fs.existsSync(snapshotFile));
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  check('快照带 package 与矩形', snapshot.package === PKG && snapshot.left === 737 && snapshot.right === 2208, snapshot);
  check('快照带 fullscreen:false（桥接据此才补那句话）', snapshot.fullscreen === false);
  const fullSnapshot = JSON.parse(fs.readFileSync(path.join(fullStatusEnv.dir, DEVICE_WINDOW_FILE), 'utf8'));
  check('全屏应用的快照 fullscreen:true', fullSnapshot.fullscreen === true, fullSnapshot);
  check('窗口快照不影响步数账本（status 仍是 0 步）', statusEnv.readState()?.steps === 0, statusEnv.readState());

  // ⑪ 窗口闸门不记账：被拒的几下都没有真的动设备
  check('被窗口闸门拒的几步都没有记账', (outEnv.readState()?.steps ?? 0) === 0 && (gestureEnv.readState()?.steps ?? 0) === 0);
}

// ── 清理与结果 ──────────────────────────────────────────────────────────────
fs.rmSync(TMP_ROOT, { recursive: true, force: true });
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
if (failed > 0) process.exitCode = 1;
