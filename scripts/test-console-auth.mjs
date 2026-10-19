// 控制台令牌来源判定（src/console-auth.js）的单测 + bridge.js 接线静态守卫。
//
// 为什么要有这个文件：令牌来源判定是"控制台安全边界"的**唯一**入口。这里钉住三件事：
//   ① 优先级 url > header > cookie（人在地址栏刚输的那次永远优先）；
//   ② cookie 的生效面只有 `GET /` 与 `GET /demo` —— 以 `/api/` 开头的路径与一切非 GET 请求永不读 cookie。
//      这是安全性的**第一层**，SameSite=Strict 只是第二层：一旦接口认 cookie，攻击面就从
//      "猜一个 192 bit 随机值"退化成"诱导本机浏览器自动带上 cookie"；
//   ③ 会话 cookie 的属性（HttpOnly / SameSite=Strict / Path=/ / Max-Age）与 bridge 侧的接线
//      姿势（cookie 头只读一处、只经 resolveRequestToken、只在页面 GET 上 Set-Cookie）。
//
// 全程纯函数 + 读源码做静态断言，不碰网络、不启服务、不读真实配置。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  CONSOLE_COOKIE_NAME, CONSOLE_COOKIE_MAX_AGE_SEC, PAGE_PATHS,
  buildSessionCookie, isPagePath, parseCookieHeader, resolveRequestToken
} from '../src/console-auth.js';

const ROOT = new URL('../', import.meta.url);
const authSource = fs.readFileSync(new URL('src/console-auth.js', ROOT), 'utf8');
const bridgeSource = fs.readFileSync(new URL('src/bridge.js', ROOT), 'utf8');
const bridgeLines = bridgeSource.split(/\r?\n/);

/** 找 bridge.js 里第一处包含 needle 的行号（1-based），找不到返回 0。 */
function lineNoOf(needle) {
  const index = bridgeLines.findIndex((line) => line.includes(needle));
  return index < 0 ? 0 : index + 1;
}

test('常量：cookie 名、30 天寿命、冻结的页面白名单', () => {
  assert.equal(CONSOLE_COOKIE_NAME, 'dsh_console_token');
  assert.equal(CONSOLE_COOKIE_MAX_AGE_SEC, 2592000);
  assert.equal(CONSOLE_COOKIE_MAX_AGE_SEC, 30 * 24 * 60 * 60, '30 天');
  assert.deepEqual([...PAGE_PATHS], ['/', '/demo']);
  assert.equal(Object.isFrozen(PAGE_PATHS), true, '白名单必须冻结：运行时被 push 进去就是扩大 cookie 生效面');
  assert.throws(() => { PAGE_PATHS.push('/api/status'); }, TypeError);
});

test('isPagePath：严格相等，只认 / 与 /demo', () => {
  assert.equal(isPagePath('/'), true);
  assert.equal(isPagePath('/demo'), true);
  // 下面每一项若变成 true，cookie 的生效面就被悄悄放大了：
  const rejected = [
    '', '/demo/', '//', '/api/status', '/api/status/', '/api/watchdog',
    '/index.html', '/console.html', '/demo?token=x', '/demo#switches', 'demo', '/DEMO',
    '/demo/../api/status', '/demo/sub', null, undefined
  ];
  for (const pathname of rejected) {
    assert.equal(isPagePath(pathname), false, `isPagePath(${JSON.stringify(pathname)}) 必须为 false`);
  }
});

