// 安卓平板「自己玩」的纯逻辑：配置归一 / adb devices 解析 / 设备选择 / 坐标夹取 /
// 包名校验 / 黑名单（内核不可移除） / 前台包名解析 / 风险动作分类 / 当日预算 /
// 状态解析与序列化 / adb 错误话术 / 提示词块 / 可注入的 adb 执行器。
//
// 为什么单独成文件：预算（30 分钟 / 60 步）、坐标夹取、白名单判定这三件事必须能在
// **不接 adb、不起 MCP、不碰 state 目录** 的前提下被反复验证。MCP 层（src/device-tools.js）
// 只负责「读 config.json → 调这里的函数 → 调 adb → 写 state」，判断全在本文件。
//
// 约束：
// - 几乎全是纯函数；时间一律由调用方以 `now`（毫秒时间戳）注入，本模块**不读系统时钟**
//   —— 纯函数的返回值只能取决于入参，否则单测会随运行时刻漂移。
// - 唯一的副作用在文件末尾 `defaultRunAdb`（child_process.execFile），它是**可注入**的：
//   工具层与单测都可以换掉它，所以本模块本身仍可零副作用地加载。
// - 不写文件、不发网络请求、不碰定时器。
//
// 日界：按**本机本地时间**的自然日（用户要求「按自然日重置」）。跨日判定只在
// `deviceDayKey` 里做一次，预算与记账都复用它，避免「写进去一个日键、读出来另一个」。
import { execFile } from 'node:child_process';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// 单步最长计时：视觉闭环每步间隔通常 < 2 秒；把「隔了一夜又开始点」算进今天的额度是错的，
// 所以单步累计上限压到 10 分钟（超过的部分丢弃，只记「这一步最多花了 10 分钟」）。
const STEP_MAX_MS = 10 * MINUTE_MS;
// Date 能表示的最大时间戳；超出它 new Date() 会得到 Invalid Date。
const MAX_DATE_MS = 8.64e15;
// 一屏 PNG 的硬上限（2560x1600 的截图约 2–4MB）；32MB 是「绝不被输出撑爆」的上限，不是预期值。
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
// adb 单次调用默认超时：screencap 会慢一些，由调用方（工具层）传更大的值。
const DEFAULT_ADB_TIMEOUT_MS = 15 * 1000;

/**
 * 黑名单的**内核**：这五个包永远不许碰，用户改配置也移不掉。
 *
 * 为什么必须写死、而不是只靠 `device.apps` 白名单：白名单管的是「open_app 能开谁」，
 * 它挡不住「模型自己点着点着走进了微信」—— 那不是一次 open_app，而是一次 tap 落在聊天
 * 列表上。所以黑名单的形状是「内核 ∪ 用户追加」，用户只能往上加、不能减：
 * 支付（支付宝）/ 聊天（微信、QQ）/ 装应用（Play 商店）/ 改系统（设置）这五类被点进去，
 * 后果不是「玩错一步」，而是动了不该动的东西（钱、私聊、系统开关）。
 *
 * 注：微信的包名 `com.tencent.mm` 同时承载支付，所以它一处出现就同时覆盖「聊天 + 付款」。
 */
export const DEVICE_KERNEL_BLOCKED_APPS = Object.freeze([
  'com.eg.android.AlipayGphone',
  'com.tencent.mm',
  'com.tencent.mobileqq',
  'com.android.vending',
  'com.android.settings',
]);

/** 内核黑名单的中文名（只用于话术；用户自己追加的项没有名字，话术里直接显示包名）。 */
const BLOCKED_APP_LABELS = Object.freeze({
  'com.eg.android.AlipayGphone': '支付宝',
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.android.vending': 'Play 商店',
  'com.android.settings': '系统设置',
});

/**
 * 出厂默认值。
 *
 * - `apps: []` 表示**不限制包名**（open_app 只校验包名格式）；非空时白名单外的应用一律不开。
 *   出厂留空的原因是「用户装了哪些 galgame / 视频 App 我们不知道」，写死一份名单只会误伤；
 *   真正需要收窄时在 config.json 的 `device.apps` 里列出来即可。
 * - `blockedApps` 默认就是内核那五项，且**归一化时永远并回内核**（用户删不掉）。
 * - `adbPath` 写死本机装好的绝对路径：platform-tools 不一定在 PATH 里，靠 PATH 找 adb 会在
 *   服务进程（不同的 PATH）里神秘失败。用户仍可用 `device.adbPath` 覆盖。
 * - `pauseAfterRunMs` 是「一轮玩完后的冷却」（1 小时）：由桥接在收尾时用 `pauseDevice` 落盘。
 */
export const DEVICE_DEFAULTS = Object.freeze({
  enabled: true,
  adbPath: 'C:\\Users\\MR\\AppData\\Local\\Android\\platform-tools\\adb.exe',
  maxMinutesPerDay: 30,
  maxStepsPerDay: 60,
  minGapMs: 1000,
  pauseAfterRunMs: 60 * MINUTE_MS,
  apps: Object.freeze([]),
  blockedApps: DEVICE_KERNEL_BLOCKED_APPS,
});

/**
 * clamp 区间（两端都是显式语义，不是「不限」）：
 * - 5 分钟 / 5 步是硬下限：再少等于「刚坐下就得走」，功能没有意义；
 * - 120 分钟 / 300 步是硬上限：这是给人用的预算，不是给脚本刷的；
 * - 步间最小间隔上限 1 分钟：再大就把 60 步摊成 1 小时，视觉闭环没法用；
 * - 轮间冷却 10 分钟起步（用户要求「每轮至少间隔 1 小时」，默认值就是 1 小时），
 *   上限 6 小时（再慢等于功能停摆，用户会以为坏了）。
 */
