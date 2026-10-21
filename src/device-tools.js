// 平板操作的 MCP 工具层：把 `src/device-core.js` 的纯判断接到真实 adb 上，
// 并把「今天还能不能玩」落盘成 `state/device-state.json`。
//
// 分层（照 src/heybox-tools.js 的写法）：
// - `createDeviceTools({ runAdb, readConfig, now, stateDir })` 返回**朴素对象**，
//   每个方法只做一件事、只返回数据、永不抛；
// - `registerDeviceTools(server, opts)` 只做 `server.tool(name, desc, schema, handler)`，
//   不掺业务逻辑。
// 这样单测可以注入假 adb（不插 USB 也能跑全套），桥接侧也能换 stateDir。
//
// 两道**硬的**闸门（都在本层，模型绕不过去）：
// ① 授权（T-024）：读 `state/device-grant.json`（桥接在管理员说「去玩平板」时写），
//    没有有效授权时每个工具入口直接 `not_granted` —— **不碰 adb、不记步**；
//    `device_status` 例外：允许调用（它要能解释「为什么不能玩」），但回执带
//    `granted:false` / `canPlay:false`；
// ② 预算（device-core 的 deviceBudget）：日额度 / 步数 / 步间间隔 / 暂停窗口。
//    授权在、额度用完照样拒 —— 两者同时生效。
//
// 边界（每个工具的 description 里也写了一遍，模型看得见）：
// - 只玩不越界：不改系统设置、不装/卸应用、不支付不登录不删东西；
// - 每个**动作**执行前先读前台包名（`dumpsys window` 的 mCurrentFocus）：命中黑名单
//   （内核五项：支付宝 / 微信 / QQ / Play 商店 / 系统设置）一律拒，且不记步 ——
//   名单只能往上加，用户改配置也删不掉内核（见 device-core 的 DEVICE_KERNEL_BLOCKED_APPS）；
// - 一次只做一步，做完先看截图；
// - 中文输入不支持（adb 的 `input text` 只吃 ASCII），要打中文就改成点按/滑动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// 授权是**另一道闸门**（T-024）：文件名与判定都来自纯模块 src/device-grant.js，
// 与桥接（写授权）用的是同一套规则，绝不各写一份。
import {
  DEVICE_GRANT_FILE,
  NOT_GRANTED_MESSAGE,
  grantSummary,
  isGrantActive,
  parseGrant,
} from './device-grant.js';
import {
  DEVICE_DEFAULTS,
  DEVICE_KEYCODES,
  blockedAppLabel,
  blockedForegroundText,
  blockedOpenText,
  budgetReasonText,
  clampPoint,
  clampSwipe,
  classifyAction,
  createDeviceState,
  defaultRunAdb,
  describeAdbError,
  deviceBudget,
  gestureZoneText,
  isBlockedApp,
  isFullscreenWindow,
  isInGestureZone,
  isPointInWindow,
  normalizeDeviceConfig,
  outsideWindowText,
  parseDevices,
  parseDeviceState,
  parseForeground,
  parsePngSize,
  parseWindowFrame,
  pickDevice,
  recordStep,
  serializeDeviceState,
  validateAppPackage,
} from './device-core.js';

// ESM 里没有 __dirname；用 import.meta.url 反推仓库根，和 heybox-tools.js 同口径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 状态目录：与 `src/heybox-tools.js` 的 DEFAULT_STATE_DIR 指向同一个 `state/`（已 gitignore）。 */
export const DEFAULT_STATE_DIR = path.join(ROOT, 'state');
/** 预算状态文件（6 个字段，见 device-core.js 的 parseDeviceState）。 */
export const DEVICE_STATE_FILE = 'device-state.json';
/** 动作留痕：一行一个 JSON，只追加、不读回。出问题时要靠它复盘「它到底点了什么」。 */
export const DEVICE_ACTION_LOG = 'device-actions.jsonl';
/** 截图目录（在 state/ 下面）。 */
export const DEVICE_SHOT_DIR = 'device';
/**
 * 前台窗口快照（T-026）：**本模块写、桥接只读**。
 *
 * 为什么要落盘：prompt 的 `device` 块是桥接拼的（另一个进程），它拿不到这里的内存缓存，
 * 而模型只有从 prompt 里才知道「这个应用只是个浮窗」。文件很小（一个矩形 + 全屏标记），
 * 每次刷新窗口信息时覆盖写；桥接一次 GET /api/socialV2/prompt 只读它，不写。
 */
export const DEVICE_WINDOW_FILE = 'device-window.json';
/** 授权文件（T-024）：**桥接写、本模块只读**。文件名与判定规则都来自 src/device-grant.js。 */
export { DEVICE_GRANT_FILE };

const SHOT_TIMEOUT_MS = 20 * 1000;
const SHELL_TIMEOUT_MS = 10 * 1000;
const DEFAULT_SWIPE_MS = 300;
// adb 的 input swipe 时长下限/上限：80ms 以下常被系统当成 tap，3000ms 以上会卡住输入队列。
const SWIPE_MS_RANGE = [100, 2000];
// 一次输入最多 200 字符：`input text` 是逐字符注入的，太长会拖住前台应用甚至被系统丢弃。
const MAX_TYPE_LENGTH = 200;
// 一次最多列 80 个应用：平板上的第三方应用通常 20–40 个，80 足够；再多就是刷屏吃 token。
const LIST_APPS_MAX = 80;
// 动作日志单行上限：避免把整段文本（可能含用户隐私）写进日志。
const MAX_LOG_TEXT = 40;
// 前台窗口矩形的缓存时长（T-026）：同一台设备、同一个包 2 秒内复用同一份 `dumpsys` 结果。
// 视觉闭环是「点一下 → 0.8 秒 → 截图 → 再点」，2 秒刚好覆盖一轮，又不至于拿十几秒前的
// 旧窗口去判「这一下点在哪」。
const WINDOW_CACHE_MS = 2000;

// ── 小工具 ──────────────────────────────────────────────────────────────────
/** 只认对象（数组 / null / 字符串一律当空）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 读 JSON 文件：不存在 / 坏 JSON / 读不了都回 `fallback`，不抛。 */
function readJsonFile(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读 `config.json`：与 heybox-tools 的 defaultReadConfig 同口径。
 * 坏 JSON 返回 `{}` —— 配置坏了不该让整个桥接起不来，device 块自然走默认值。
 */
export function defaultReadConfig() {
  return readJsonFile(path.join(ROOT, 'config.json'), {});
}

/** 统一的「文本结果」形状：和 heybox-tools 的 textResult 一致（失败带 isError）。 */
function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(value && value.ok === false ? { isError: true } : {}),
  };
}

/** 诊断日志只走 stderr：stdout 是 MCP 协议流，多写一个字节都会破坏协议。 */
function logWarn(message) {
  try {
    console.error(`[device] ${message}`);
  } catch {
    // 控制台被关掉也不能影响工具本身。
  }
}