test('parseCookieHeader：按 ; 切、trim、只取第一个同名项、解码失败用原值', () => {
  assert.equal(parseCookieHeader('dsh_console_token=abc', 'dsh_console_token'), 'abc');
  assert.equal(parseCookieHeader('a=1; dsh_console_token=abc; b=2', 'dsh_console_token'), 'abc');
  assert.equal(parseCookieHeader('a=1;dsh_console_token=abc', 'dsh_console_token'), 'abc');
  assert.equal(parseCookieHeader('  dsh_console_token = abc  ', 'dsh_console_token'), 'abc');
  // 重复同名只认第一个：后面的可能是脚本或攻击者塞的，没有理由再猜
  assert.equal(parseCookieHeader('dsh_console_token=first; dsh_console_token=second', 'dsh_console_token'), 'first');
  // 名字必须整体相等，前缀相同不算
  assert.equal(parseCookieHeader('dsh_console_token_x=1', 'dsh_console_token'), null);
  assert.equal(parseCookieHeader('xdsh_console_token=1', 'dsh_console_token'), null);
  assert.equal(parseCookieHeader('dsh_console_token=abc', 'other'), null);
  // 同名但值为空 → 当作没有
  assert.equal(parseCookieHeader('dsh_console_token=', 'dsh_console_token'), null);
  assert.equal(parseCookieHeader('dsh_console_token=   ; a=1', 'dsh_console_token'), null);
  // 没有等号的段整段跳过
  assert.equal(parseCookieHeader('flag; dsh_console_token=abc', 'dsh_console_token'), 'abc');
  // 缺头 / 缺名 / 空串
  assert.equal(parseCookieHeader('', 'dsh_console_token'), null);
  assert.equal(parseCookieHeader(undefined, 'dsh_console_token'), null);
  assert.equal(parseCookieHeader(null, 'dsh_console_token'), null);
  assert.equal(parseCookieHeader('dsh_console_token=abc', ''), null);
  // 值里的 %XX 能解就解
  assert.equal(parseCookieHeader('dsh_console_token=a%20b', 'dsh_console_token'), 'a b');
  assert.equal(parseCookieHeader('dsh_console_token=%E4%B8%AD%E6%96%87', 'dsh_console_token'), '中文');
  // 畸形百分号序列不许抛，原样返回（反正后面还要定长比较，猜错就是 401）
  assert.equal(parseCookieHeader('dsh_console_token=bad%zz', 'dsh_console_token'), 'bad%zz');
  assert.equal(parseCookieHeader('dsh_console_token=%', 'dsh_console_token'), '%');
});

test('buildSessionCookie：属性齐全，与 parseCookieHeader 往返一致', () => {
  assert.equal(
    buildSessionCookie('tok-123'),
    'dsh_console_token=tok-123; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000'
  );
  const cookie = buildSessionCookie('tok-123');
  assert.match(cookie, /^dsh_console_token=tok-123; /);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/, 'HttpOnly：XSS 拿不到这个 cookie');
  assert.match(cookie, /SameSite=Strict/, 'SameSite=Strict：跨站请求不带（第二层防线）');
  assert.match(cookie, /Max-Age=2592000/);
  // 不写 Domain = host-only，只对 127.0.0.1 / localhost 生效
  assert.ok(!/Domain=/i.test(cookie), '不写 Domain');
  // 不用 Secure、也不用 __Host- 前缀：控制台是 http://127.0.0.1 明文回环，
  // 带 Secure 浏览器会直接丢弃这个 cookie，等于开关失效。
  assert.ok(!/;\s*Secure/i.test(cookie), '明文回环不能带 Secure');
  assert.ok(!/__Host-/i.test(cookie), '__Host- 需要 Secure，本机 http 用不了');
  // 编码 ↔ 解码对称（值里带空格、分号、等号、百分号也不破坏 Cookie 头结构）
  const weird = 'a b;c=d%';
  const roundTrip = parseCookieHeader(buildSessionCookie(weird).split(';')[0], CONSOLE_COOKIE_NAME);
  assert.equal(roundTrip, weird);
  // 空令牌也不炸（调用方不该用它，但纯函数不该抛）
  assert.equal(buildSessionCookie(), 'dsh_console_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000');
});

test('resolveRequestToken：优先级 url > header > cookie', () => {
  const cookieHeader = 'dsh_console_token=from-cookie';
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', urlToken: 'from-url', headerToken: 'from-header', cookieHeader }),
    { token: 'from-url', source: 'url' }
  );
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', headerToken: 'from-header', cookieHeader }),
    { token: 'from-header', source: 'header' }
  );
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', cookieHeader }),
    { token: 'from-cookie', source: 'cookie' }
  );
  // 空串不算"有值"，不能把后面的来源顶掉
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', urlToken: '', headerToken: 'h', cookieHeader }),
    { token: 'h', source: 'header' }
  );
  // 没令牌
  assert.deepEqual(resolveRequestToken({}), { token: '', source: null });
  assert.deepEqual(resolveRequestToken(), { token: '', source: null });
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', urlToken: '', headerToken: '', cookieHeader: '' }),
    { token: '', source: null }
  );
  // 令牌原样透传（不做 trim / 不截断）：比较交给 bridge 的定长比较
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', headerToken: '  spaced  ' }),
    { token: '  spaced  ', source: 'header' }
  );
});

