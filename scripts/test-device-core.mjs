// src/device-core.js 的单测：零依赖 ESM，不碰 adb、不碰网络、不写文件。
//
// 覆盖（对应任务要求的「≥90 条断言」）：
// 配置钳制 / adb devices 解析（多设备、unauthorized、offline、噪声行） / 设备选择 /
// 坐标夹取 / 包名校验 / risky 分类 / **黑名单（内核不可移除、并入、优先级）** /
// **dumpsys window 前台包名解析** / 预算边界（第 60 步放行、第 61 步拦、30 分钟、
// 跨日重置、暂停、冷却） / 状态序列化 / adb 错误文案 / 提示词块。
//
// 跑法：node scripts/test-device-core.mjs
import {
  DEVICE_DEFAULTS,
  DEVICE_KERNEL_BLOCKED_APPS,
  DEVICE_KEYCODES,
  DEVICE_LIMITS,
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
  deviceDayKey,
  devicePromptBlock,
  isBlockedApp,
  normalizeDeviceConfig,
  parseDevices,
  parseDeviceState,
  parseForeground,
  pauseDevice,
  pickDevice,
  recordStep,
  serializeDeviceState,
  validateAppPackage,
} from '../src/device-core.js';

// ── 测试脚手架 ──────────────────────────────────────────────────────────────
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