export const DEVICE_LIMITS = Object.freeze({
  maxMinutesPerDay: Object.freeze([5, 120]),
  maxStepsPerDay: Object.freeze([5, 300]),
  minGapMs: Object.freeze([0, MINUTE_MS]),
  pauseAfterRunMs: Object.freeze([10 * MINUTE_MS, 6 * HOUR_MS]),
});

/**
 * 允许按的物理键：只给 back / home。
 * 刻意**不给** recents / enter / wake / power —— 前台应用不可控时，「电源」「最近任务」
 * 这类键会让平板进入我们看不清的状态；back + home 已经足够从任何界面退出来。
 */
export const DEVICE_KEYCODES = Object.freeze({
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
});

/** 明确「恒安全」的动作：不输入内容、不启动应用，点了最多是点错。 */
const SAFE_ACTIONS = Object.freeze(['tap', 'swipe', 'back', 'home', 'key', 'screenshot', 'shot', 'wait']);
/** 需要看文本内容的动作。 */
const TYPE_ACTIONS = Object.freeze(['type', 'text', 'input']);
/** 需要看包名白名单的动作。 */
const OPEN_ACTIONS = Object.freeze(['open_app', 'openapp', 'launch', 'open']);

/**
 * 打字动作的敏感词：命中就判 risky（工具层直接拒，不做任何输入）。
 *
 * 中文词是用户明确点名的那 10 个；英文/谐音那几项是补漏 —— 搜索框里打 `password`
 * 与打「密码」是同一件事，不能因为换了语言就放过去。
 */
const DEVICE_SENSITIVE_WORDS = Object.freeze([
  '密码', '支付', '转账', '验证码', '登录', '购买', '下单', '删除', '卸载', '安装', '付款', '充值',
  'password', 'passwd', 'passcode', 'pay', 'payment', 'transfer', 'verify', 'verification',
  'login', 'signin', 'sign in', 'purchase', 'checkout', 'buy now', 'uninstall', 'install',
  'delete', 'format', 'factory reset',
]);

/** 包名白名单里要忽略的脏值上限：够用即可，防止一份坏配置把数组撑爆。 */
const MAX_APPS = 50;
/** 黑名单上限：内核 5 条 + 用户追加，同样防撑爆（50 条足够覆盖任何真实场景）。 */
const MAX_BLOCKED_APPS = 50;
// 包名长度硬上限（Android 侧限制是 255 字节；取 155 足够任何真实包名）。
const MAX_PACKAGE_LENGTH = 155;
// Android 应用包名：至少两段、每段字母开头（不允许 `1com.foo`、不允许单个 `com`）。
const APP_PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── 基础类型收敛 ────────────────────────────────────────────────────────────
/** 只认对象，数组 / 字符串 / null 一律当「没给」。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 转有限数字：数字直接用，纯数字字符串（如 `"300"`）也接受，布尔 / 空串 / 对象 / NaN /
 * Infinity 一律当「没给」—— 注意 `true` 不能被当成 1。
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 整数 clamp：数字 → 取整后夹到区间（越界抬到边界，而不是回落默认值 ——「0 分钟」是用户
 * 明确表达的一个意图，抬到安全下限比静默改成 30 分钟更可预期）；非数字 → 默认值。
 */
function clampInt(value, bounds, fallback) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(bounds[1], Math.max(bounds[0], Math.trunc(n)));
}

/** 布尔项只认字面 true / false；`0`、`'false'`、`null` 都算「没给」，回落默认值。 */
function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 任意值 → 字符串（对象/数组给空串，避免把「[object Object]」写进日志或状态）。 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 时间戳：接受毫秒数或 Date；非法值回落 `fallback`，并夹在 Date 能表示的范围内。 */
function toTimestamp(value, fallback = 0) {
  let n = NaN;
  if (value instanceof Date) n = value.getTime();
  else n = toFiniteNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DATE_MS, Math.max(-MAX_DATE_MS, Math.trunc(n)));
}