/** 数字参数：接受数字或数字字符串，其它一律 NaN（由调用方判「没给」）。 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** 文本参数：去掉首尾空白；非字符串给空串。 */
function toTrimmed(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** 毫秒时间戳：`now()` 返回啥就信啥，但只有有限数字才用，否则回 0（core 会自己兜底）。 */
function safeNow(now) {
  try {
    const at = Number(now());
    return Number.isFinite(at) ? Math.trunc(at) : 0;
  } catch {
    return 0;
  }
}

/** 读配置块：`readConfig()` 抛错 / 返回怪东西都收敛成 `{}`（再由 core 归一成默认值）。 */
function readDeviceConfig(readConfig) {
  let raw;
  try {
    raw = readConfig();
  } catch {
    raw = {};
  }
  const block = isPlainObject(raw) ? raw.device : {};
  return normalizeDeviceConfig(block);
}

// ── adb 输出解析（纯函数，导出给单测直接验） ────────────────────────────────
/**
 * 解析 `wm size`：
 *   `Physical size: 2560x1600`
 *   `Override size: 1280x800`（开发者选项里设过分辨率时才有，优先用它，因为截图就是这个尺寸）
 * 返回 `{width, height}` 或 `null`。
 */
export function parseWmSize(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const override = /Override size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  const physical = /Physical size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  const matched = override ?? physical;
  if (!matched) return null;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width, height };
}

/**
 * 解析 `dumpsys battery`：取 `level:` 与 `status:`。
 * status 是数字码（1 未知 / 2 充电中 / 3 放电中 / 4 未充电 / 5 已满），额外翻成人话。
 * 解析不到就给 `null` 字段而不是抛错 —— 电量只是锦上添花，不该让 status 整个失败。
 */
export function parseBattery(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const levelMatch = /level:\s*(\d+)/i.exec(text);
  const statusMatch = /status:\s*(\d+)/i.exec(text);
  const level = levelMatch ? Number(levelMatch[1]) : null;
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const labels = { 1: 'unknown', 2: 'charging', 3: 'discharging', 4: 'not_charging', 5: 'full' };
  return {
    level: Number.isFinite(level) ? level : null,
    status: Number.isFinite(status) ? status : null,
    state: status !== null && labels[status] ? labels[status] : 'unknown',
  };
}

/**
 * 解析 `pm list packages -3` 的 stdout：一行一个 `package:com.example.app`。
 * 噪声行（空行 / `WARNING:` / 别的输出）直接跳过；重复包名只留第一次（保留设备给的顺序）。
 */
export function parsePackageList(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const apps = [];
  const seen = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const matched = /^package:([A-Za-z0-9_.]+)$/.exec(line);
    if (!matched) continue;
    const pkg = matched[1];
    if (pkg === '' || seen.has(pkg)) continue;
    seen.add(pkg);
    apps.push(pkg);
  }
  return apps;
}

/**
 * ASCII 文本 → adb `input text` 的参数。
 *
 * adb 的 input 走的是「按键事件」而不是剪贴板，所以只吃 ASCII；中文没有任何不装输入法的
 * 办法能打进去（ADBKeyboard 需要额外装 App，用户明确要求「不装应用」）。
 * 转义规则：字母数字原样；空格必须写成 `%s`（`input text` 认这个，直接传空格会被 shell 拆开）。
 * 其余 ASCII 符号一律 `%XX`。**注意这是有损的**：`%XX` 不是 adb 的解码格式，设备端 shell 也
 * 不会还原，所以 `hi!` 实际会打出字面的 `hi%21`。取舍是「宁可打错几个标点，也绝不让 `&`/`|`/`'`
 * 被设备端 shell 当成语法执行」—— 打错的标点看得见、改起来只是重打一遍；被解释成命令则可能
 * 触发我们根本不打算碰的界面。真要精确输入，改成黑名单式反斜杠转义即可（改这一个函数）。
 */
export function encodeAdbText(text) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x30 && code <= 0x39) out += char; // 0-9
    else if (code >= 0x41 && code <= 0x5a) out += char; // A-Z
    else if (code >= 0x61 && code <= 0x7a) out += char; // a-z
    else if (code === 0x20) out += '%s';
    else out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 是否全是 ASCII（可打印 + 空格）；用于 device_type 的「中文直接拒」。 */
function isAsciiText(text) {
  if (typeof text !== 'string' || text === '') return false;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code > 0x7e) return false;
    if (code < 0x20 && code !== 0x09) return false; // 换行等控制字符也拒绝
  }
  return true;
}

/** 设备选择失败 → 中文话术（`multiple_devices` 单独说，别的走 describeAdbError 的码表）。 */
function deviceFail(reason, extra = {}) {
  if (reason === 'multiple_devices') {
    return {
      ok: false,
      reason: 'multiple_devices',
      message: '接了好几台设备，我不知道该操作哪一台；只插一台平板再试',
      ...extra,
    };
  }
  const described = describeAdbError(reason);
  return { ok: false, reason: described.code, message: described.reason, ...extra };
}

// ── 工厂 ────────────────────────────────────────────────────────────────────
/**
 * 造八个工具的实现函数。
 *
 * 注入点全在这里：
 * - `runAdb(args, {adbPath, timeoutMs})` → `{ok, code, stdout, stderr, stdoutBuffer}`（**不抛**）；
 * - `readConfig()` → 整份 config.json 对象（取 `device` 块）；
 * - `now()` → 毫秒时间戳（预算与日界都靠它，单测可以随便拨）；
 * - `stateDir` → 状态文件与截图的落盘目录；
 * - `grantFile` → 授权文件路径（缺省 `<stateDir>/device-grant.json`，测试可注入临时路径）。
 *
 * 每个方法都返回朴素对象（截图例外：它返回文件路径与尺寸，由注册层再读成 base64 图片）。
 * 所有方法都做三件事：闸门（enabled / **授权** / 预算）→ 干活（adb）→ 记账（成功才写）。
 */