/** 深比较：键顺序无关（递归排序后比 JSON）。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function equal(name, actual, expected) {
  const a = JSON.stringify(stable(actual));
  const b = JSON.stringify(stable(expected));
  check(name, a === b, `期望 ${b} 实际 ${a}`);
}

/** 本地时间 → 时间戳（测试里的「今天 / 昨天」必须按本机时区构造，不能用 UTC）。 */
function localMs(year, month, day, hour = 12, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

const MIN = 60 * 1000;
const TODAY = localMs(2026, 3, 15, 14, 30);
const YESTERDAY_KEY = deviceDayKey(localMs(2026, 3, 14, 23, 59));
const TODAY_KEY = deviceDayKey(TODAY);

// ── 1. 默认值与边界 ─────────────────────────────────────────────────────────
check('默认开启', DEVICE_DEFAULTS.enabled === true);
check('默认 adb 是本机绝对路径', DEVICE_DEFAULTS.adbPath.endsWith('platform-tools\\adb.exe'), DEVICE_DEFAULTS.adbPath);
check('默认 adb 路径带用户名目录', DEVICE_DEFAULTS.adbPath.includes('AppData\\Local\\Android'), DEVICE_DEFAULTS.adbPath);
check('默认每日 30 分钟', DEVICE_DEFAULTS.maxMinutesPerDay === 30);
check('默认每日 60 步', DEVICE_DEFAULTS.maxStepsPerDay === 60);
check('默认步间隔 1000ms', DEVICE_DEFAULTS.minGapMs === 1000);
check('默认轮间冷却 1 小时', DEVICE_DEFAULTS.pauseAfterRunMs === 60 * MIN);
check('默认不限制包名', Array.isArray(DEVICE_DEFAULTS.apps) && DEVICE_DEFAULTS.apps.length === 0);
check('默认黑名单恰好是内核五项', JSON.stringify(DEVICE_DEFAULTS.blockedApps) === JSON.stringify([...DEVICE_KERNEL_BLOCKED_APPS]));
check('内核黑名单被冻结、正好五项', Object.isFrozen(DEVICE_KERNEL_BLOCKED_APPS) === true && DEVICE_KERNEL_BLOCKED_APPS.length === 5);
check('内核含支付宝', DEVICE_KERNEL_BLOCKED_APPS.includes('com.eg.android.AlipayGphone'));
check('内核含微信', DEVICE_KERNEL_BLOCKED_APPS.includes('com.tencent.mm'));
check('内核含 QQ', DEVICE_KERNEL_BLOCKED_APPS.includes('com.tencent.mobileqq'));
check('内核含 Play 商店', DEVICE_KERNEL_BLOCKED_APPS.includes('com.android.vending'));
check('内核含系统设置', DEVICE_KERNEL_BLOCKED_APPS.includes('com.android.settings'));
check('内核五项都是合法包名', DEVICE_KERNEL_BLOCKED_APPS.every((pkg) => validateAppPackage(pkg)));
check('默认值被冻结', Object.isFrozen(DEVICE_DEFAULTS) === true);
check('分钟上限区间 5–120', JSON.stringify(DEVICE_LIMITS.maxMinutesPerDay) === '[5,120]');
check('步数上限区间 5–300', JSON.stringify(DEVICE_LIMITS.maxStepsPerDay) === '[5,300]');
check('冷却区间下限 0', DEVICE_LIMITS.minGapMs[0] === 0 && DEVICE_LIMITS.minGapMs[1] === MIN);
check('轮间冷却区间 10 分钟–6 小时', DEVICE_LIMITS.pauseAfterRunMs[0] === 10 * MIN && DEVICE_LIMITS.pauseAfterRunMs[1] === 6 * 60 * MIN);
check('只给 back/home 两个键', Object.keys(DEVICE_KEYCODES).sort().join(',') === 'back,home');

// ── 2. normalizeDeviceConfig ───────────────────────────────────────────────
{
  const defaults = normalizeDeviceConfig(undefined);
  check('空配置 → 全默认', defaults.maxMinutesPerDay === 30 && defaults.maxStepsPerDay === 60 && defaults.enabled === true);
  check('归一化结果被冻结', Object.isFrozen(defaults) === true);
  check('空白名单也是冻结数组', Object.isFrozen(defaults.apps) === true);

  const str = normalizeDeviceConfig('这不是对象');
  check('非对象配置不抛错 → 默认', str.maxMinutesPerDay === 30 && str.adbPath === DEVICE_DEFAULTS.adbPath);

  const zero = normalizeDeviceConfig({ maxMinutesPerDay: 0 });
  check('0 分钟抬到下限 5', zero.maxMinutesPerDay === 5);

  const huge = normalizeDeviceConfig({ maxMinutesPerDay: 9999, maxStepsPerDay: 9999 });
  check('9999 分钟压到上限 120', huge.maxMinutesPerDay === 120);
  check('9999 步压到上限 300', huge.maxStepsPerDay === 300);

  const numericString = normalizeDeviceConfig({ maxMinutesPerDay: '45', maxStepsPerDay: '20' });
  check('数字字符串可用', numericString.maxMinutesPerDay === 45 && numericString.maxStepsPerDay === 20);

  const boolValue = normalizeDeviceConfig({ maxMinutesPerDay: true });
  check('布尔不当数字 → 默认 30', boolValue.maxMinutesPerDay === 30);

  const floatValue = normalizeDeviceConfig({ maxMinutesPerDay: 12.9 });
  check('小数被截断', floatValue.maxMinutesPerDay === 12);

  const gap = normalizeDeviceConfig({ minGapMs: 0 });
  check('0 间隔允许（下限就是 0）', gap.minGapMs === 0);
  const gapHuge = normalizeDeviceConfig({ minGapMs: 999999 });
  check('间隔压到 60 秒', gapHuge.minGapMs === MIN);

  const pause = normalizeDeviceConfig({ pauseAfterRunMs: 1000 });
  check('冷却抬到下限 10 分钟', pause.pauseAfterRunMs === 10 * MIN);
  const pauseHuge = normalizeDeviceConfig({ pauseAfterRunMs: 1e9 });
  check('冷却压到上限 6 小时', pauseHuge.pauseAfterRunMs === 6 * 60 * MIN);

  const disabled = normalizeDeviceConfig({ enabled: false });
  check('enabled=false 生效', disabled.enabled === false);
  const notBool = normalizeDeviceConfig({ enabled: 'false' });
  check('字符串 "false" 不算关闭', notBool.enabled === true);

  const emptyPath = normalizeDeviceConfig({ adbPath: '   ' });
  check('空 adb 路径回落默认', emptyPath.adbPath === DEVICE_DEFAULTS.adbPath);
  const customPath = normalizeDeviceConfig({ adbPath: '  D:\\tools\\adb.exe  ' });
  check('自定义 adb 路径去空白', customPath.adbPath === 'D:\\tools\\adb.exe');

  const apps = normalizeDeviceConfig({ apps: ['com.a.b', '  com.c.d  ', 'bad', '1com.x', '', 'com.a.b'] });
  expectApps(apps.apps);
  const notArray = normalizeDeviceConfig({ apps: 'com.a.b' });
  check('非数组白名单 → 空', notArray.apps.length === 0);

  // 黑名单：内核不可移除，用户只能追加。
  const blockedDefaults = normalizeDeviceConfig({});
  check('不给配置也带黑名单五项', blockedDefaults.blockedApps.length === 5, blockedDefaults.blockedApps);
  check('黑名单是冻结数组', Object.isFrozen(blockedDefaults.blockedApps) === true);

  const emptyBlocked = normalizeDeviceConfig({ blockedApps: [] });
  check('用户写 [] 也移不掉内核', emptyBlocked.blockedApps.length === 5 && emptyBlocked.blockedApps.includes('com.tencent.mm'));

  const subsetBlocked = normalizeDeviceConfig({ blockedApps: ['com.tencent.mm'] });
  check('只写内核里的一个 → 仍是完整五项', subsetBlocked.blockedApps.length === 5);

  const extraBlocked = normalizeDeviceConfig({ blockedApps: ['  com.extra.app  ', 'com.extra.app', '', 42, null] });
  check('追加项 trim + 去重 + 忽略脏值', extraBlocked.blockedApps.length === 6 && extraBlocked.blockedApps[5] === 'com.extra.app', extraBlocked.blockedApps);
  check('内核排在追加项前面', extraBlocked.blockedApps[0] === 'com.eg.android.AlipayGphone');

  const notArrayBlocked = normalizeDeviceConfig({ blockedApps: 'com.tencent.mm' });
  check('非数组黑名单 → 只剩内核', notArrayBlocked.blockedApps.length === 5);

  const manyBlocked = normalizeDeviceConfig({ blockedApps: Array.from({ length: 120 }, (_, i) => `com.junk.app${i}`) });
  check('黑名单上限 50 条', manyBlocked.blockedApps.length === 50, manyBlocked.blockedApps.length);

  const conflict = normalizeDeviceConfig({ apps: ['com.tencent.mm', 'com.a.b'], blockedApps: ['com.a.b'] });
  check('黑名单从白名单里剔除（黑名单优先）', JSON.stringify(conflict.apps) === '[]', conflict.apps);
  const keepApps = normalizeDeviceConfig({ apps: ['com.a.b', 'com.c.d'] });
  check('没有冲突时白名单原样保留', JSON.stringify(keepApps.apps) === '["com.a.b","com.c.d"]');
}

function expectApps(list) {
  check('白名单去重 + 过滤非法包名', list.length === 2 && list[0] === 'com.a.b' && list[1] === 'com.c.d', list);
}

// ── 3. parseDevices ────────────────────────────────────────────────────────
{
  equal('空输出 → 空表', parseDevices(''), []);
  equal('只有表头 → 空表', parseDevices('List of devices attached\n'), []);
  equal('非字符串 → 空表', parseDevices(null), []);

  const one = parseDevices('List of devices attached\nR5CT30ABCDE\tdevice\n');
  equal('单设备解析', one, [{ serial: 'R5CT30ABCDE', state: 'device' }]);

  const withModel = parseDevices(
    'List of devices attached\nR5CT30ABCDE          device usb:1-1 product:TB370FU model:TB370FU device:TB370FU transport_id:3\n',
  );
  check('解析 model 字段', withModel.length === 1 && withModel[0].model === 'TB370FU', withModel);
  check('解析出的 state 仍是 device', withModel[0].state === 'device');

  const underscore = parseDevices('List of devices attached\nabc\tdevice model:Lenovo_Pad_Pro\n');
  check('model 里的下划线还原成空格', underscore[0].model === 'Lenovo Pad Pro', underscore[0].model);

  equal(
    '未授权设备',
    parseDevices('List of devices attached\nR5CT30ABCDE\tunauthorized\n'),
    [{ serial: 'R5CT30ABCDE', state: 'unauthorized' }],
  );
  equal(
    '离线设备',
    parseDevices('List of devices attached\nR5CT30ABCDE\toffline\n'),
    [{ serial: 'R5CT30ABCDE', state: 'offline' }],
  );

  const multi = parseDevices('List of devices attached\nAAA\tdevice\nBBB\tdevice\n');
  check('两台设备都解析出来', multi.length === 2 && multi[1].serial === 'BBB');

  const daemon = parseDevices('* daemon not running; starting now at tcp:5037\nList of devices attached\nAAA\tdevice\n');
  check('跳过 daemon 启动提示', daemon.length === 1 && daemon[0].serial === 'AAA', daemon);

  const server = parseDevices("adb server version (41) doesn't match this client (37); killing...\nList of devices attached\nAAA\tdevice\n");
  check('跳过 adb server 版本提示', server.length === 1 && server[0].serial === 'AAA', server);

  const noPerm = parseDevices('List of devices attached\nAAA\tno permissions (user in plugdev group)\n');
  check('no permissions 单独识别', noPerm[0].state === 'no_permissions', noPerm[0]);

  const crlf = parseDevices('List of devices attached\r\nAAA\tdevice\r\n');
  check('CRLF 也能解析', crlf.length === 1 && crlf[0].state === 'device');

  const single = parseDevices('List of devices attached\nAAA\n');
  check('只有序列号没有状态 → 跳过', single.length === 0);
}

// ── 4. pickDevice ──────────────────────────────────────────────────────────
{
  const single = pickDevice([{ serial: 'AAA', state: 'device' }]);
  check('单设备选中', single.ok === true && single.serial === 'AAA' && single.reason === 'ok');
  check('单设备回带 device 对象', single.device.serial === 'AAA');

  const empty = pickDevice([]);
  check('没有设备 → no_device', empty.ok === false && empty.reason === 'no_device');
  check('没有设备也回带 serials', Array.isArray(empty.serials) && empty.serials.length === 0);

  const more = pickDevice([{ serial: 'AAA', state: 'device' }, { serial: 'BBB', state: 'device' }]);
  check('多设备 → multiple_devices', more.ok === false && more.reason === 'multiple_devices');
  check('多设备列出 serials', JSON.stringify(more.serials) === '["AAA","BBB"]');

  const un = pickDevice([{ serial: 'AAA', state: 'unauthorized' }]);
  check('未授权 → unauthorized', un.ok === false && un.reason === 'unauthorized');

  const off = pickDevice([{ serial: 'AAA', state: 'offline' }]);
  check('离线 → offline', off.ok === false && off.reason === 'offline');

  const mixed = pickDevice([{ serial: 'AAA', state: 'device' }, { serial: 'BBB', state: 'unauthorized' }]);
  check('一台可用一台未授权 → 用可用的那台', mixed.ok === true && mixed.serial === 'AAA');

  const junk = pickDevice([null, 'AAA', { state: 'device' }, { serial: '   ', state: 'device' }]);
  check('脏条目被过滤 → no_device', junk.ok === false && junk.reason === 'no_device');

  check('非数组 → no_device', pickDevice(undefined).reason === 'no_device');
  check('其它状态（bootloader）→ no_device', pickDevice([{ serial: 'AAA', state: 'bootloader' }]).reason === 'no_device');
}

// ── 5. clampPoint / clampSwipe ─────────────────────────────────────────────
{
  equal('坐标在屏幕内原样返回', clampPoint(100, 200, 1280, 800), { x: 100, y: 200 });
  equal('负坐标夹到 0', clampPoint(-50, -1, 1280, 800), { x: 0, y: 0 });
  equal('超出宽高夹到边界', clampPoint(9999, 9999, 1280, 800), { x: 1279, y: 799 });
  equal('小数被截断', clampPoint(10.9, 20.2, 1280, 800), { x: 10, y: 20 });
  equal('数字字符串也能用', clampPoint('300', '400', 1280, 800), { x: 300, y: 400 });
  equal('屏幕正好一个点', clampPoint(5, 5, 1, 1), { x: 0, y: 0 });
  check('x 是 NaN → null', clampPoint(Number.NaN, 10, 1280, 800) === null);
  check('x 是 null → null', clampPoint(null, 10, 1280, 800) === null);
  check('x 是空串 → null', clampPoint('', 10, 1280, 800) === null);
  check('x 是中文 → null', clampPoint('中间', 10, 1280, 800) === null);
  check('宽为 0 → null', clampPoint(1, 1, 0, 800) === null);
  check('高为负数 → null', clampPoint(1, 1, 1280, -5) === null);
  check('宽高缺失 → null', clampPoint(1, 1) === null);

  equal('滑动两端各自夹取', clampSwipe(-10, -10, 5000, 5000, 1280, 800), { x1: 0, y1: 0, x2: 1279, y2: 799 });
  equal('滑动正常值不变', clampSwipe(100, 700, 100, 100, 1280, 800), { x1: 100, y1: 700, x2: 100, y2: 100 });
  check('滑动含 NaN → null', clampSwipe(1, 2, 3, Number.NaN, 1280, 800) === null);
  check('滑动含空 → null', clampSwipe(1, 2, undefined, 4, 1280, 800) === null);
}

// ── 6. validateAppPackage ──────────────────────────────────────────────────
{
  check('标准包名合法', validateAppPackage('com.tencent.tmgp.sgame') === true);
  check('两段包名合法', validateAppPackage('a.b') === true);
  check('含下划线段合法', validateAppPackage('com.tencent.tmgp_sgame') === true);
  check('单段不合法', validateAppPackage('com') === false);
  check('数字开头不合法', validateAppPackage('1com.a') === false);
  check('结尾点不合法', validateAppPackage('com.a.') === false);
  check('空串不合法', validateAppPackage('') === false);
  check('非字符串不合法', validateAppPackage(123) === false);
  check('首尾空白不合法（工具层负责 trim）', validateAppPackage(' com.a.b') === false);
  check('点开头不合法', validateAppPackage('.a.b') === false);
  check('连续点不合法', validateAppPackage('com..b') === false);
  check('带斜杠不合法', validateAppPackage('com/a.b') === false);
  check('超长包名不合法', validateAppPackage(`com.${'a'.repeat(200)}`) === false);
  check('含中文不合法', validateAppPackage('com.微信.foo') === false);
}

// ── 7. classifyAction ─────────────────────────────────────────────────────
{
  const empty = normalizeDeviceConfig({ apps: [] });
  const listed = normalizeDeviceConfig({ apps: ['com.a.game'] });

  check('tap 恒 safe', classifyAction({ type: 'tap', x: 1, y: 2 }, empty) === 'safe');
  check('swipe 恒 safe', classifyAction({ type: 'swipe' }, empty) === 'safe');
  check('back 恒 safe', classifyAction({ type: 'back' }, empty) === 'safe');
  check('home 恒 safe', classifyAction({ type: 'home' }, empty) === 'safe');
  check('screenshot 恒 safe', classifyAction({ type: 'screenshot' }, empty) === 'safe');
  check('字符串动作名也认', classifyAction('tap', empty) === 'safe');

  check('普通 ASCII 文本 safe', classifyAction({ type: 'type', text: 'hello world' }, empty) === 'safe');
  check('文本里的空格不影响判定', classifyAction({ type: 'type', text: ' level 3 ' }, empty) === 'safe');
  check('中文密码 risky', classifyAction({ type: 'type', text: '我的密码' }, empty) === 'risky');
  check('英文 password risky', classifyAction({ type: 'type', text: 'password123' }, empty) === 'risky');
  check('登录 risky', classifyAction({ type: 'type', text: '登录账号' }, empty) === 'risky');
  check('转账 risky', classifyAction({ type: 'type', text: '转账 100' }, empty) === 'risky');
  check('验证码 risky', classifyAction({ type: 'type', text: '验证码' }, empty) === 'risky');
  check('购买 risky', classifyAction({ type: 'type', text: '购买皮肤' }, empty) === 'risky');
  check('下单 risky', classifyAction({ type: 'type', text: '下单' }, empty) === 'risky');
  check('删除 risky', classifyAction({ type: 'type', text: '删除这个' }, empty) === 'risky');
  check('卸载 risky', classifyAction({ type: 'type', text: '卸载' }, empty) === 'risky');
  check('安装 risky', classifyAction({ type: 'type', text: '安装应用' }, empty) === 'risky');
  check('大小写不敏感（LOGIN）', classifyAction({ type: 'type', text: 'LOGIN NOW' }, empty) === 'risky');
  check('空文本 risky', classifyAction({ type: 'type', text: '' }, empty) === 'risky');
  check('没给文本 risky', classifyAction({ type: 'type' }, empty) === 'risky');
  check('文本从 message 字段取', classifyAction({ type: 'type', message: '密码' }, empty) === 'risky');

  check('空白名单 → 合法包名 safe', classifyAction({ type: 'open_app', package: 'com.any.game' }, empty) === 'safe');
  check('空白名单 → 非法包名 risky', classifyAction({ type: 'open_app', package: 'bad name' }, empty) === 'risky');
  check('空白名单 → 没给包名 risky', classifyAction({ type: 'open_app' }, empty) === 'risky');
  check('白名单内 safe', classifyAction({ type: 'open_app', package: 'com.a.game' }, listed) === 'safe');
  check('白名单外 risky', classifyAction({ type: 'open_app', package: 'com.other.app' }, listed) === 'risky');
  check('白名单外即使格式合法也 risky', classifyAction({ type: 'open_app', package: 'com.wechat.app' }, listed) === 'risky');

  // 黑名单优先于白名单：同一个包两边都写了，必须判 risky。
  const blockedListed = normalizeDeviceConfig({ apps: ['com.tencent.mm'] });
  check('黑名单项即使写进白名单也 risky', classifyAction({ type: 'open_app', package: 'com.tencent.mm' }, blockedListed) === 'risky');
  check('空白名单也拦微信', classifyAction({ type: 'open_app', package: 'com.tencent.mm' }, empty) === 'risky');
  check('空白名单也拦支付宝', classifyAction({ type: 'open_app', package: 'com.eg.android.AlipayGphone' }, empty) === 'risky');
  check('空白名单也拦 Play 商店', classifyAction({ type: 'open_app', package: 'com.android.vending' }, empty) === 'risky');
  check('黑名单外的包不受影响（空白名单 → safe）', classifyAction({ type: 'open_app', package: 'com.example.game' }, empty) === 'safe');

  check('未知动作按 risky', classifyAction({ type: 'factory_reset' }, empty) === 'risky');
  check('空对象 risky', classifyAction({}, empty) === 'risky');
  check('null risky', classifyAction(null, empty) === 'risky');
  check('未知字符串 risky', classifyAction('whatever', empty) === 'risky');
}

// ── 7.5 黑名单判定 / 前台解析（T-023 收尾） ─────────────────────────────────
{
  const cfg = normalizeDeviceConfig({});
  check('isBlockedApp 认微信', isBlockedApp('com.tencent.mm', cfg) === true);
  check('isBlockedApp 认支付宝', isBlockedApp('com.eg.android.AlipayGphone', cfg) === true);
  check('isBlockedApp 认 QQ', isBlockedApp('com.tencent.mobileqq', cfg) === true);
  check('isBlockedApp 认 Play 商店', isBlockedApp('com.android.vending', cfg) === true);
  check('isBlockedApp 认系统设置', isBlockedApp('com.android.settings', cfg) === true);
  check('isBlockedApp 不误伤相似包名', isBlockedApp('com.tencent.mm.plugin', cfg) === false);
  check('isBlockedApp 区分大小写', isBlockedApp('COM.tencent.mm', cfg) === false);
  check('isBlockedApp 空串 / 非字符串 → false', isBlockedApp('', cfg) === false && isBlockedApp(null, cfg) === false && isBlockedApp(123, cfg) === false);
  check('isBlockedApp 认用户追加项', isBlockedApp('com.extra.app', { blockedApps: ['com.extra.app'] }) === true);
  check('isBlockedApp 传 undefined 也不崩（默认配置）', isBlockedApp('com.tencent.mm', undefined) === true);

  check('中文名：微信', blockedAppLabel('com.tencent.mm') === '微信');
  check('中文名：支付宝', blockedAppLabel('com.eg.android.AlipayGphone') === '支付宝');
  check('中文名：系统设置', blockedAppLabel('com.android.settings') === '系统设置');
  check('中文名：未知包给空串', blockedAppLabel('com.example.game') === '');
  check('前台话术带中文名与包名', blockedForegroundText('com.tencent.mm').includes('微信') && blockedForegroundText('com.tencent.mm').includes('com.tencent.mm'));
  check('前台话术说清「等这一屏被切走」', blockedForegroundText('com.tencent.mm').includes('切走'));
  check('前台话术点出唯一逃生动作 device_key home', blockedForegroundText('com.tencent.mm').includes('device_key home'));
  check('前台话术对未知包也完整', blockedForegroundText('com.example.game').includes('com.example.game'));
  check('开应用话术说「黑名单」', blockedOpenText('com.eg.android.AlipayGphone').includes('黑名单'));
  check('开应用话术带中文名', blockedOpenText('com.eg.android.AlipayGphone').includes('支付宝'));

  // parseForeground：真实 dumpsys window 的几种输出形状。
  check('解析 mCurrentFocus（包名/活动名）', parseForeground('  mCurrentFocus=Window{1a2b3c u0 com.tencent.mm/com.tencent.mm.ui.LauncherUI}\n') === 'com.tencent.mm');
  check('解析 mCurrentFocus（launcher）', parseForeground('mCurrentFocus=Window{9f8e u0 com.android.launcher3/com.android.launcher3.Launcher}\n') === 'com.android.launcher3');
  check('解析 mCurrentFocus（相对活动名 .Main）', parseForeground('mCurrentFocus=Window{abc u0 com.example.game/.Main}\n') === 'com.example.game');
  check('解析 mCurrentFocus（内部类 $1）', parseForeground('mCurrentFocus=Window{abc u0 com.example.game/.Main$1}\n') === 'com.example.game');
  check('只有包名没有活动名也能认', parseForeground('mCurrentFocus=Window{1a2b3c u0 com.example.game}\n') === 'com.example.game');
  check('mCurrentFocus=null → null（不再去猜 mFocusedApp）', parseForeground('mCurrentFocus=null\n  mFocusedApp=ActivityRecord{1 u0 com.tencent.mm/.ui.LauncherUI t3}\n') === null);
  check('没有 mCurrentFocus 时退回 mFocusedApp', parseForeground('mFocusedApp=ActivityRecord{8ff u0 com.accounting.app/.Main t5}\n') === 'com.accounting.app');
  check('再退回老系统的 mFocusedWindow', parseForeground('mFocusedWindow=Window{123 u0 com.old.rom/.Home}\n') === 'com.old.rom');
  check('只有 window id 没有包名 → null', parseForeground('mCurrentFocus=Window{1a2b3c u0}\n') === null);
  check('空输出 → null', parseForeground('') === null);
  check('非字符串 → null', parseForeground(null) === null && parseForeground(undefined) === null && parseForeground(42) === null);
  check('无关输出 → null', parseForeground('Display: mDisplayId=0\n  init=1080x2280\n') === null);
  check('CRLF 行尾也能解析', parseForeground('mCurrentFocus=Window{1a2b3c u0 com.example.game/.Main}\r\n') === 'com.example.game');
  check('多行时只认 mCurrentFocus（不拿 mFocusedApp 顶替）', parseForeground('WINDOW MANAGER\n  mCurrentFocus=Window{1 u0 com.example.a/.A}\n  mFocusedApp=ActivityRecord{2 u0 com.example.b/.B t1}\n') === 'com.example.a');
  check('乱码输入不抛 → null', parseForeground('mCurrentFocus=Window{{{{ u0 !!!/???}') === null);
}

// ── 8. deviceBudget ───────────────────────────────────────────────────────
{
  const cfg = normalizeDeviceConfig({});
  const fresh = createDeviceState(TODAY);
  const ok = deviceBudget(fresh, cfg, TODAY);
  check('全新状态可以玩', ok.ok === true && ok.reason === 'ok');
  check('全新状态剩余 30 分钟', ok.leftMs === 30 * MIN);
  check('全新状态剩余 60 步', ok.leftSteps === 60);
  check('已用为 0', ok.usedMs === 0 && ok.usedSteps === 0);
  check('回带每日上限（给话术用）', ok.maxMinutesPerDay === 30 && ok.maxStepsPerDay === 60 && ok.minGapMs === 1000);

  const off = deviceBudget(fresh, normalizeDeviceConfig({ enabled: false }), TODAY);
  check('关掉功能 → disabled', off.ok === false && off.reason === 'disabled');

  const almost = deviceBudget({ ...fresh, usedMs: 30 * MIN - 1, day: TODAY_KEY }, cfg, TODAY);
  check('29分59秒 → 还能玩', almost.ok === true && almost.leftMs === 1);

  const full = deviceBudget({ ...fresh, usedMs: 30 * MIN, day: TODAY_KEY }, cfg, TODAY);
  check('正好 30 分钟 → daily_budget', full.ok === false && full.reason === 'daily_budget');
  check('用满后剩余 0 分钟', full.leftMs === 0);
  check('额度用完指向下一个 0 点', new Date(full.nextAllowedAt).getHours() === 0 && full.nextAllowedAt > TODAY);

  const over = deviceBudget({ ...fresh, usedMs: 40 * MIN, day: TODAY_KEY }, cfg, TODAY);
  check('超额也判 daily_budget, 剩余不为负', over.reason === 'daily_budget' && over.leftMs === 0);

  const step59 = deviceBudget({ ...fresh, steps: 59, day: TODAY_KEY, usedMs: 0 }, cfg, TODAY);
  check('第 60 步放行（已用 59 步）', step59.ok === true && step59.leftSteps === 1);

  const step60 = deviceBudget({ ...fresh, steps: 60, day: TODAY_KEY, usedMs: 0 }, cfg, TODAY);
  check('第 61 步被拦（已用 60 步）', step60.ok === false && step60.reason === 'step_budget');
  check('步数用满剩余 0', step60.leftSteps === 0);

  const step61 = deviceBudget({ ...fresh, steps: 61, day: TODAY_KEY, usedMs: 0 }, cfg, TODAY);
  check('已用 61 步仍然拦', step61.reason === 'step_budget');

  const crossDay = deviceBudget(
    { day: YESTERDAY_KEY, usedMs: 30 * MIN, steps: 60, lastTs: TODAY - 60 * MIN, pausedUntil: 0, pausedReason: '' },
    cfg,
    TODAY,
  );
  check('跨日重置 → 可以玩', crossDay.ok === true);
  check('跨日重置后已用 0', crossDay.usedMs === 0 && crossDay.usedSteps === 0);
  check('跨日重置后剩 30 分钟 / 60 步', crossDay.leftMs === 30 * MIN && crossDay.leftSteps === 60);

  const paused = deviceBudget(
    { ...createDeviceState(TODAY), pausedUntil: TODAY + 5 * MIN, pausedReason: 'conversation' },
    cfg,
    TODAY,
  );
  check('暂停中 → paused', paused.ok === false && paused.reason === 'paused');
  check('暂停回带解除时间', paused.nextAllowedAt === TODAY + 5 * MIN);

  const pauseOver = deviceBudget(
    { ...createDeviceState(TODAY), pausedUntil: TODAY - 1, usedMs: 30 * MIN },
    cfg,
    TODAY,
  );
  check('暂停已过期 → 继续按日额度判', pauseOver.reason === 'daily_budget');

  const pausedBeatsBudget = deviceBudget(
    { ...createDeviceState(TODAY), usedMs: 30 * MIN, pausedUntil: TODAY + MIN },
    cfg,
    TODAY,
  );
  check('暂停优先于日额度', pausedBeatsBudget.reason === 'paused');

  const disabledBeatsPause = deviceBudget(
    { ...createDeviceState(TODAY), pausedUntil: TODAY + MIN },
    normalizeDeviceConfig({ enabled: false }),
    TODAY,
  );
  check('关闭优先于暂停', disabledBeatsPause.reason === 'disabled');

  const cooling = deviceBudget({ ...createDeviceState(TODAY), lastTs: TODAY - 500 }, cfg, TODAY);
  check('间隔不足 → cooldown', cooling.ok === false && cooling.reason === 'cooldown');
  check('冷却回带下一步允许时间', cooling.nextAllowedAt === TODAY - 500 + 1000);

  const justCooled = deviceBudget({ ...createDeviceState(TODAY), lastTs: TODAY - 1000 }, cfg, TODAY);
  check('间隔正好 1000ms → 放行', justCooled.ok === true && justCooled.reason === 'ok');

  const gapZero = deviceBudget(
    { ...createDeviceState(TODAY), lastTs: TODAY },
    normalizeDeviceConfig({ minGapMs: 0 }),
    TODAY,
  );
  check('minGapMs=0 时同毫秒也放行', gapZero.ok === true);

  const future = deviceBudget({ ...createDeviceState(TODAY), lastTs: TODAY + 5000 }, cfg, TODAY);
  check('lastTs 在未来（时钟回拨）→ 仍 cooldown', future.reason === 'cooldown');

  const custom = deviceBudget(createDeviceState(TODAY), normalizeDeviceConfig({ maxMinutesPerDay: 5, maxStepsPerDay: 5 }), TODAY);
  check('自定义额度生效', custom.leftMs === 5 * MIN && custom.leftSteps === 5);

  const missingState = deviceBudget(undefined, cfg, TODAY);
  check('状态缺失 → 当今天还没玩', missingState.ok === true && missingState.usedSteps === 0);
}

// ── 9. recordStep ─────────────────────────────────────────────────────────
{
  const cfg = normalizeDeviceConfig({});
  const start = createDeviceState(TODAY);
  const first = recordStep(start, TODAY, { type: 'tap' });
  check('第一步计 1 步', first.steps === 1);
  check('第一步不改入参', start.steps === 0 && start.lastTs === 0);
  check('第一步记下时间', first.lastTs === TODAY);
  check('第一步不累加时长（没有上一步）', first.usedMs === 0);

  const second = recordStep(first, TODAY + 5000, { type: 'tap' });
  check('第二步计 2 步', second.steps === 2);
  check('第二步累加 5 秒', second.usedMs === 5000);

  const longGap = recordStep(first, TODAY + 30 * MIN, { type: 'tap' });
  check('单步时长上限 10 分钟', longGap.usedMs === 10 * MIN);

  const nextDay = recordStep({ ...first, usedMs: 20 * MIN, steps: 30 }, TODAY + 24 * 60 * MIN, { type: 'tap' });
  check('跨日步数重置为 1', nextDay.steps === 1);
  check('跨日时长重置为 0', nextDay.usedMs === 0);
  check('跨日更新日键', nextDay.day !== first.day);

  const pausedState = { ...first, pausedUntil: TODAY + MIN, pausedReason: 'conversation' };
  const kept = recordStep(pausedState, TODAY + 2000, { type: 'tap' });
  check('暂停标记跨步保留', kept.pausedUntil === TODAY + MIN && kept.pausedReason === 'conversation');

  const noClock = recordStep(first, Number.NaN, { type: 'tap' });
  check('now 非法时退回上一步时间', noClock.lastTs === first.lastTs);
  check('now 非法也不产生 NaN', Number.isFinite(noClock.usedMs) && Number.isFinite(noClock.steps));

  const twice = recordStep(recordStep(start, TODAY, null), TODAY + 1000, null);
  check('连续两步连加', twice.steps === 2 && twice.usedMs === 1000);
}

// ── 10. 状态解析 / 序列化 ─────────────────────────────────────────────────
{
  const fresh = createDeviceState(TODAY);
  check('新建状态的日键是今天', fresh.day === TODAY_KEY, fresh.day);
  check('新建状态计数全 0', fresh.usedMs === 0 && fresh.steps === 0 && fresh.lastTs === 0);
  check('新建状态没有暂停', fresh.pausedUntil === 0 && fresh.pausedReason === '');

  const parsedString = parseDeviceState('{"day":"2026-03-15","usedMs":12000,"steps":7,"lastTs":1000,"pausedUntil":0,"pausedReason":""}');
  check('解析 JSON 字符串', parsedString.steps === 7 && parsedString.usedMs === 12000);
  check('解析保留日键', parsedString.day === '2026-03-15');

  const parsedObject = parseDeviceState({ day: '2026-03-15', steps: 3 });
  check('解析对象并补齐缺省字段', parsedObject.steps === 3 && parsedObject.usedMs === 0 && parsedObject.pausedUntil === 0);

  check('坏 JSON → 新状态', parseDeviceState('{oops').steps === 0);
  check('空串 → 新状态', parseDeviceState('').day === deviceDayKey(0));
  check('非字符串非对象 → 新状态', parseDeviceState(42).steps === 0);
  check('JSON 是数组 → 新状态', parseDeviceState('[1,2]').steps === 0);

  const dirty = parseDeviceState({ day: 'not-a-date', usedMs: -5, steps: 'x', lastTs: Number.NaN, pausedUntil: -1, pausedReason: 123 });
  check('非法日键回落 1970-01-01', dirty.day === '1970-01-01');
  check('负数计数归 0', dirty.usedMs === 0 && dirty.pausedUntil === 0);
  check('非数字步数归 0', dirty.steps === 0);
  check('非字符串暂停原因归空串', dirty.pausedReason === '');
  check('超长暂停原因被截断', parseDeviceState({ pausedReason: 'x'.repeat(100) }).pausedReason.length === 40);

  const serialized = serializeDeviceState({ day: '2026-03-15', usedMs: 5000, steps: 4, lastTs: 99, pausedUntil: 0, pausedReason: '' });
  check(
    '序列化字段顺序固定',
    serialized === '{"day":"2026-03-15","usedMs":5000,"steps":4,"lastTs":99,"pausedUntil":0,"pausedReason":""}',
    serialized,
  );
  equal('序列化 → 解析 往返一致', parseDeviceState(serialized), {
    day: '2026-03-15',
    usedMs: 5000,
    steps: 4,
    lastTs: 99,
    pausedUntil: 0,
    pausedReason: '',
  });
  check('序列化脏值也不产生 null', serializeDeviceState(undefined).includes('"steps":0'));

  const pausedState = pauseDevice(createDeviceState(TODAY), normalizeDeviceConfig({}), TODAY, 'conversation');
  check('暂停写到 1 小时后', pausedState.pausedUntil === TODAY + 60 * MIN);
  check('暂停带原因', pausedState.pausedReason === 'conversation');
  check('暂停不改变步数', pausedState.steps === 0);
  const pausedShort = pauseDevice(createDeviceState(TODAY), normalizeDeviceConfig({ pauseAfterRunMs: 10 * MIN }), TODAY, '');
  check('空原因回落 manual', pausedShort.pausedReason === 'manual');
  check('暂停后预算立刻变 paused', deviceBudget(pausedState, normalizeDeviceConfig({}), TODAY).reason === 'paused');
}

// ── 11. describeAdbError ──────────────────────────────────────────────────
{
  check('no devices → no_device', describeAdbError('error: no devices/emulators found').code === 'no_device');
  check('no_device 有中文原因', describeAdbError('error: no devices/emulators found').reason.includes('没找到平板'));
  check('unauthorized → unauthorized', describeAdbError('error: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set').code === 'unauthorized');
  check('unauthorized 提示点允许', describeAdbError('device unauthorized').reason.includes('允许'));
  check('offline → offline', describeAdbError('error: device offline').code === 'offline');
  check('offline 提示拔插', describeAdbError('device offline').reason.includes('拔插'));
  check('not found → no_device', describeAdbError("error: device 'ABC' not found").code === 'no_device');
  check('more than one device → no_device', describeAdbError('error: more than one device/emulator').code === 'no_device');
  check('no permissions → no_device', describeAdbError('error: insufficient permissions for device').code === 'no_device');
  check('timed out → timeout', describeAdbError('adb: failed to install: timed out').code === 'timeout');
  check('中文超时也能认', describeAdbError('连接超时').code === 'timeout');
  check('空 stderr → unknown', describeAdbError('').code === 'unknown');
  check('non-string → unknown', describeAdbError(null).code === 'unknown');
  check('看不懂的错误 → unknown', describeAdbError('segmentation fault').code === 'unknown');
  check('每次都给 reason', typeof describeAdbError('anything').reason === 'string');
  check('unauthorized 优先于 not found', describeAdbError('device unauthorized, device not found').code === 'unauthorized');
}

// ── 12. budgetReasonText ──────────────────────────────────────────────────
{
  const info = deviceBudget(createDeviceState(TODAY), normalizeDeviceConfig({}), TODAY);
  check('ok 话术', budgetReasonText('ok', info).includes('可以玩'));
  check('disabled 话术提到开关', budgetReasonText('disabled', info).includes('关着'));
  check('daily_budget 话术带分钟数', budgetReasonText('daily_budget', info).includes('30'));
  check('daily_budget 话术提明天', budgetReasonText('daily_budget', info).includes('明天'));
  check('step_budget 话术带步数', budgetReasonText('step_budget', info).includes('60'));
  check('cooldown 话术带秒数', budgetReasonText('cooldown', info).includes('秒'));
  check('cooldown 至少 1 秒', budgetReasonText('cooldown', { minGapMs: 100 }).includes('1 秒'));
  check('未知原因有兜底', budgetReasonText('whatever', info).length > 0);
  check('info 缺省也不崩', budgetReasonText('daily_budget', undefined).includes('30'));

  const pausedBudget = deviceBudget(
    { ...createDeviceState(TODAY), pausedUntil: localMs(2026, 3, 15, 15, 45) },
    normalizeDeviceConfig({}),
    TODAY,
  );
  check('paused 话术带时钟', /\d{2}:\d{2}/.test(budgetReasonText('paused', pausedBudget)));
}

// ── 13. devicePromptBlock ────────────────────────────────────────────────
{
  const off = devicePromptBlock(normalizeDeviceConfig({ enabled: false }), createDeviceState(TODAY), TODAY);
  equal('关闭时只回 enabled:false', off, { enabled: false });

  const block = devicePromptBlock(normalizeDeviceConfig({}), createDeviceState(TODAY), TODAY);
  check('开启时 enabled=true', block.enabled === true);
  check('提示词块回带白名单', Array.isArray(block.apps) && block.apps.length === 0);
  check('提示词块回带黑名单', Array.isArray(block.blocked) && block.blocked.length === 5, block.blocked);
  check('提示词块黑名单里有微信', Array.isArray(block.blocked) && block.blocked.includes('com.tencent.mm'));
  check('提示词块回带剩余额度', block.budget.leftMinutes === 30 && block.budget.leftSteps === 60);
  check('提示词块讲边界', block.hint.includes('只玩不越界'));
  check('提示词块讲中文限制', block.hint.includes('中文'));
  check('提示词块讲一步一图', block.hint.includes('一次只做一步'));
  check('提示词块点名黑名单应用', block.hint.includes('微信') && block.hint.includes('支付宝'));
  check('提示词块点出逃生口 device_key home（并说明 back 不行）', block.hint.includes('device_key home') && block.hint.includes('back 不行'));

  const used = devicePromptBlock(normalizeDeviceConfig({}), { ...createDeviceState(TODAY), usedMs: 10 * MIN }, TODAY);
  check('用掉 10 分钟后剩 20', used.budget.leftMinutes === 20);

  const almostFull = devicePromptBlock(
    normalizeDeviceConfig({}),
    { ...createDeviceState(TODAY), usedMs: 29 * MIN + 1000 },
    TODAY,
  );
  check('剩 1 分钟时向上取整', almostFull.budget.leftMinutes === 1);

  const exhausted = devicePromptBlock(
    normalizeDeviceConfig({}),
    { ...createDeviceState(TODAY), usedMs: 30 * MIN },
    TODAY,
  );
  check('额度用完时 hint 说不能玩', exhausted.hint.includes('不能玩'));

  const whitelisted = devicePromptBlock(
    normalizeDeviceConfig({ apps: ['com.a.game'] }),
    createDeviceState(TODAY),
    TODAY,
  );
  check('提示词块带白名单内容', JSON.stringify(whitelisted.apps) === '["com.a.game"]');
}

// ── 14. defaultRunAdb（不连设备：故意给一个不存在的 adb） ─────────────────
{
  const res = await defaultRunAdb(['version'], { adbPath: 'C:\\definitely-not-here\\adb.exe', timeoutMs: 5000 });
  check('不存在 adb 也不抛', res && typeof res === 'object');
  check('不存在 adb → ok:false', res.ok === false);
  check('失败也带 code', typeof res.code === 'number' && res.code !== 0, res.code);
  check('失败带 stderr 文案', typeof res.stderr === 'string' && res.stderr.length > 0);
  check('失败也带空 stdoutBuffer', Buffer.isBuffer(res.stdoutBuffer) && res.stdoutBuffer.length === 0);

  const empty = await defaultRunAdb([], { adbPath: 'C:\\definitely-not-here\\adb.exe', timeoutMs: 1000 });
  check('空参数也不抛', empty.ok === false);
  const junk = await defaultRunAdb(null, { adbPath: 'C:\\definitely-not-here\\adb.exe', timeoutMs: 1000 });
  check('非法参数也不抛', junk.ok === false && typeof junk.stderr === 'string');
}

// ── 结果 ────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n结果：${passed}/${total} passed${failed > 0 ? `，${failed} failed` : ''}`);
if (failed > 0) process.exitCode = 1;