/** 计数 / 时长类字段：非正数或非数字都归 0（脏数据不能变成负数或 NaN 传下去）。 */
function toCount(value) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/** 本地时钟 `HH:mm`（给「暂停到 / X 秒后再动」这类话术用；读本地时区，不写死 UTC+8）。 */
function formatClock(value) {
  const at = toTimestamp(value, 0);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ── 日界 ────────────────────────────────────────────────────────────────────
/**
 * 本地自然日键（`YYYY-MM-DD`）：用 `getFullYear/getMonth/getDate` 取本地日期，
 * 而不是 `toISOString().slice(0,10)`（那是 UTC 日，东八区的 0–8 点会被算到前一天）。
 *
 * 非法时间戳回落到 `1970-01-01`：任何真实日期都不等于它，于是脏状态自然表现为「今天还没玩」。
 */
export function deviceDayKey(now) {
  const at = toTimestamp(now, 0);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '1970-01-01';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 下一个本地 0 点：日额度用完时告诉模型「什么时候再来」。 */
function nextLocalMidnight(now) {
  const at = toTimestamp(now, 0);
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 0;
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
  const ms = next.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// ── 配置 ────────────────────────────────────────────────────────────────────
/** adb 路径：非空字符串才用（去首尾空白），其它一律默认值。 */
function toAdbPath(value) {
  if (typeof value !== 'string') return DEVICE_DEFAULTS.adbPath;
  const trimmed = value.trim();
  return trimmed === '' ? DEVICE_DEFAULTS.adbPath : trimmed;
}

/**
 * 白名单数组：只留**合法包名**并去重（最多 50 条）。
 * 坏配置（字符串 / 数字 / 含非法包名）不抛错 —— 一个手滑的逗号不该让整个功能起不来。
 *
 * `blocked` 非空时顺手做减法：黑名单里出现的包**不允许**留在白名单里。两份名单打架时
 * 一律以黑名单为准（白名单是「可以玩什么」，黑名单是「绝对不能碰」，后者没有商量余地）。
 */
function normalizeApps(value, blocked = []) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const apps = [];
  for (const entry of value) {
    const pkg = typeof entry === 'string' ? entry.trim() : '';
    if (pkg === '' || !validateAppPackage(pkg) || seen.has(pkg) || blocked.includes(pkg)) continue;
    seen.add(pkg);
    apps.push(pkg);
    if (apps.length >= MAX_APPS) break;
  }
  return Object.freeze(apps);
}

/**
 * 黑名单数组：**内核永远在里面**，用户只能追加。
 *
 * - 顺序固定为「内核 5 条 + 用户追加项」：`device_status` / 配置 diff 才稳定；
 * - 用户写了 `[]` 或只写了内核的子集，归一化后仍然得到完整的 5 条（`apps` 白名单可以留空
 *   表示「不限制」，黑名单没有「不限制」这种状态）；
 * - 只收非空字符串并 trim（不校验包名格式）：黑名单**只会让限制更严**，多一条永远不匹配的
 *   脏项无害；反过来，把用户手写的 `com.foo.bar ` 这类带空白项丢掉才是真漏。
 */
function normalizeBlockedApps(value) {
  const seen = new Set();
  const blocked = [];
  const push = (pkg) => {
    if (pkg === '' || pkg.length > MAX_PACKAGE_LENGTH || seen.has(pkg)) return;
    seen.add(pkg);
    blocked.push(pkg);
  };
  for (const pkg of DEVICE_KERNEL_BLOCKED_APPS) push(pkg);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const pkg = typeof entry === 'string' ? entry.trim() : '';
      push(pkg);
      if (blocked.length >= MAX_BLOCKED_APPS) break;
    }
  }
  return Object.freeze(blocked.slice(0, MAX_BLOCKED_APPS));
}

/**
 * 把 `config.json` 里的 `device` 块归一化成可直接使用的冻结对象。
 * 任何脏值都不抛错：缺省 / 非对象 → 全默认；数字类字段 clamp 到 `DEVICE_LIMITS`。
 *
 * 字段顺序与 `DEVICE_DEFAULTS` 一致：控制台/日志里 diff 才稳定。
 */
export function normalizeDeviceConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  // 先算黑名单：白名单要拿它做减法（黑名单优先于白名单，见 normalizeApps 的说明）。
  const blockedApps = normalizeBlockedApps(source.blockedApps);
  return Object.freeze({
    enabled: toBool(source.enabled, DEVICE_DEFAULTS.enabled),
    adbPath: toAdbPath(source.adbPath),
    maxMinutesPerDay: clampInt(
      source.maxMinutesPerDay,
      DEVICE_LIMITS.maxMinutesPerDay,
      DEVICE_DEFAULTS.maxMinutesPerDay,
    ),
    maxStepsPerDay: clampInt(
      source.maxStepsPerDay,
      DEVICE_LIMITS.maxStepsPerDay,
      DEVICE_DEFAULTS.maxStepsPerDay,
    ),
    minGapMs: clampInt(source.minGapMs, DEVICE_LIMITS.minGapMs, DEVICE_DEFAULTS.minGapMs),
    pauseAfterRunMs: clampInt(
      source.pauseAfterRunMs,
      DEVICE_LIMITS.pauseAfterRunMs,
      DEVICE_DEFAULTS.pauseAfterRunMs,
    ),
    apps: normalizeApps(source.apps, blockedApps),
    blockedApps,
  });
}

// ── adb devices ─────────────────────────────────────────────────────────────
/**
 * 解析 `adb devices` / `adb devices -l` 的 stdout，返回 `[{serial, state, model?}]`。
 *
 * 真实输出里混着三类噪声，都要跳过：
 * - `List of devices attached` 表头；
 * - `* daemon not running; starting now at tcp:5037` 这类以 `*` 开头的启动提示；
 * - `adb server version (41) doesn't match this client (37); killing...` 版本提示。
 *
 * 第二列是设备状态（`device` / `unauthorized` / `offline` / `recovery` / `bootloader`）。
 * `-l` 模式额外给 `model:Pixel_6 device:... product:...`，其中 `_` 是空格的转义。
 * `no permissions (user in plugdev group…)` 这一行的第二列是 `no`，单独认成 `no_permissions`。
 */
export function parseDevices(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const devices = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('*')) continue;
    if (/^List of devices\b/i.test(line)) continue;
    if (/^adb server\b/i.test(line)) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    if (serial === '' || serial === undefined) continue;
    if (parts.length < 2) continue;
    const state = /no permissions/i.test(line) ? 'no_permissions' : parts[1];
    if (state === '') continue;
    const entry = { serial, state };
    for (const token of parts.slice(2)) {
      const matched = /^model:(.+)$/.exec(token);
      if (matched) {
        const model = matched[1].replace(/_/g, ' ').trim();
        if (model !== '') entry.model = model;
      }
    }
    devices.push(entry);
  }
  return devices;
}

/**
 * 从设备列表里挑一台：只有**恰好一台 `state === 'device'`** 才算成功。
 *
 * 多设备返回 `{ok:false, reason:'multiple_devices'}` —— 不是「挑第一个」：
 * 挑错设备意味着点错机器，宁可不做。单设备但没授权 / 离线时，reason 分别是
 * `unauthorized` / `offline`，让调用方直接说出「去平板上点允许」而不是「没设备」。
 */