export function createDeviceTools({
  runAdb = defaultRunAdb,
  readConfig = defaultReadConfig,
  now = () => Date.now(),
  stateDir = DEFAULT_STATE_DIR,
  grantFile = null,
} = {}) {
  const stateFile = path.join(stateDir, DEVICE_STATE_FILE);
  const actionLogFile = path.join(stateDir, DEVICE_ACTION_LOG);
  const shotDir = path.join(stateDir, DEVICE_SHOT_DIR);
  // 授权文件跟着 stateDir 走（与桥接的 `state/device-grant.json` 同一个文件）；
  // 显式传了 grantFile 就用它 —— 单测靠这个把授权隔离在临时目录里。
  const grantPath = grantFile === null || grantFile === undefined
    ? path.join(stateDir, DEVICE_GRANT_FILE)
    : grantFile;

  /**
   * 最近一次截图的宽高（连同 serial）：**这才是当前显示 / 输入坐标空间**。
   *
   * `wm size` 报的是物理面板（联想小新 Pad Pro 竖持 1840x2944），横屏应用跑起来后
   * 实际可点区域是旋转后的 2944x1840；拿物理尺寸夹取会把 x∈[1840,2944) 的合法坐标
   * 夹到 1840，点错位置。截图就是模型看到的那张图，宽高天然正确。
   *
   * 只放内存、不落盘：进程重启后退回 `wm size`，下一次截图又会校准。
   * 记 serial 是为了换一台设备时自动作废，别拿上一台的尺寸夹这一台。
   */
  let lastShot = null;

  /** 取「这台设备」最近一次截图的尺寸；没截过 / 换了一台 → null（调用方回退 `wm size`）。 */
  function rememberedScreen(serial) {
    if (!lastShot || lastShot.serial !== serial) return null;
    return { width: lastShot.width, height: lastShot.height };
  }

  /**
   * 前台窗口矩形的缓存（T-026）：`{ serial, package, at, frame }`。
   *
   * 缓存键带上**包名**：切到另一个 App 时立刻作废，绝不会拿上一个应用（比如全屏的 B 站）的
   * 矩形去判这一个（PC 模式浮窗的小黑盒）的点。`at` 用单调递增的注入时钟比较，
   * 时钟回拨（测试里拨过去）一律当过期重读，宁可多跑一次 dumpsys 也不拿旧窗口判错。
   */
  let windowCache = null;

  /**
   * 读当前前台应用的窗口矩形（`dumpsys window windows` → `parseWindowFrame`），带 2 秒缓存。
   *
   * 为什么要单独读一次而不是复用 `dumpsys window`：那一份只取 `mCurrentFocus`（黑名单闸门），
   * 窗口矩形在 `windows` 段里；把两件事拆开，哪一份解析失败都不影响另一件。
   * 读不到 / 解析不出一律 `null`（调用方按「不知道窗口」放行）。
   */
  async function readWindowFrame(cfg, serial, pkg, at) {
    if (typeof pkg !== 'string' || pkg === '') return null;
    const cached = windowCache;
    if (cached && cached.serial === serial && cached.package === pkg
      && at - cached.at >= 0 && at - cached.at < WINDOW_CACHE_MS) {
      return cached.frame;
    }
    const res = await runAdb(['-s', serial, 'shell', 'dumpsys', 'window', 'windows'], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    const frame = res && res.ok === true ? parseWindowFrame(res.stdout, pkg) : null;
    // 解析失败也缓存：这一屏（这个包）就是读不出窗口，别在 2 秒内反复跑 dumpsys。
    windowCache = { serial, package: pkg, at, frame };
    return frame;
  }

  /**
   * 把「现在这个前台窗口长什么样」写进 `state/device-window.json` —— **桥接只读**，
   * prompt 的 `device` 块靠它说「窗口在 (l,t)-(r,b)，只在窗口里点」。
   *
   * 写失败只影响提示词里少一句话，绝不影响动作本身（所以吞掉异常、不发 warn 刷屏）。
   * 没有矩形时写 `{ package, at }`（没有 `fullscreen` 字段 = 「不知道」），
   * 桥接侧 `windowPromptHint` 见到不是 `fullscreen:false` 就一个字都不加。
   */
  function saveWindowInfo(pkg, frame, screen, at) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const data = frame
        ? {
          package: pkg,
          at,
          left: frame.left,
          top: frame.top,
          right: frame.right,
          bottom: frame.bottom,
          width: frame.width,
          height: frame.height,
          fullscreen: isFullscreenWindow(frame, screen),
        }
        : { package: pkg, at };
      fs.writeFileSync(path.join(stateDir, DEVICE_WINDOW_FILE), JSON.stringify(data), 'utf8');
    } catch {
      // 见上：提示词块少一句话，不影响动作。
    }
  }

  /**
   * 读前台窗口 + 判全屏 + 更新提示词快照。
   *
   * 返回 `{ frame, fullscreen }`；不知道前台是谁 / dumpsys 里没有这个包的窗口 / 读不到 → `null`。
   * `screen` 允许为 `null`（读不到屏幕尺寸）：这时 `isFullscreenWindow` 给 `false`，于是按
   * 「窗口模式」多判一道「窗口外」—— 全屏应用的矩形本来就覆盖整屏，不会有窗口外的点，不会误拒；
   * 而「底部手势区」依赖屏幕高度，屏幕读不到时窗口闸门会自己跳过那一步（见 windowBlock）。
   */
  async function describeWindow(cfg, serial, pkg, screen, at) {
    if (typeof pkg !== 'string' || pkg === '') return null;
    const frame = await readWindowFrame(cfg, serial, pkg, at);
    saveWindowInfo(pkg, frame, screen, at);
    if (!frame) return null;
    return { frame, fullscreen: isFullscreenWindow(frame, screen) };
  }

  /** 读状态：文件不存在 / 坏 JSON → 全新状态（今天还没玩）。 */
  function loadState(at) {
    let raw = '';
    try {
      raw = fs.readFileSync(stateFile, 'utf8');
    } catch {
      return createDeviceState(at);
    }
    return parseDeviceState(raw);
  }

  /** 写状态：目录不在就建，写失败只 warn 不抛（下一步还会再试）。 */
  function saveState(state) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, serializeDeviceState(state), 'utf8');
      return true;
    } catch (error) {
      console.error(`[device] 写状态失败：${String(error?.message ?? error)}`);
      return false;
    }
  }

  /** 追加一条动作日志（只留类型与关键数字，文本截断，避免把隐私写进磁盘）。 */
  function appendLog(entry) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.appendFileSync(actionLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 日志失败不影响动作本身。
    }
  }

  /**
   * 读授权文件（只读）：文件不存在 / 坏 JSON / 形状不对 → `parseGrant` 的空授权
   * （`expiresAt: 0`，永远判过期）。**读接口绝不写盘**：一次「看一眼能不能玩」
   * 不该往 state/ 里落任何文件。
   */
  function loadGrant() {
    return parseGrant(readJsonFile(grantPath, null));
  }

  /**
   * 未授权的统一回执。
   *
   * 三种情形文案不同（模型据此决定怎么跟用户解释）：
   * - 从来没有授权 → 让管理员说「去玩平板」；
   * - 上次授权过期 → 说明「上一次已经过期」，再请管理员说一句；
   * - 上次授权被撤销 → 说明「被撤销了」，别自己找补。
   * 回执固定带 `granted:false` / `canPlay:false`，模型不用去猜。
   */
  function notGranted(grant, at) {
    const summary = grantSummary(grant, at);
    const why = summary.reason === 'expired'
      ? '（上一次授权已经过期了）'
      : (summary.reason === 'revoked' ? '（上一次授权被管理员撤销了）' : '');
    return {
      ok: false,
      reason: 'not_granted',
      message: `${NOT_GRANTED_MESSAGE}${why}`,
      granted: false,
      canPlay: false,
    };
  }

  /**
   * 统一闸门：功能开关 → **授权** → 预算。
   * 返回 `{ok:true, cfg, state, budget, grant}` 或可直接返回的失败对象。
   *
   * 顺序是定死的：`disabled` 必须在最前（功能关着时说「没授权」会把人引去要授权），
   * 授权排在预算前面（没授权时连额度都不该提，否则模型会以为「等额度回来就能玩」）。
   */
  function gate(at) {
    const cfg = readDeviceConfig(readConfig);
    if (!cfg.enabled) {
      return { ok: false, cfg, budget: null, fail: { ok: false, reason: 'disabled', message: budgetReasonText('disabled', {}) } };
    }
    const grant = loadGrant();
    if (!isGrantActive(grant, at)) {
      return { ok: false, cfg, budget: null, grant, fail: notGranted(grant, at) };
    }
    const state = loadState(at);
    const budget = deviceBudget(state, cfg, at);
    if (!budget.ok) {
      return {
        ok: false,
        cfg,
        state,
        budget,
        grant,
        fail: { ok: false, reason: budget.reason, message: budgetReasonText(budget.reason, budget) },
      };
    }
    return { ok: true, cfg, state, budget, grant };
  }

  /** 成功动作的记账：步数 +1（跨日自动重置）→ 写盘 → 写日志 → 回带剩余额度。 */
  function settle(at, state, action, payload) {
    const next = recordStep(state, at, action);
    saveState(next);
    const cfg = readDeviceConfig(readConfig);
    const budget = deviceBudget(next, cfg, at);
    appendLog({ ts: at, action: action.type, ...payload });
    return {
      leftMinutes: Math.ceil(budget.leftMs / 60000),
      leftSteps: budget.leftSteps,
      usedSteps: budget.usedSteps,
    };
  }

  /** 找设备：`adb devices -l` → 恰好一台 `device` 才算数。 */
  async function findDevice(cfg) {
    const res = await runAdb(['devices', '-l'], { adbPath: cfg.adbPath, timeoutMs: SHELL_TIMEOUT_MS });
    if (!res || res.ok !== true) {
      const described = describeAdbError(res?.stderr);
      return { ok: false, fail: { ok: false, reason: described.code, message: described.reason } };
    }
    const picked = pickDevice(parseDevices(res.stdout));
    if (!picked.ok) return { ok: false, fail: deviceFail(picked.reason, { serials: picked.serials }) };
    return { ok: true, serial: picked.serial, device: picked.device };
  }

  /**
   * 读「输入坐标空间」的宽高。
   *
   * **优先用最近一次截图的尺寸**：`wm size` 是物理面板（竖持 1840x2944），横屏应用的实际
   * 显示 / 输入空间是旋转后的 2944x1840（真机 TB375FC 实测），拿它夹取会把合法横屏坐标
   * 夹错。还没截过图时回退 `wm size`（进程刚起 / 模型直接点）；两个都读不到就返回 null
   * （调用方跳过夹取，别把整个动作弄失败）。
   */
  async function screenSize(cfg, serial) {
    const remembered = rememberedScreen(serial);
    if (remembered) return remembered;
    const res = await runAdb(['-s', serial, 'shell', 'wm', 'size'], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    if (!res || res.ok !== true) return null;
    return parseWmSize(res.stdout);
  }

  /**
   * 读前台包名：`dumpsys window` → `mCurrentFocus` → 包名。
   *
   * 单开一次 adb（约 300–1500ms）：这是「动一下之前先看一眼」的代价，比点错便宜得多。
   * 读不到 / 解析不出都回 `known:false`，**不抛、不拦**（放行的理由见 foregroundBlock）。
   */
  async function readForeground(cfg, serial) {
    const res = await runAdb(['-s', serial, 'shell', 'dumpsys', 'window'], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    if (!res || res.ok !== true) return { known: false, pkg: null };
    const pkg = parseForeground(res.stdout);
    return { known: pkg !== null, pkg };
  }

  /**
   * 黑名单硬闸门：动一下之前先看前台是谁，命中就拒 + 留痕（**不记步**）。
   *
   * 为什么「解析不出前台」放行而不是拒绝：`mCurrentFocus` 的格式在各家 ROM 上并不统一，
   * 换一台平板就可能一条都抠不出来；这时若按「看不见 = 拒绝」处理，整个功能会一步都走不动，
   * 用户看到的却是「什么都没发生」。风险面也可控：要拦的是「点进钱包 / 聊天」，而那种界面
   * 通常真的会给出 mCurrentFocus（系统窗口）。**放行也要留痕**：`known:false` 会由调用方
   * 写进那条动作日志（`foreground:'unknown'`），事后能看出这一步是「盲着做的」。
   *
   * 逃生口 `home`（2026-10-21 指挥官决策）：前台命中黑名单时 `back` 仍然拦，`home` 放行 ——
   * home 只回桌面，不会在黑名单应用里点掉任何东西；没有这个口子，模型会卡在微信/支付宝界面上
   * 自己退不出来（截图看得见，却一个动作都做不了）。`back` 不放行：back 是应用内导航，
   * 可能真的改变那个应用里的状态（比如关掉一个正在输入的对话框）。
   *
   * 留痕但**不记账**：被拦的一下没有真的动设备，扣额度等于「误站到微信屏」反复白扣钱 ——
   * 账本要反映真实动作数。放行的 home 是真的按了一下，所以照常记步。
   *
   * 返回 `{ blocked, known, pkg }`：`blocked` 为 null = 放行，非 null 是可直接返回给模型的失败对象；
   * `known:false` 表示前台读不到 / 解析不出（放行，但调用方要把这件事写进动作日志）。
   * `pkg` 是这次读到的前台包名（读不到为 null）—— 窗口闸门（T-026）要用它去查窗口矩形。
   */
  async function foregroundBlock(cfg, serial, at, actionType) {
    // home 是逃生口：不读前台、不拦，也不改记账（这一步仍然会算一步）。
    if (actionType === 'home') return { blocked: null, known: true, pkg: null };
    const fg = await readForeground(cfg, serial);
    if (fg.pkg === null) return { blocked: null, known: false, pkg: null };
    if (!isBlockedApp(fg.pkg, cfg)) return { blocked: null, known: true, pkg: fg.pkg };
    appendLog({ ts: at, action: actionType, blocked: 'blocked_foreground', foreground: fg.pkg });
    return {
      blocked: {
        ok: false,
        reason: 'blocked_foreground',
        message: blockedForegroundText(fg.pkg),
        foreground: fg.pkg,
        blocked: true,
      },
      known: true,
      pkg: fg.pkg,
    };
  }

  /**
   * 窗口闸门（T-026）：PC 模式浮窗的应用，只许在**窗口矩形内**动手；底部手势区一律挡。
   *
   * 真机验收（TB375FC）：小黑盒在 ZUI PC 模式下是 `[737,0]-[2208,1840]` 的浮窗，而截图是整屏
   * 2944x1840 —— 模型照截图给的坐标有两类会出事：
   * - 点在窗口外（x=543 / 455）→ 落到桌面层，毫无反应；
   * - 点在底部 1604–1840 → 触发手势导航，把 App 切走（真机上真的发生了）。
   * 所以这里挡两种情况，理由分开给：`outside_window`（坐标要落在窗口里）与
   * `gesture_zone`（往上挪一点）。被拒的一下**没有真的动设备，不记步**，只留痕。
   *
   * **两条判定的适用范围不同**（2026-10-21 验收后修正）：
   * - `outside_window` 只对**窗口模式**有意义 —— 全屏应用的矩形覆盖整屏，不存在「窗口外」；
   * - `gesture_zone` 对**所有应用**都判，全屏也一样：屏幕最底下那一条是系统手势导航区，
   *   全屏应用点底边同样会把 App 切走（真机验收时就是点在一个应用底边把另一个应用切走的）。
   *   代价是「全屏应用底部 80px 内的按钮点不到」，模型会被提示把 y 往上挪一点 —— 比
   *   「点一下就把 App 切走、整轮白玩」划算。
   *
   * fail-open：不知道前台是谁 / `dumpsys` 里没有这个包的窗口 / 读不到 → 放行。与黑名单闸门
   * 同一取舍：看不见的东西不能当成罪证，否则换一台 ROM 就一步都走不动。
   *
   * 返回 `null`（放行）或可直接回给模型的失败对象。
   */
  async function windowBlock(cfg, serial, pkg, screen, points, at, actionType) {
    const info = await describeWindow(cfg, serial, pkg, screen, at);
    if (!info) return null;
    const rect = {
      left: info.frame.left,
      top: info.frame.top,
      right: info.frame.right,
      bottom: info.frame.bottom,
      width: info.frame.width,
      height: info.frame.height,
      fullscreen: info.fullscreen,
    };
    // 窗口外：只有窗口模式才判（全屏应用没有「窗口外」这回事）。
    if (!info.fullscreen) {
      const outside = points.find((point) => !isPointInWindow(point, info.frame));
      if (outside) {
        appendLog({ ts: at, action: actionType, blocked: 'outside_window', ...rect });
        return {
          ok: false,
          reason: 'outside_window',
          message: outsideWindowText(info.frame, outside),
          window: rect,
          blocked: true,
        };
      }
    }
    // 手势区：全屏 / 窗口模式都判；没有屏幕尺寸就算不出这一条在哪，跳过（fail-open）。
    if (screen) {
      const gesture = points.find((point) => isInGestureZone(point, screen));
      if (gesture) {
        appendLog({ ts: at, action: actionType, blocked: 'gesture_zone', x: gesture.x, y: gesture.y, ...rect });
        return {
          ok: false,
          reason: 'gesture_zone',
          message: gestureZoneText(gesture, screen),
          window: rect,
          blocked: true,
        };
      }
    }
    return null;
  }

  /** 前台读不到时给动作日志留个记号（放行是刻意的，「悄悄放行」不是）。 */
  function foregroundTrace(fg) {
    return fg && fg.known === false ? { foreground: 'unknown', foregroundKnown: false } : {};
  }

  /** 一条 adb shell 命令的公共收尾：失败 → 中文错误对象；成功 → null。 */
  function shellFail(res) {
    if (res && res.ok === true) return null;
    const described = describeAdbError(res?.stderr);
    const detail = typeof res?.stderr === 'string' ? res.stderr.trim().slice(0, 200) : '';
    return {
      ok: false,
      reason: described.code,
      message: detail === '' ? described.reason : `${described.reason}（${detail}）`,
    };
  }

  // ── 1. device_status ──────────────────────────────────────────────────────
  /**
   * 看设备与额度：不消耗步数（只是「看一眼」），但功能关着时也如实说关着。
   * 电量解析失败就给 `null` —— 用户要的是「能不能玩」，不是「dumpsys 的完整输出」。
   *
   * **授权是唯一的例外**：没授权时别的工具一律 `not_granted`，只有它允许调用 ——
   * 模型得能回答「为什么不能玩」。回执固定带 `granted` / `grant`，并把 `canPlay`
   * 与授权取交集（额度够但没授权 → `canPlay:false`），所以模型不会误以为可以动手。
   * 它本身**不动设备**（只读电量 / 尺寸 / 前台），没授权时看一眼也没有副作用。
   */
  async function deviceStatus() {
    const at = safeNow(now);
    const cfg = readDeviceConfig(readConfig);
    const state = loadState(at);
    const budget = deviceBudget(state, cfg, at);
    const grant = loadGrant();
    const grantOk = isGrantActive(grant, at);
    const grantInfo = grantSummary(grant, at);
    const base = {
      enabled: cfg.enabled,
      // 授权（T-024）：没授权时 canPlay 一定是 false —— 额度够也不算能玩。
      granted: grantOk,
      grant: grantOk
        ? {
          grantedBy: grantInfo.grantedBy,
          minutes: grantInfo.minutes,
          steps: grantInfo.steps,
          leftMinutes: grantInfo.leftMinutes,
          expiresAt: grantInfo.expiresAt,
        }
        : null,
      grantMessage: grantInfo.text,
      usedMinutes: Math.floor(budget.usedMs / 60000),
      usedMs: budget.usedMs,
      usedSteps: budget.usedSteps,
      leftMinutes: Math.ceil(budget.leftMs / 60000),
      leftSteps: budget.leftSteps,
      maxMinutesPerDay: budget.maxMinutesPerDay,
      maxStepsPerDay: budget.maxStepsPerDay,
      canPlay: budget.ok && grantOk,
      budgetReason: budget.reason,
      budgetMessage: budgetReasonText(budget.reason, budget),
      nextAllowedAt: budget.nextAllowedAt,
      pausedUntil: state.pausedUntil > at ? state.pausedUntil : 0,
      pausedReason: state.pausedUntil > at ? state.pausedReason : '',
      apps: [...cfg.apps],
      blockedApps: [...cfg.blockedApps],
      // 没连上 / 没解析出来时是 null；连上后由 dumpsys window 现读（模型据此判断自己停在哪一屏）。
      foreground: null,
      // 窗口模式（T-026）的矩形同理：没连上时先占位，连上后由 dumpsys window windows 现读。
      foregroundWindow: null,
      day: state.day,
    };
    if (!cfg.enabled) {
      return { ...base, ok: false, reason: 'disabled', message: base.budgetMessage, connected: false };
    }

    const found = await findDevice(cfg);
    if (!found.ok) return { ...base, ...found.fail, connected: false };

    const [batteryRes, sizeRes, focusRes] = await Promise.all([
      runAdb(['-s', found.serial, 'shell', 'dumpsys', 'battery'], {
        adbPath: cfg.adbPath,
        timeoutMs: SHELL_TIMEOUT_MS,
      }),
      runAdb(['-s', found.serial, 'shell', 'wm', 'size'], {
        adbPath: cfg.adbPath,
        timeoutMs: SHELL_TIMEOUT_MS,
      }),
      runAdb(['-s', found.serial, 'shell', 'dumpsys', 'window'], {
        adbPath: cfg.adbPath,
        timeoutMs: SHELL_TIMEOUT_MS,
      }),
    ]);
    const battery = batteryRes && batteryRes.ok === true ? parseBattery(batteryRes.stdout) : { level: null, status: null, state: 'unknown' };
    // 屏幕尺寸同样以最近一次截图为准：横屏时 `wm size` 给的是竖屏物理尺寸，模型照它给坐标
    // 就会偏；没截过图才回退 `wm size`（与 tap / swipe 的夹取口径保持一致）。
    const screen = rememberedScreen(found.serial)
      ?? (sizeRes && sizeRes.ok === true ? parseWmSize(sizeRes.stdout) : null);
    // 前台包名：解析不出就是 null（老 ROM / dumpsys 被裁），这时不给模型编一个名字。
    const foreground = focusRes && focusRes.ok === true ? parseForeground(focusRes.stdout) : null;
    // 前台窗口矩形（T-026）：PC 模式浮窗时告诉模型「这个应用只占一块」，并顺手把快照写给
    // 桥接的 prompt 块。读不到 / 解析不出就是 null —— status 照常回，不因为窗口读不出而失败。
    const windowInfo = await describeWindow(cfg, found.serial, foreground, screen, at);

    return {
      ...base,
      ok: true,
      connected: true,
      serial: found.serial,
      model: found.device?.model ?? '',
      // `status` 是 dumpsys 的原始状态码（2/3/4/5），`state` 是翻好的人话；
      // 两个都给：模型读人话，排查时还能对照原始码。
      battery: { level: battery.level, status: battery.status, state: battery.state },
      screen: screen ?? { width: null, height: null },
      foreground,
      // 窗口模式（浮窗）时是 `{left, top, right, bottom, width, height, fullscreen:false}`；
      // 全屏应用 `fullscreen:true`；读不到窗口就是 null。模型据此知道「能点在哪一块」。
      foregroundWindow: windowInfo
        ? { ...windowInfo.frame, fullscreen: windowInfo.fullscreen }
        : null,
    };
  }

  // ── 2. device_screenshot ─────────────────────────────────────────────────
  /**
   * 截一张图存到 `<stateDir>/device/shot-<ts>.png`，返回路径与尺寸。
   *
   * 截图**不计步**：它是「看」，不是「动」；模型每步都要看一眼，把它算进 60 步会把预算
   * 耗在观察上。日额度 / 步额度用完后依然允许截图 —— 那时最需要看见自己在哪一屏，好把本轮收尾。
   *
   * **也放行 cooldown**：`minGapMs`（默认 1 秒）本来是为了不让人「机枪连点」，而视觉闭环是
   * 「点一下 → 等 0.8 秒 → 截图看效果」，正好落在冷却里。把「看」也拦掉会让循环第一眼就失败，
   * 而多看一屏不会造成任何伤害。仍然拦 `disabled` / `paused`：被叫去回消息时不该继续盯屏幕。
   *
   * **不受黑名单闸门约束**：黑名单拦的是「动作」（点/滑/打字/按键/开应用）；截图只是看，
   * 而且恰恰是模型发现「我怎么停在微信这一屏上」的唯一途径 —— 不看就永远不知道该等。
   * 代价是可能的私密画面会进上下文：设备是用户自己的、模型也是用户自己的，这个代价值得付。
   */
  /**
   * 「只读类」工具（截图 / 列应用）允许穿过的拦截原因：看一眼不会动设备。
   * 日额度与步额度用完后仍然允许 —— 那时最需要看清自己在哪一屏、还能玩什么，好把本轮收尾。
   */
  const READ_ALLOWED_BLOCKS = Object.freeze(['daily_budget', 'step_budget', 'cooldown']);

  async function deviceScreenshot() {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok && !READ_ALLOWED_BLOCKS.includes(gateResult.fail.reason)) {
      return gateResult.fail;
    }
    const cfg = gateResult.cfg;

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const res = await runAdb(['-s', found.serial, 'exec-out', 'screencap', '-p'], {
      adbPath: cfg.adbPath,
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    if (!res || res.ok !== true) {
      const described = describeAdbError(res?.stderr);
      return { ok: false, reason: described.code, message: `截图失败：${described.reason}` };
    }
    const buffer = Buffer.isBuffer(res.stdoutBuffer) ? res.stdoutBuffer : Buffer.from(res.stdout ?? '', 'utf8');
    const size = parsePngSize(buffer);
    if (size === null) {
      return { ok: false, reason: 'bad_image', message: '截图返回的不是有效 PNG（可能是 adb 版本或设备忙），再试一次' };
    }
    // 记住这张图的宽高：它才是当前显示 / 输入坐标空间（横屏时与 `wm size` 不同）。
    // 写盘失败也已经知道尺寸了 —— 尺寸是设备给的，与本地存图成败无关。
    lastShot = { serial: found.serial, width: size.width, height: size.height };

    const file = path.join(shotDir, `shot-${at}.png`);
    try {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(file, buffer);
    } catch (error) {
      return { ok: false, reason: 'write_failed', message: `截图存不下：${String(error?.message ?? error)}` };
    }

    appendLog({ ts: at, action: 'screenshot', file: path.basename(file), width: size.width, height: size.height });
    return {
      ok: true,
      path: file,
      width: size.width,
      height: size.height,
      mimeType: 'image/png',
      serial: found.serial,
      bytes: buffer.length,
    };
  }

  // ── 3. device_tap ────────────────────────────────────────────────────────
  /** 点一下：坐标先夹进屏幕（读不到屏幕尺寸就原样传，交给系统忽略越界）。 */
  async function deviceTap(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok) return gateResult.fail;
    const { cfg } = gateResult;

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const size = await screenSize(cfg, found.serial);
    const rawX = toNumber(args?.x);
    const rawY = toNumber(args?.y);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      return { ok: false, reason: 'invalid_params', message: 'tap 需要数字坐标 x、y' };
    }
    let x = Math.trunc(rawX);
    let y = Math.trunc(rawY);
    let clamped = false;
    if (size) {
      const point = clampPoint(x, y, size.width, size.height);
      if (!point) {
        return { ok: false, reason: 'invalid_params', message: '坐标不合法，给数字 x、y' };
      }
      clamped = point.x !== x || point.y !== y;
      x = point.x;
      y = point.y;
    }

    const fg = await foregroundBlock(cfg, found.serial, at, 'tap');
    if (fg.blocked) return fg.blocked;

    // 窗口闸门（T-026）：PC 模式浮窗只许在窗口里点；底部手势区对**所有**应用都拒
    // （全屏应用点底边也会被切走）。
    const windowFail = await windowBlock(cfg, found.serial, fg.pkg, size, [{ x, y }], at, 'tap');
    if (windowFail) return windowFail;

    const res = await runAdb(['-s', found.serial, 'shell', 'input', 'tap', String(x), String(y)], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    const failed = shellFail(res);
    if (failed) return failed;

    const settled = settle(at, gateResult.state, { type: 'tap' }, { x, y, ...foregroundTrace(fg) });
    return { ok: true, x, y, clamped, screen: size ?? { width: null, height: null }, ...settled };
  }

  // ── 4. device_swipe ──────────────────────────────────────────────────────
  /**
   * 滑一下。时长夹到 100–2000ms：太短会被系统当成 tap（`input swipe` 的已知行为），
   * 太长会把输入队列堵住，后面的动作全排队。
   */
  async function deviceSwipe(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok) return gateResult.fail;
    const { cfg } = gateResult;

    const coords = ['x1', 'y1', 'x2', 'y2'].map((key) => toNumber(args?.[key]));
    if (coords.some((value) => !Number.isFinite(value))) {
      return { ok: false, reason: 'invalid_params', message: 'swipe 需要数字坐标 x1、y1、x2、y2' };
    }
    const rawDuration = toNumber(args?.durationMs);
    const durationMs = Number.isFinite(rawDuration)
      ? Math.min(SWIPE_MS_RANGE[1], Math.max(SWIPE_MS_RANGE[0], Math.trunc(rawDuration)))
      : DEFAULT_SWIPE_MS;

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const size = await screenSize(cfg, found.serial);
    let [x1, y1, x2, y2] = coords.map((value) => Math.trunc(value));
    let clamped = false;
    if (size) {
      const swipe = clampSwipe(x1, y1, x2, y2, size.width, size.height);
      if (!swipe) return { ok: false, reason: 'invalid_params', message: '滑动坐标不合法' };
      clamped = swipe.x1 !== x1 || swipe.y1 !== y1 || swipe.x2 !== x2 || swipe.y2 !== y2;
      ({ x1, y1, x2, y2 } = swipe);
    }

    const fg = await foregroundBlock(cfg, found.serial, at, 'swipe');
    if (fg.blocked) return fg.blocked;

    // 窗口闸门（T-026）：滑动的**两个端点**都要在窗口里（窗口模式）—— 起点在窗口外会落到桌面；
    // 任一端点压到底部手势区会把应用切走（真机上都发生过，全屏应用也一样）。
    const windowFail = await windowBlock(
      cfg,
      found.serial,
      fg.pkg,
      size,
      [{ x: x1, y: y1 }, { x: x2, y: y2 }],
      at,
      'swipe',
    );
    if (windowFail) return windowFail;

    const res = await runAdb(
      ['-s', found.serial, 'shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)],
      { adbPath: cfg.adbPath, timeoutMs: SHELL_TIMEOUT_MS },
    );
    const failed = shellFail(res);
    if (failed) return failed;

    const settled = settle(
      at,
      gateResult.state,
      { type: 'swipe' },
      { x1, y1, x2, y2, durationMs, ...foregroundTrace(fg) },
    );
    return { ok: true, x1, y1, x2, y2, durationMs, clamped, screen: size ?? { width: null, height: null }, ...settled };
  }

  // ── 5. device_type ───────────────────────────────────────────────────────
  /**
   * 打 ASCII 文本。中文**直接拒绝**并告诉模型改用点击：
   * - `input text` 走按键事件，非 ASCII 会被静默丢掉（看上去「没报错但什么也没输入」）；
   * - 装 ADBKeyboard 能解决，但用户明确「不装应用」，所以这不是可选项。
   */
  async function deviceType(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok) return gateResult.fail;
    const { cfg } = gateResult;

    const text = typeof args?.text === 'string' ? args.text : '';
    if (text === '') {
      return { ok: false, reason: 'invalid_params', message: 'text 不能为空' };
    }
    if (!isAsciiText(text)) {
      return {
        ok: false,
        reason: 'ascii_only',
        message: 'adb 输入只支持 ASCII；中文请改用点击/滑动操作',
      };
    }
    if (text.length > MAX_TYPE_LENGTH) {
      return { ok: false, reason: 'too_long', message: `一次最多输入 ${MAX_TYPE_LENGTH} 个字符` };
    }
    const verdict = classifyAction({ type: 'type', text }, cfg);
    if (verdict === 'risky') {
      return {
        ok: false,
        reason: 'risky',
        message: '这段文字像是密码/支付/登录/删除一类的内容，不打。真要输入请用户自己来。',
      };
    }

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const fg = await foregroundBlock(cfg, found.serial, at, 'type');
    if (fg.blocked) return fg.blocked;

    const res = await runAdb(['-s', found.serial, 'shell', 'input', 'text', encodeAdbText(text)], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    const failed = shellFail(res);
    if (failed) return failed;

    const settled = settle(at, gateResult.state, { type: 'type' }, { chars: text.length, ...foregroundTrace(fg) });
    return { ok: true, chars: text.length, ...settled };
  }

  // ── 6. device_key ────────────────────────────────────────────────────────
  /** 只给 back / home；映射表在 core 的 DEVICE_KEYCODES（那是唯一的真值来源）。 */
  async function deviceKey(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok) return gateResult.fail;
    const { cfg } = gateResult;

    const key = toTrimmed(args?.key).toLowerCase();
    const keycode = DEVICE_KEYCODES[key];
    if (!keycode) {
      return { ok: false, reason: 'invalid_params', message: 'key 只能是 back 或 home' };
    }

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const fg = await foregroundBlock(cfg, found.serial, at, key);
    if (fg.blocked) return fg.blocked;

    const res = await runAdb(['-s', found.serial, 'shell', 'input', 'keyevent', keycode], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    const failed = shellFail(res);
    if (failed) return failed;

    const settled = settle(at, gateResult.state, { type: key }, { keycode, ...foregroundTrace(fg) });
    return { ok: true, key, keycode, ...settled };
  }

  // ── 7. device_open_app ───────────────────────────────────────────────────
  /**
   * 按包名启动。三道闸门，顺序是定死的：
   * ① 黑名单（`device.blockedApps`，内核五项永远在）→ 一律拒，`blocked_app`；
   * ② 白名单（`device.apps`）非空时只允许里面的包，`not_allowed`；
   * ③ 动作前的黑名单前台闸门（防止现在停在微信/支付宝那一屏）。
   *
   * 为什么黑名单要单独占一个 reason：白名单外可以「叫用户加进去」，黑名单是「永远不行」，
   * 模型收到的下一步动作完全不同（前者可以商量，后者只能换个应用玩）。
   */
  async function deviceOpenApp(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok) return gateResult.fail;
    const { cfg } = gateResult;

    const pkg = toTrimmed(args?.package);
    if (!validateAppPackage(pkg)) {
      return { ok: false, reason: 'invalid_package', message: `包名不合法：${pkg === '' ? '(空)' : pkg}` };
    }
    if (isBlockedApp(pkg, cfg)) {
      appendLog({ ts: at, action: 'open_app', blocked: 'blocked_app', package: pkg });
      return { ok: false, reason: 'blocked_app', message: blockedOpenText(pkg), package: pkg, blocked: true };
    }
    const verdict = classifyAction({ type: 'open_app', package: pkg }, cfg);
    if (verdict === 'risky') {
      return {
        ok: false,
        reason: 'not_allowed',
        message: `白名单外的应用不开：${pkg}。只玩不越界——聊天、支付、设置这类不该由我来开。`,
      };
    }

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const fg = await foregroundBlock(cfg, found.serial, at, 'open_app');
    if (fg.blocked) return fg.blocked;

    const res = await runAdb(
      ['-s', found.serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
      { adbPath: cfg.adbPath, timeoutMs: 15 * 1000 },
    );
    const failed = shellFail(res);
    if (failed) {
      // monkey 打不开发布时退出码常常仍是 0，只在输出里抱怨一句，这里单独认出来。
      const noisy = `${res?.stdout ?? ''} ${res?.stderr ?? ''}`;
      if (/no activities found|monkey aborted/i.test(noisy)) {
        return { ok: false, reason: 'app_not_found', message: `打不开 ${pkg}：这台平板上没装这个应用，或它没有启动入口` };
      }
      return failed;
    }
    const noisy = `${res?.stdout ?? ''} ${res?.stderr ?? ''}`;
    if (/no activities found|monkey aborted/i.test(noisy)) {
      return { ok: false, reason: 'app_not_found', message: `打不开 ${pkg}：这台平板上没装这个应用，或它没有启动入口` };
    }

    const settled = settle(at, gateResult.state, { type: 'open_app' }, { package: pkg, ...foregroundTrace(fg) });
    return { ok: true, package: pkg, ...settled };
  }

  // ── 8. device_list_apps ──────────────────────────────────────────────────
  /**
   * 列出平板上装了哪些**第三方应用**（`pm list packages -3`：系统应用列出来只会刷屏）。
   *
   * 为什么需要它：`device_open_app` 要求给包名，而模型没法凭空知道这台机器上装了什么 ——
   * 没有清单就只能瞎猜，猜错一次就是一次 `app_not_found`，白烧一步。
   *
   * 和截图同一档：不消耗步数、日额度/步额度用完后仍可列（「我还能玩什么」是收尾信息），
   * 但 `disabled` / `paused` 照拦。**不做前台闸门**：它只读列表、不动设备。
   *
   * 每项都带 `blocked`（在不在黑名单里），模型据此一眼看出哪些连试都不用试；
   * `filter` 是包名子串（大小写不敏感），用来在 40 个包里找「记得有个 bili 什么的」。
   */
  async function deviceListApps(args = {}) {
    const at = safeNow(now);
    const gateResult = gate(at);
    if (!gateResult.ok && !READ_ALLOWED_BLOCKS.includes(gateResult.fail.reason)) {
      return gateResult.fail;
    }
    const cfg = gateResult.cfg;

    const found = await findDevice(cfg);
    if (!found.ok) return found.fail;

    const res = await runAdb(['-s', found.serial, 'shell', 'pm', 'list', 'packages', '-3'], {
      adbPath: cfg.adbPath,
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    const failed = shellFail(res);
    if (failed) return failed;

    const all = parsePackageList(res.stdout);
    const filter = toTrimmed(args?.filter).slice(0, 60);
    const needle = filter.toLowerCase();
    const matched = needle === '' ? all : all.filter((pkg) => pkg.toLowerCase().includes(needle));
    const sorted = [...matched].sort();
    const shown = sorted.slice(0, LIST_APPS_MAX);
    const apps = shown.map((pkg) => {
      const blocked = isBlockedApp(pkg, cfg);
      const label = blocked ? blockedAppLabel(pkg) : '';
      return label === '' ? { package: pkg, blocked } : { package: pkg, blocked, label };
    });

    appendLog({ ts: at, action: 'list_apps', total: matched.length, shown: apps.length, filter });
    return {
      ok: true,
      serial: found.serial,
      total: matched.length,
      shown: apps.length,
      truncated: sorted.length > shown.length,
      filter,
      apps,
    };
  }

  return {
    deviceStatus,
    deviceScreenshot,
    deviceTap,
    deviceSwipe,
    deviceType,
    deviceKey,
    deviceOpenApp,
    deviceListApps,
  };
}

// ── 工具描述（模型看得见，边界写在这里） ────────────────────────────────────
const BOUNDARY = '只玩不越界：不改系统设置、不装/卸应用、不支付不登录不删东西。一次只做一步，做完再看截图。中文输入不支持，用点击代替打字。没有管理员授权时，除 device_status 外的工具一律返回 not_granted（不碰平板、不记步）——要管理员在 QQ 里说「去玩平板」；授权与每日额度是两道独立的闸门。前台一旦停在黑名单应用（支付宝 / 微信 / QQ / Play 商店 / 系统设置）上，除了 device_status / device_screenshot / device_list_apps，其它动作一律会被拒；这时唯一能自救的动作是 device_key home（只回桌面，不碰那个应用里的任何东西）。';

/** 八个工具的名字（顺序即注册顺序，便于日志对照；与桥接的 toolMap 逐字同序）。 */
export const DEVICE_TOOL_NAMES = Object.freeze([
  'device_status',
  'device_screenshot',
  'device_tap',
  'device_swipe',
  'device_type',
  'device_key',
  'device_open_app',
  'device_list_apps',
]);

/**
 * 把八个工具挂到 MCP server 上（只做 `server.tool(...)`，逻辑全在 `createDeviceTools` 里）。
 *
 * `opts` 原样透传给工厂（runAdb / readConfig / now / stateDir / grantFile），单测可以直接传假 adb。
 * 截图工具的 handler 在这里把文件读成 base64，返回
 * `{content:[{type:'text'}, {type:'image', mimeType, data}]}` —— 和 qq_get_message_images
 * 的图片形状一致，视觉模型能直接看。
 */
export function registerDeviceTools(server, opts = {}) {
  const tools = createDeviceTools(opts);
  // 统一收口：工具函数自身「永不抛」，但注入进来的假 adb / 磁盘 IO 仍可能抛。
  // MCP 层抛异常会让整轮对话断掉，所以这里兜住，错误也只作为一种普通结果回去。
  const handle = async (fn, args) => {
    if (typeof fn !== 'function') return { ok: false, reason: 'not_implemented', message: '工具未实现' };
    try {
      return await fn(args ?? {});
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 200);
      logWarn(`device 工具出错：${detail}`);
      return { ok: false, reason: 'internal', message: `工具内部出错：${detail}` };
    }
  };

  server.tool(
    'device_status',
    `看平板现在是什么状态：连没连上、型号/序列号、电量、屏幕尺寸、今天已经玩了几分钟和几步、还能玩多久、现在能不能动手、暂停原因。不消耗额度。没授权时也会如实回答（granted:false、canPlay:false，并说明要管理员怎么授权）。${BOUNDARY}`,
    {},
    async (args) => textResult(await handle(tools.deviceStatus, args)),
  );

  server.tool(
    'device_screenshot',
    `给平板截一张图并直接返回图片（这是你看屏幕的唯一入口）。先看画面再决定点哪里；截图不计步、不消耗额度。建议节奏：动一下 → 截图 → 再动。${BOUNDARY}`,
    {},
    async (args) => {
      const shot = await handle(tools.deviceScreenshot, args);
      if (!shot || shot.ok !== true) return textResult(shot ?? { ok: false, reason: 'unknown', message: '截图失败' });
      let data = '';
      try {
        data = fs.readFileSync(shot.path).toString('base64');
      } catch (error) {
        return textResult({ ok: false, reason: 'read_failed', message: `截图读不回来：${String(error?.message ?? error)}` });
      }
      return {
        content: [
          { type: 'text', text: `平板截图 ${shot.width}x${shot.height}（坐标按这个尺寸给）：${path.basename(shot.path)}` },
          { type: 'image', mimeType: 'image/png', data },
        ],
      };
    },
  );

  server.tool(
    'device_tap',
    `在平板屏幕上点一下，坐标是截图里的像素坐标（越界会自动夹到屏幕内）。点之前先 device_screenshot 看准位置；点完再截一张确认效果。窗口模式（PC 模式浮窗）的应用只允许点在窗口矩形内，点窗口外会返回 outside_window（落到桌面、没反应）。屏幕最底部的手势区对任何应用都算禁区，会返回 gesture_zone（会把应用切走），把 y 往上挪一点再点。${BOUNDARY}`,
    {
      x: z.coerce.number().describe('横坐标（像素，按截图宽度）'),
      y: z.coerce.number().describe('纵坐标（像素，按截图高度）'),
    },
    async (args) => textResult(await handle(tools.deviceTap, args)),
  );

  server.tool(
    'device_swipe',
    `在平板上滑一下：从 (x1,y1) 滑到 (x2,y2)，durationMs 100–2000 毫秒（默认 300）。用来滚动列表、翻页、拖动滑块。窗口模式的应用要求两个端点都在窗口矩形内（窗口外 → outside_window）；两个端点落在屏幕最底部的手势区会返回 gesture_zone（对任何应用都一样，会把应用切走）。${BOUNDARY}`,
    {
      x1: z.coerce.number().describe('起点横坐标'),
      y1: z.coerce.number().describe('起点纵坐标'),
      x2: z.coerce.number().describe('终点横坐标'),
      y2: z.coerce.number().describe('终点纵坐标'),
      durationMs: z.coerce.number().optional().describe('滑动时长，100–2000 毫秒，默认 300'),
    },
    async (args) => textResult(await handle(tools.deviceSwipe, args)),
  );

  server.tool(
    'device_type',
    `往当前输入框里打 ASCII 文本（英文/数字/符号）。不支持中文：adb 的输入是按键事件，中文打不进去，要打中文请改用点击/滑动操作。空格会自动转义，长度上限 200。密码、支付、登录、验证码一类的内容一律不打。${BOUNDARY}`,
    {
      text: z.string().describe('要输入的 ASCII 文本（中文会被拒绝）'),
    },
    async (args) => textResult(await handle(tools.deviceType, args)),
  );

  server.tool(
    'device_key',
    `按一下平板上的物理键：back 返回、home 回桌面。用于退出全屏/关掉弹窗/回到主屏。前台停在黑名单应用上时只有 home 能按（逃生口：只回桌面，不碰那个应用里的内容），back 仍会被拒。${BOUNDARY}`,
    {
      key: z.enum(['back', 'home']).describe('back = 返回键，home = 回桌面'),
    },
    async (args) => textResult(await handle(tools.deviceKey, args)),
  );

  server.tool(
    'device_open_app',
    `按包名启动一个应用（例如 com.example.game）。黑名单（内置：支付宝 / 微信 / QQ / Play 商店 / 系统设置，改配置也删不掉）一律拒绝；白名单（config.json 的 device.apps）非空时只允许里面的包，留空表示不限制包名。不知道包名就先用 device_list_apps 查。${BOUNDARY}`,
    {
      package: z.string().describe('Android 包名，例如 com.tencent.tmgp.sgame'),
    },
    async (args) => textResult(await handle(tools.deviceOpenApp, args)),
  );

  server.tool(
    'device_list_apps',
    `列出平板上装了哪些第三方应用（包名 + 是否在黑名单里），用来找 device_open_app 该填什么包名。filter 按包名子串过滤（大小写不敏感），一次最多列 80 个。不消耗额度、也不动设备。${BOUNDARY}`,
    {
      filter: z.string().optional().describe('包名子串，例如 bili（大小写不敏感）'),
    },
    async (args) => textResult(await handle(tools.deviceListApps, args)),
  );

  return tools;
}

/** 供桥接侧判断「设备功能是否配置齐全」时用的默认值快照（只读）。 */
export { DEVICE_DEFAULTS };