test('cookie 生效面：只有 GET / 与 GET /demo 认 cookie，/api/ 下的路径与一切非 GET 永不读', () => {
  const cookieHeader = 'dsh_console_token=cookie-token';
  const read = (method, pathname) => resolveRequestToken({ method, pathname, cookieHeader });

  // 唯二生效的两格
  assert.deepEqual(read('GET', '/'), { token: 'cookie-token', source: 'cookie' });
  assert.deepEqual(read('GET', '/demo'), { token: 'cookie-token', source: 'cookie' });

  // 接口侧永不读 cookie —— 这一条是安全性的第一层，不是 SameSite
  for (const path of ['/api/status', '/api/restart', '/api/watchdog', '/api/presets', '/api/mode', '/api/role']) {
    assert.deepEqual(read('GET', path), { token: '', source: null }, `GET ${path} 不得读 cookie`);
    assert.deepEqual(read('POST', path), { token: '', source: null }, `POST ${path} 不得读 cookie`);
  }

  // 页面路径上的非 GET 也不读（不靠"没人这么发"兜底）
  assert.deepEqual(read('POST', '/'), { token: '', source: null });
  assert.deepEqual(read('POST', '/demo'), { token: '', source: null });
  assert.deepEqual(read('PUT', '/demo'), { token: '', source: null });
  assert.deepEqual(read('DELETE', '/'), { token: '', source: null });

  // 相近但不等价的页面路径同样不读
  assert.deepEqual(read('GET', '/demo/'), { token: '', source: null });
  assert.deepEqual(read('GET', '/index.html'), { token: '', source: null });
  assert.deepEqual(read('GET', '/console.html'), { token: '', source: null });

  // 方法不做大小写敏感的意外：get 仍是 GET，但 post 不会被认成 GET
  assert.deepEqual(read('get', '/'), { token: 'cookie-token', source: 'cookie' });
  assert.deepEqual(read('post', '/demo'), { token: '', source: null });

  // cookie 里的令牌为空 = 没有
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', cookieHeader: 'dsh_console_token=' }),
    { token: '', source: null }
  );
  assert.deepEqual(
    resolveRequestToken({ method: 'GET', pathname: '/', cookieHeader: 'other=1' }),
    { token: '', source: null }
  );
  assert.deepEqual(resolveRequestToken({ method: 'GET', pathname: '/' }), { token: '', source: null });
});