export function pickDevice(devices) {
  const list = (Array.isArray(devices) ? devices : [])
    .filter((item) => isPlainObject(item) && typeof item.serial === 'string' && item.serial.trim() !== '');
  const usable = list.filter((item) => item.state === 'device');
  const serials = list.map((item) => item.serial);

  if (usable.length === 1) {
    return { ok: true, reason: 'ok', serial: usable[0].serial, device: usable[0], serials };
  }
  if (usable.length > 1) {
    return { ok: false, reason: 'multiple_devices', serials: usable.map((item) => item.serial) };
  }
  if (list.length === 0) return { ok: false, reason: 'no_device', serials };
  if (list.some((item) => item.state === 'unauthorized')) {
    return { ok: false, reason: 'unauthorized', serials };
  }
  if (list.some((item) => item.state === 'offline')) {
    return { ok: false, reason: 'offline', serials };
  }
  return { ok: false, reason: 'no_device', serials, states: list.map((item) => item.state) };
}

// ── 坐标 ────────────────────────────────────────────────────────────────────
/** 正整数（屏幕宽高）：非法值返回 null —— 没有屏幕尺寸就没有「夹到屏幕内」这件事。 */
function toScreenSize(value) {
  const n = toFiniteNumber(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.trunc(n);
}

/**
 * 把模型给的坐标夹进屏幕：`x ∈ [0, width-1]`、`y ∈ [0, height-1]`。
 *
 * 为什么夹而不是拒：视觉模型看截图给坐标，偶尔会超出几十像素（截图与真机分辨率不同、
 * 或它把 0 基点算错）；夹一下还能点中边缘，比整步失败重来更省 token。
 * 但**非数字**（null / '' / 'abc' / NaN）返回 null —— 那是模型没说清楚，不能瞎猜成 (0,0)。
 */
export function clampPoint(x, y, width, height) {
  const px = toFiniteNumber(x);
  const py = toFiniteNumber(y);
  const w = toScreenSize(width);
  const h = toScreenSize(height);
  if (!Number.isFinite(px) || !Number.isFinite(py) || w === null || h === null) return null;
  return {
    x: Math.min(w - 1, Math.max(0, Math.trunc(px))),
    y: Math.min(h - 1, Math.max(0, Math.trunc(py))),
  };
}

/** 滑动的两个端点各自夹进屏幕；任一坐标非法返回 null。 */
export function clampSwipe(x1, y1, x2, y2, width, height) {
  const from = clampPoint(x1, y1, width, height);
  const to = clampPoint(x2, y2, width, height);
  if (!from || !to) return null;
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
}

// ── 包名 / 风险分类 ─────────────────────────────────────────────────────────
/**
 * Android 包名校验：至少两段、每段字母开头。
 * 刻意**不去首尾空白** —— `' com.a.b '` 是错输入，应该被拒而不是被悄悄修好；
 * 工具层会先 trim 再调这里，所以模型写空格也不会被误伤。
 */
export function validateAppPackage(pkg) {
  if (typeof pkg !== 'string') return false;
  if (pkg === '' || pkg.length > MAX_PACKAGE_LENGTH) return false;
  return APP_PACKAGE_RE.test(pkg);
}

function actionTypeOf(action) {
  if (typeof action === 'string') return action.trim().toLowerCase();
  if (!isPlainObject(action)) return '';
  return toText(action.type ?? action.action ?? action.kind).trim().toLowerCase();
}

function actionTextOf(action) {
  if (typeof action === 'string') return '';
  if (!isPlainObject(action)) return '';
  return toText(action.text ?? action.message ?? action.value ?? action.content);
}

function actionPackageOf(action) {
  if (!isPlainObject(action)) return '';
  return toText(action.package ?? action.pkg ?? action.name ?? action.app).trim();
}

/**
 * 动作风险分类：`'safe'` / `'risky'`。
 *
 * - `tap` / `swipe` / `back` / `home` / `key` / `screenshot` / `wait` 恒 safe：
 *   它们只搬动「手指」，不产生内容、不花钱、不发消息；
 * - `type` 只有在文本不含敏感词时才 safe（密码/支付/转账/验证码/登录/购买/下单/删除/卸载/安装）；
 *   空文本按 risky 处理 —— 说不清要打什么就别打；
 * - `open_app` 只有在「包名合法 + 不在黑名单 + 在 `apps` 白名单里」时才 safe；`apps` 为空表示
 *   不限制包名（此时只校验格式）—— 空白名单是「没设限」，不是「谁都不许」；
 *   黑名单（`blockedApps`，内核永远在里面）**优先于白名单**：同一个包两边都写了，判 risky；
 * - **其它未知动作一律 risky**：这份代码的默认值是拒绝，新增动作必须先在这里登记。
 *
 * `cfg` 可传原始配置或归一化后的配置（内部再归一一次，幂等）。
 */
export function classifyAction(action, cfg) {
  const config = normalizeDeviceConfig(cfg);
  const type = actionTypeOf(action);

  if (SAFE_ACTIONS.includes(type)) return 'safe';

  if (TYPE_ACTIONS.includes(type)) {
    const text = actionTextOf(action).toLowerCase();
    if (text.trim() === '') return 'risky';
    return DEVICE_SENSITIVE_WORDS.some((word) => text.includes(word)) ? 'risky' : 'safe';
  }

  if (OPEN_ACTIONS.includes(type)) {
    const pkg = actionPackageOf(action);
    if (!validateAppPackage(pkg)) return 'risky';
    // 白名单为空时别急着说 safe：黑名单是「绝不」，得先问它。
    if (config.blockedApps.includes(pkg)) return 'risky';
    if (config.apps.length === 0) return 'safe';
    return config.apps.includes(pkg) ? 'safe' : 'risky';
  }

  return 'risky';
}

// ── 黑名单 / 前台 ───────────────────────────────────────────────────────────
/**
 * 这个包在不在黑名单里。
 *
 * 只认**精确匹配**：Android 包名区分大小写，模糊匹配（前缀/包含）只会制造误判
 * （`com.tencent.mm` 与 `com.tencent.mm.plugin` 是两个包，后者不是微信本体）。
 * 空串 / 非字符串 / 未知包 → false，由调用方决定「放行」。
 */
export function isBlockedApp(pkg, cfg) {
  const config = normalizeDeviceConfig(cfg);
  const name = toText(pkg).trim();
  if (name === '') return false;
  return config.blockedApps.includes(name);
}

/** 黑名单里的中文名（未知包 / 用户追加项给空串）；话术里用它拼「微信（com.tencent.mm）」。 */
export function blockedAppLabel(pkg) {
  const name = toText(pkg).trim();
  return BLOCKED_APP_LABELS[name] ?? '';
}

// `dumpsys window` 里能读到前台的三个键，按可信度排序：先 mCurrentFocus，再兜底老系统的两个。
const FOREGROUND_KEYS = Object.freeze(['mCurrentFocus=', 'mFocusedApp=', 'mFocusedWindow=']);
// 包名/活动名：`com.tencent.mm/com.tencent.mm.ui.LauncherUI`、`com.foo/.Main`、`com.foo/.Bar$1`。
const FOCUS_PACKAGE_RE = /([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/([A-Za-z0-9_.$]+)/;
// 只有包名、没有活动名时的形状（用来在 token 里认「长得像包名的那一个」）。
const BARE_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** 从 `mCurrentFocus=` 后面那一行里抠包名：先按 `包名/活动名`，再按 token。 */
function packageFromFocusText(text) {
  const hay = typeof text === 'string' ? text : '';
  if (hay === '') return null;
  const withActivity = FOCUS_PACKAGE_RE.exec(hay);
  if (withActivity) return withActivity[1];
  for (const token of hay.split(/[\s{}]+/)) {
    if (BARE_PACKAGE_RE.test(token)) return token;
  }
  return null;
}

/**
 * 解析 `adb shell dumpsys window` 的 stdout → 前台包名（解析不出给 `null`，**永不抛**）。
 *
 * 取哪一行：`mCurrentFocus=` 优先（Android 8+ 都有，最准）；只有老系统才退到
 * `mFocusedApp=` / `mFocusedWindow=`。`mCurrentFocus=null` 表示「没有窗口有焦点」
 * （锁屏 / 熄屏 / 切屏那一瞬），这时**直接返回 null**，不再去猜 mFocusedApp ——
 * 那种时刻点下去本来就不该被解释成「在前台应用里点」。
 *
 * 一行长这样：`mCurrentFocus=Window{1a2b3c u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}`
 * 其中 window id（`1a2b3c`）、用户号（`u0`）都不是包名，所以先按 `包名/活动名` 抠，
 * 抠不到再按 token 找「长得像包名的那一个」（`u0` 没有点，天然不会命中）。
 *
 * 返回 null 时**工具层不拦动作**：看不见的东西不能当成罪证 —— 否则换一台解析不出
 * mCurrentFocus 的平板，整个功能一步都走不动。这条取舍写在 device-tools 的闸门注释里。
 */
export function parseForeground(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (text.trim() === '') return null;
  for (const key of FOREGROUND_KEYS) {
    const at = text.indexOf(key);
    if (at < 0) continue;
    const lineEnd = text.indexOf('\n', at);
    const segment = text.slice(at + key.length, lineEnd < 0 ? text.length : lineEnd).trim();
    if (segment === '') continue;
    if (/^null\b/i.test(segment)) return null;
    const pkg = packageFromFocusText(segment);
    if (pkg !== null) return pkg;
  }
  return null;
}

// ── 状态 ────────────────────────────────────────────────────────────────────
/**
 * 状态字段级兜底：`parseDeviceState` / `deviceBudget` / `recordStep` / `serializeDeviceState`
 * 共用同一份口径，避免「写进去一个值、读出来另一个值」。
 * 非对象 → 空状态（`day` 取 1970-01-01，于是任何真实日期都不等于它，计数自然是 0）。
 */
function normalizeDeviceState(raw) {
  const seed = { day: deviceDayKey(0), usedMs: 0, steps: 0, lastTs: 0, pausedUntil: 0, pausedReason: '' };
  if (!isPlainObject(raw)) return seed;
  return {
    day: typeof raw.day === 'string' && DAY_KEY_RE.test(raw.day) ? raw.day : seed.day,
    usedMs: toCount(raw.usedMs),
    steps: toCount(raw.steps),
    lastTs: toCount(raw.lastTs),
    pausedUntil: toCount(raw.pausedUntil),
    pausedReason: typeof raw.pausedReason === 'string' ? raw.pausedReason.slice(0, 40) : '',
  };
}

/** 空状态：`day` 是传入时刻的本地日键，计数 0、没有暂停。 */
export function createDeviceState(now) {
  return { day: deviceDayKey(now), usedMs: 0, steps: 0, lastTs: 0, pausedUntil: 0, pausedReason: '' };
}

/**
 * 读 `state/device-state.json` 的容错解析：接受对象或 JSON 字符串。
 * 坏 JSON / 不是对象 → `createDeviceState(0)`；单字段类型不对则逐字段兜底
 * （只坏一个字段不该让今天的计数清零 —— 那等于凭空多出 30 分钟额度）。
 */
export function parseDeviceState(raw) {
  if (isPlainObject(raw)) return normalizeDeviceState(raw);
  if (typeof raw !== 'string' || raw.trim() === '') return createDeviceState(0);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createDeviceState(0);
  }
  return isPlainObject(parsed) ? normalizeDeviceState(parsed) : createDeviceState(0);
}

/** 落盘用序列化：字段顺序固定（day / usedMs / steps / lastTs / pausedUntil / pausedReason）。 */
export function serializeDeviceState(state) {
  const deviceState = normalizeDeviceState(state);
  return JSON.stringify({
    day: deviceState.day,
    usedMs: deviceState.usedMs,
    steps: deviceState.steps,
    lastTs: deviceState.lastTs,
    pausedUntil: deviceState.pausedUntil,
    pausedReason: deviceState.pausedReason,
  });
}

// ── 预算 ────────────────────────────────────────────────────────────────────
/**
 * 今天还能不能玩（纯计算，不写任何状态）。判定顺序是**定死的**，因为拒绝理由决定
 * 用户下一步做什么：
 *   ① `enabled === false` → `disabled`（整个功能关着，等额度也没用）
 *   ② `state.pausedUntil > now` → `paused`（有人发消息 / 手动暂停；必须压过日额度，
 *      否则用户看到「今天满了」，以为明天就能好，实际还被人按着暂停）
 *   ③ 当日已用 ≥ `maxMinutesPerDay` → `daily_budget`
 *   ④ 当日步数 ≥ `maxStepsPerDay` → `step_budget`
 *   ⑤ `now - lastTs < minGapMs` → `cooldown`（`nextAllowedAt = lastTs + minGapMs`）
 *   ⑥ 否则 `ok`
 *
 * 时间戳在未来的 `lastTs`（时钟回拨 / 手工改文件）会让 ⑤ 的差值为负，照样判 `cooldown`
 * —— 把系统时间往前拨一次，不能换来一次白点。
 *
 * 除约定的 7 个键外还带 `maxMinutesPerDay` / `maxStepsPerDay` / `minGapMs`：
 * `budgetReasonText(reason, budget)` 只有 budget 一个入参，需要这些值才能拼出
 * 「30 分钟用完了」「还有 12 步」这类话。
 */
export function deviceBudget(state, cfg, now) {
  const config = normalizeDeviceConfig(cfg);
  const deviceState = normalizeDeviceState(state);
  const at = toTimestamp(now, 0);
  const today = deviceDayKey(at);
  const sameDay = deviceState.day === today;
  // 跨日 = 今天的计数从 0 开始；这是「按自然日重置」的唯一来源。
  const usedMs = sameDay ? deviceState.usedMs : 0;
  const usedSteps = sameDay ? deviceState.steps : 0;
  const maxMs = config.maxMinutesPerDay * MINUTE_MS;
  const leftMs = Math.max(0, maxMs - usedMs);
  const leftSteps = Math.max(0, config.maxStepsPerDay - usedSteps);
  const make = (ok, reason, nextAllowedAt = 0) => ({
    ok,
    reason,
    usedMs,
    usedSteps,
    leftMs,
    leftSteps,
    nextAllowedAt,
    maxMinutesPerDay: config.maxMinutesPerDay,
    maxStepsPerDay: config.maxStepsPerDay,
    minGapMs: config.minGapMs,
  });

  if (!config.enabled) return make(false, 'disabled');
  if (deviceState.pausedUntil > at) return make(false, 'paused', deviceState.pausedUntil);
  if (usedMs >= maxMs) return make(false, 'daily_budget', nextLocalMidnight(at));
  if (usedSteps >= config.maxStepsPerDay) return make(false, 'step_budget', nextLocalMidnight(at));
  if (at - deviceState.lastTs < config.minGapMs) {
    return make(false, 'cooldown', deviceState.lastTs + config.minGapMs);
  }
  return make(true, 'ok');
}

/**
 * 记一步，返回**新对象**（不改入参，调用方写盘前可以安全地先算后写）。
 *
 * - 步数 +1；同日累加，跨日重置为 1；
 * - 时长按「与上一步的时间差」累加，单步最多计 10 分钟（`STEP_MAX_MS`）：
 *   隔夜之后的第一下不该把 8 小时算成今天的用量；
 * - `lastTs` 记这次的时刻；暂停标记原样带过去（`pausedUntil` 是绝对时间戳，
 *   是否仍生效由 `deviceBudget` 用 `> now` 判断）。
 *
 * `action` 只用于调用方留痕（工具层会把它写进 `state/device-actions.jsonl`）：
 * 状态结构按约定固定为 6 个键，动作类型不落盘。参数保留是为了以后按动作类型分开统计
 * （截图 vs 点击）时不用改签名。
 *
 * `now` 非法时退回 `state.lastTs`：宁可记成「刚刚」，也不要写一个 NaN 进状态文件。
 */
export function recordStep(state, now, action) {
  const previous = normalizeDeviceState(state);
  const at = toTimestamp(now, previous.lastTs);
  const today = deviceDayKey(at);
  const sameDay = previous.day === today;
  const baseMs = sameDay ? previous.usedMs : 0;
  const baseSteps = sameDay ? previous.steps : 0;
  const gap = sameDay && previous.lastTs > 0 ? at - previous.lastTs : 0;
  const delta = gap > 0 ? Math.min(gap, STEP_MAX_MS) : 0;
  void action; // 见上方注释：动作类型只进日志，不进状态
  return {
    day: today,
    usedMs: baseMs + delta,
    steps: baseSteps + 1,
    lastTs: at,
    pausedUntil: previous.pausedUntil,
    pausedReason: previous.pausedReason,
  };
}

/**
 * 暂停到「现在 + `pauseAfterRunMs`」：一轮玩完、或有人发消息要优先回聊天时由调用方落盘。
 * 返回新状态（不改入参）；`reason` 只是给人看的短标记（`conversation` / `round_end` / …）。
 */
export function pauseDevice(state, cfg, now, reason = 'manual') {
  const config = normalizeDeviceConfig(cfg);
  const previous = normalizeDeviceState(state);
  const at = toTimestamp(now, previous.lastTs);
  const until = Math.min(MAX_DATE_MS, at + config.pauseAfterRunMs);
  const label = toText(reason).trim().slice(0, 40) || 'manual';
  return { ...previous, pausedUntil: until, pausedReason: label };
}

// ── 话术 ────────────────────────────────────────────────────────────────────
/** adb 错误码 → 中文可读原因（工具层原样回给模型，模型据此跟用户解释）。 */
const ADB_ERROR_TEXTS = Object.freeze({
  no_device: '没找到平板：检查 USB 线、开发者选项里的「USB 调试」，插好后在平板上点一次「允许」',
  unauthorized: '平板还没授权这台电脑：在平板上点「允许 USB 调试」（可勾「始终允许」）',
  offline: '平板离线了：拔插一次 USB 再试',
  timeout: 'adb 没响应（超时）：可能线松了，或平板正在充电保护状态',
  unknown: 'adb 出错了：把平板重新插一次；还不行就看 `adb devices` 的实际输出',
});

/**
 * stderr 文本 → 规范化错误码 + 中文原因。
 *
 * 也接受**裸错误码**（`no_device` / `unauthorized` / `offline` / `timeout`）：工具层在
 * 「根本没抓到 stderr」的场合（`adb devices` 成功但列表为空、pickDevice 判多设备之外的
 * 失败）手里只有一个码，不该再被降级成 `unknown` —— 那样用户会看到「adb 出错了」，
 * 而不是「没找到平板」。裸码判定放在正则之前，且要求**整串完全相等**，
 * 免得一句含 `offline` 的通用日志被误认。
 *
 * 顺序即优先级：先判最具体的授权/离线/找不到设备，最后才看超时（`timeout` 这个词在
 * adb 的无关日志里也会出现，放最后不会误伤前三种）。空 stderr → `unknown`。
 */
const ADB_ERROR_PATTERNS = Object.freeze([
  ['unauthorized', /unauthorized|未授权|authoriz/i],
  ['offline', /offline|离线/i],
  ['no_device', /no devices|no emulators|device '?[^']*'? not found|not found|没有找到|more than one device|no permissions|insufficient permissions/i],
  ['timeout', /timed? ?out|timeout|超时|deadline/i],
]);

export function describeAdbError(stderr) {
  const text = toText(stderr);
  const bareCode = text.trim().toLowerCase();
  if (Object.hasOwn(ADB_ERROR_TEXTS, bareCode)) return { code: bareCode, reason: ADB_ERROR_TEXTS[bareCode] };
  for (const [code, pattern] of ADB_ERROR_PATTERNS) {
    if (pattern.test(text)) return { code, reason: ADB_ERROR_TEXTS[code] };
  }
  return { code: 'unknown', reason: ADB_ERROR_TEXTS.unknown };
}

/**
 * 预算原因 → 中文一句话（MCP 层直接回给模型，模型据此跟用户解释）。
 *
 * 数字一律从 `info`（就是 `deviceBudget` 的返回值）里取；`info` 缺省时退回默认值，
 * 保证任何时候都能说出一句完整的话，而不是「操作失败」。
 */
export function budgetReasonText(reason, info) {
  const data = isPlainObject(info) ? info : {};
  const maxMinutes = toCount(data.maxMinutesPerDay) || DEVICE_DEFAULTS.maxMinutesPerDay;
  const maxSteps = toCount(data.maxStepsPerDay) || DEVICE_DEFAULTS.maxStepsPerDay;
  switch (reason) {
    case 'ok':
      return '现在可以玩';
    case 'disabled':
      return '平板功能关着（config.json 的 device.enabled 是 false）';
    case 'paused': {
      const until = formatClock(data.nextAllowedAt);
      return until === '' ? '这一轮被暂停了，先等一会儿' : `这一轮被暂停了，${until} 之后再试`;
    }
    case 'daily_budget':
      return `今天的 ${maxMinutes} 分钟用完了，明天 0 点再来`;
    case 'step_budget':
      return `今天的 ${maxSteps} 步用完了，明天 0 点再来`;
    case 'cooldown': {
      // 只说「等多久」的上限（minGapMs），不拿 nextAllowedAt 减系统时钟：
      // 本模块不读时钟，话术也必须是纯的，否则单测会随运行时刻漂。
      const gap = toCount(data.minGapMs) || DEVICE_DEFAULTS.minGapMs;
      const seconds = Math.max(1, Math.ceil(gap / 1000));
      return `刚做完一步，等 ${seconds} 秒再动`;
    }
    default:
      return '现在不能操作平板';
  }
}

/**
 * 前台命中黑名单 → 一句话（工具层原样回给模型）。
 *
 * 除了说「拒」，还要说**接下来该等**：模型收到 `blocked_foreground` 之后最容易犯的错是
 * 换个坐标再点一次 —— 那只会继续撞同一道墙。所以文案要明确「等这一屏被切走」。
 * 同时点名唯一的例外：`device_key home`（2026-10-21 指挥官决策的逃生口）—— 只回桌面，
 * 不碰黑名单应用里的任何东西；没有这个口子，模型会卡在这一屏上一步也走不动。
 */
export function blockedForegroundText(pkg) {
  const name = toText(pkg).trim();
  const label = blockedAppLabel(name);
  const shown = label === '' ? name : `${label}（${name}）`;
  return `平板现在停在${shown}这一屏：支付、聊天、应用商店、系统设置这类界面我不碰，`
    + '点击、滑动、打字、按键、开应用都会被拒（唯一例外是 `device_key home`：只回桌面，'
    + '不碰这个应用里的任何东西）。等这一屏被切走再继续。';
}

/** 想 open_app 一个黑名单包 → 一句话（说清是「黑名单」而不是「白名单外」，两者下一步动作不同）。 */
export function blockedOpenText(pkg) {
  const name = toText(pkg).trim();
  const label = blockedAppLabel(name);
  const shown = label === '' ? name : `${label}（${name}）`;
  return `${shown}在黑名单里，永远不由我打开（黑名单是内置的，改配置也删不掉）。`;
}

/**
 * 提示词块：桥接把它拼进系统提示，模型才知道「我现在有手有眼、还能玩多久」。
 *
 * - 功能关着 → `{enabled:false}`（桥接据此整段不注入）；
 * - 否则给 `apps` 白名单（空数组 = 不限制包名）、`blocked` 黑名单（内核永远在里面）、
 *   当日剩余额度、一句行为约束。`leftMinutes` 用 **ceil**（还能玩 29 分 10 秒 → 说 30 分钟，
 *   乐观但不撒谎），`leftSteps` 精确到步。
 */
export function devicePromptBlock(cfg, state, now) {
  const config = normalizeDeviceConfig(cfg);
  if (!config.enabled) return { enabled: false };

  const budget = deviceBudget(state, config, now);
  const leftMinutes = Math.ceil(budget.leftMs / MINUTE_MS);
  const hint = budget.ok
    ? `想玩平板就自己玩一会儿：一次只做一步，做完先截图看效果。只玩不越界（不改系统设置、不装/卸应用、`
      + `不支付、不登录、不删东西）；中文打不了字，用点击代替打字。`
      + '支付宝、微信、QQ、Play 商店、系统设置这类界面一出现，任何动作都会被拒（等它被切走再继续）；'
      + '万一自己撞进去了，唯一能自救的动作是 device_key home（只回桌面，不碰里面的东西；back 不行）。'
      + `今天还剩 ${leftMinutes} 分钟 / ${budget.leftSteps} 步。`
    : `现在不能玩平板：${budgetReasonText(budget.reason, budget)}`;
  return {
    enabled: true,
    apps: [...config.apps],
    blocked: [...config.blockedApps],
    budget: { leftMinutes, leftSteps: budget.leftSteps },
    hint,
  };
}

// ── adb 执行器 ──────────────────────────────────────────────────────────────
/**
 * 跑一次 adb，返回 `{ ok, code, stdout, stderr, stdoutBuffer }`，**永不抛**。
 *
 * - `execFile(adbPath, argv)` 直接传数组，不经过 shell：坐标、包名、文本都不会被
 *   cmd.exe 当成语法解释（这是坐标里出现 `&`/`|` 也不出事的原因）。
 * - `encoding: 'buffer'` 是关键：`screencap -p` 的 PNG 是二进制，按 UTF-8 解一次就废了。
 *   `stdoutBuffer` 给截图路径用，`stdout` 是同一份字节的 utf8 视图（文本命令用）。
 * - 超时 / 起不来 / 非 0 退出码都收敛成 `ok:false` + 中文 stderr，由 `describeAdbError`
 *   翻译成原因。`code` 不是数字（如 spawn 的 `ENOENT`）时记 -1。
 * - 不吞输出：stderr 原样带给上层，日志与排查都靠它。
 */
export function defaultRunAdb(args, options = {}) {
  const adbPath = toAdbPath(options.adbPath);
  const timeoutRaw = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.trunc(timeoutRaw)
    : DEFAULT_ADB_TIMEOUT_MS;
  const argv = Array.isArray(args) ? args.map((item) => String(item)) : [];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      execFile(
        adbPath,
        argv,
        { timeout: timeoutMs, maxBuffer: MAX_STDOUT_BYTES, windowsHide: true, encoding: 'buffer' },
        (error, stdout, stderr) => {
          const outBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
          const errBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? ''), 'utf8');
          const errText = errBuffer.toString('utf8');
          if (error) {
            const codeRaw = Number(error.code);
            const killed = Boolean(error.killed) || error.signal === 'SIGTERM';
            const message = String(error.message ?? error);
            const timedOut = killed || /timed? ?out/i.test(message);
            const reason = errText.trim() !== ''
              ? errText
              : (timedOut ? `adb 超时（${timeoutMs}ms）` : message);
            finish({
              ok: false,
              code: Number.isFinite(codeRaw) ? Math.trunc(codeRaw) : -1,
              stdout: outBuffer.toString('utf8'),
              stderr: reason,
              stdoutBuffer: outBuffer,
            });
            return;
          }
          finish({
            ok: true,
            code: 0,
            stdout: outBuffer.toString('utf8'),
            stderr: errText,
            stdoutBuffer: outBuffer,
          });
        },
      );
    } catch (error) {
      // execFile 对非法参数会同步抛（例如 adbPath 不是字符串形态的路径）。
      finish({
        ok: false,
        code: -1,
        stdout: '',
        stderr: `起不来 adb（${adbPath}）：${String(error?.message ?? error)}`,
        stdoutBuffer: Buffer.alloc(0),
      });
    }
  });
}