test('模块纪律：零依赖、零 I/O、无 Date.now（保持可整个 spread 进 VM 审计沙盘）', () => {
  assert.ok(!/^import[\s{*'"]/m.test(authSource), 'console-auth.js 不得 import 任何东西');
  assert.ok(!/\brequire\s*\(/.test(authSource), '不得 require');
  assert.ok(!/\bDate\.now\s*\(/.test(authSource), '不得用 Date.now()：这是一组纯函数');
  assert.ok(!/\bconsole\.(log|error|warn)\s*\(/.test(authSource), '不得打日志（本模块零 I/O）');
  assert.ok(!/\bfs\./.test(authSource), '不得读文件');
  assert.ok(!/\bprocess\.env\b/.test(authSource), '不得读环境变量');
});

test('bridge.js 接线：cookie 头只读一处，且只经 resolveRequestToken 生效', () => {
  const cookieReads = bridgeLines
    .map((line, index) => ({ line, no: index + 1 }))
    .filter(({ line }) => /req\.headers\.cookie\b/.test(line));
  assert.equal(
    cookieReads.length, 1,
    `req.headers.cookie 只允许出现一次（唯一入口必须能一眼看全），实际 ${cookieReads.length} 处：第 ${cookieReads.map((item) => item.no).join('、')} 行`
  );
  const hit = cookieReads[0];
  assert.match(hit.line, /cookieHeader:/, '唯一那处读 cookie 必须是 resolveRequestToken({ cookieHeader: … }) 的实参');
  const callWindow = bridgeLines.slice(Math.max(0, hit.no - 10), hit.no).join('\n');
  assert.match(callWindow, /resolveRequestToken\(\{/, 'cookie 头必须喂给 resolveRequestToken，而不是就地判断');

  // 不许绕过封装自己解析 Cookie 头
  assert.equal((bridgeSource.match(/parseCookieHeader\(/g) ?? []).length, 0,
    'bridge.js 不许直接调 parseCookieHeader：cookie 只许经 resolveRequestToken 生效');
  assert.equal((bridgeSource.match(/resolveRequestToken\(/g) ?? []).length, 1,
    'resolveRequestToken 只该在鉴权关卡调用一次（多一处就是多一个来源判定入口）');
});

test('bridge.js 接线：Set-Cookie 只对页面 GET 下发，且来源不是 cookie', () => {
  const no = lineNoOf("res.setHeader('set-cookie', buildSessionCookie(suppliedToken))");
  assert.ok(no > 0, "必须有一条 res.setHeader('set-cookie', buildSessionCookie(suppliedToken))");
  const guard = bridgeLines.slice(Math.max(0, no - 7), no).join('\n');
  assert.match(guard, /supplied\.source !== 'cookie'/, '从 cookie 认可的不该重复下发 Set-Cookie');
  assert.match(guard, /req\.method === 'GET'/, '只在 GET 上种 cookie');
  assert.match(guard, /isPagePath\(url\.pathname\)/, '只在 / 与 /demo 上种 cookie');

  // 401 页逻辑不变：自带 prompt()，回跳地址只取 / 或 /demo 这两个固定字面量（无开放重定向）
  const gate = bridgeSource.indexOf('if (consoleToken && !tokenMatches)');
  assert.ok(gate > 0, '鉴权关卡必须还在');
  const block = bridgeSource.slice(gate, gate + 1400);
  assert.ok(block.includes('请输入控制台访问令牌'), '401 页仍要自带 prompt()');
  assert.ok(block.includes("location.href='${backTo}?token='"), '401 页回跳仍是 ${backTo}?token=');
  assert.match(block, /const backTo = url\.pathname === '\/demo' \? '\/demo' : '\/';/, '回跳只在这两个固定字面量里取');
  assert.match(block, /sendJson\(\{ ok: false, error: '未授权：请提供控制台访问令牌' \}, 401\)/, '非页面路径仍回 JSON 401');
});

test('bridge.js：POST /api/watchdog 只收布尔、回 enabled/running、且落在写操作前置校验之后', () => {
  const no = lineNoOf("url.pathname === '/api/watchdog'");
  assert.ok(no > 0, '必须注册 POST /api/watchdog');
  const block = bridgeLines.slice(no - 1, no + 17).join('\n');
  assert.match(block, /req\.method === 'POST'/, '必须是 POST');
  assert.match(block, /typeof body\.enabled !== 'boolean'/, '只认布尔值');
  assert.match(block, /'enabled 必须是布尔值'/, '错误文案要与任务书一致');
  assert.match(block, /, 400\)/, '非布尔要回 400');
  assert.match(block, /stallWatchdog\.setEnabled\(body\.enabled\)/, '必须走 setEnabled');
  assert.match(block, /enabled: stallWatchdog\.snapshot\(\)\.enabled/, '返回体的 enabled 取 snapshot()');
  assert.match(block, /running: stallWatchdog\.isRunning\(\)/, '返回体要带 running');
  assert.match(block, /\[watchdog\] 控制台：自动硬清理已/, '日志前缀要能被 grep 到');

  // 端点必须排在 CSRF 前置校验之后，才能白拿 application/json + Origin 的检查
  const guardAt = bridgeSource.indexOf("if (req.method !== 'GET') {");
  const endpointAt = bridgeSource.indexOf("url.pathname === '/api/watchdog'");
  assert.ok(guardAt > 0, '写操作前置校验必须还在');
  assert.ok(guardAt < endpointAt, '/api/watchdog 必须落在写操作前置校验之后');
});
