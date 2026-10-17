// Console login (I-10): the NapCat WebUI proxy and the "扫码登录" panel. Nothing
// here talks to a real NapCat: a fake WebUI on a loopback port mimics HTTP 200 +
// `body.code` verdicts and a Credential that dies on restart, and the workdir is a
// temp directory, so the real runtime/napcat/config/webui.json is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { Store } from '../src/store.js';
import { createConsole } from '../src/console/server.js';
import { createNapCatWebui, MIN_LOGIN_GAP_MS } from '../src/napcat-webui.js';
import { TOKEN, auth, jsonPost } from './support/console-harness.js';

const WEBUI_TOKEN = 'webui-token-must-not-leak';
const HASH = createHash('sha256').update(`${WEBUI_TOKEN}.napcat`).digest('hex');
const CREDENTIAL = 'credential-must-not-leak';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

// A WebUI that lies the way the real one does: HTTP 200 for every call, the answer
// in `body.code`; `state.ticket` is the Credential currently accepted.
async function startNapcat(t, overrides = {}) {
  const state = {
    phase: 'waiting_qrcode', isLogin: false, selfOnline: false, qrLoginAccepted: false,
    loginError: '', uin: '10000', qrUrl: 'https://qq.example/qr-login-url',
    restarting: false, hang: false, require2FA: false, authDelayMs: 0,
    failRefresh: '', pngPath: '', ticket: CREDENTIAL, authCount: 0,
    ...overrides,
  };
  const reply = (res, payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (state.hang) return; // never answers: the client has to time out
      if (path === '/api/auth/login') {
        state.authCount += 1;
        if (state.authDelayMs) await new Promise(done => setTimeout(done, state.authDelayMs));
        if (body.hash !== HASH) return reply(res, { code: -1, message: 'token 错误', data: null });
        if (state.require2FA) return reply(res, { code: 0, message: '', data: { Credential: '', require2FA: true } });
        return reply(res, { code: 0, message: '', data: { Credential: state.ticket, require2FA: false } });
      }
      if (String(req.headers.authorization ?? '') !== `Bearer ${state.ticket}`) {
        return reply(res, { code: -1, message: '登录已失效', data: null });
      }
      if (path === '/api/QQLogin/CheckLoginStatus') {
        return reply(res, {
          code: 0, message: '', data: {
            isLogin: state.isLogin, isOffline: false, loginPhase: state.phase,
            qrLoginAccepted: state.qrLoginAccepted, coreReady: true,
            qrcodeurl: state.qrUrl, loginError: state.loginError,
            selfInfo: { online: state.selfOnline, uin: state.uin },
          },
        });
      }
      if (path === '/api/QQLogin/GetQQLoginInfo') {
        return reply(res, { code: 0, message: '', data: { uin: state.uin, online: state.selfOnline, avatarUrl: '' } });
      }
      if (path === '/api/QQLogin/RefreshQRcode') {
        if (state.isLogin) return reply(res, { code: -1, message: 'QQ Is Logined', data: null });
        if (state.failRefresh) return reply(res, { code: -1, message: state.failRefresh, data: null });
        if (state.pngPath) writeFileSync(state.pngPath, PNG); // NapCat writes cache/qrcode.png
        if (state.restarting) return reply(res, { code: 0, message: '', data: { qrcodeurl: '', restarting: true } });
        return reply(res, { code: 0, message: '', data: { qrcodeurl: state.qrUrl } });
      }
      return reply(res, { code: -1, message: `unknown ${path}`, data: null });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return { state, port: server.address().port };
}

// A throwaway workdir: no webui.json means "disabled", like a machine without NapCat.
function workdir(t, { config = true, token = WEBUI_TOKEN, port = 1, png = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-login-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cache'), { recursive: true });
  if (config) {
    writeFileSync(join(root, 'config', 'webui.json'), JSON.stringify({ host: '127.0.0.1', port, token, loginRate: 3 }));
  }
  if (png) writeFileSync(join(root, 'cache', 'qrcode.png'), png);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const clientFor = (root, extra = {}) =>
  createNapCatWebui({ workdir: root, statusTtlMs: 0, minLoginGapMs: 0, ...extra });

function consoleFor(t, webui, log = () => {}) {
  const store = new Store();
  t.after(() => store.close());
  const config = { model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0 };
  return createConsole({ config, store, webui, log, port: 0 });
}

async function consoleUp(t, webui, log) {
  const server = consoleFor(t, webui, log);
  await server.start();
  t.after(() => server.stop());
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('every NapCat login phase maps to one console state', async t => {
  const napcat = await startNapcat(t);
  const client = clientFor(workdir(t, { port: napcat.port }));
  const rows = [
    ['offline', false, false, 'idle'],
    ['generating_qrcode', false, false, 'waiting'],
    ['waiting_qrcode', false, false, 'waiting'],
    ['qrcode_scanned', false, false, 'scanned'],
    ['initializing', false, false, 'scanned'],
    ['reconnecting', false, false, 'idle'],
    ['ready', true, true, 'online'],
    // isLogin without a live selfInfo.online is not "online" (hard requirement).
    ['ready', true, false, 'idle'],
  ];
  for (const [phase, isLogin, selfOnline, expected] of rows) {
    Object.assign(napcat.state, { phase, isLogin, selfOnline, qrLoginAccepted: phase === 'qrcode_scanned' });
    const status = await client.status();
    assert.equal(status.state, expected, `${phase} login=${isLogin} online=${selfOnline}`);
    assert.equal(status.online, expected === 'online', phase);
  }
});

test('the online state carries the login number and nothing else', async t => {
  const napcat = await startNapcat(t, { isLogin: true, selfOnline: true, phase: 'ready' });
  const client = clientFor(workdir(t, { port: napcat.port }));
  const status = await client.status();
  assert.deepEqual(Object.keys(status).sort(), ['online', 'phase', 'qrAt', 'state', 'uin']);
  assert.equal(status.state, 'online');
  assert.equal(status.uin, '10000');
});

test('a dead WebUI port reads as unreachable, not as an error', async t => {
  const probe = createServer(() => {});
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise(done => probe.close(done));
  const client = clientFor(workdir(t, { port }));
  const status = await client.status();
  assert.equal(status.state, 'unreachable');
  assert.equal(status.online, false);
});

test('a missing or malformed webui.json is disabled and never touches the network', async t => {
  let called = 0;
  const fetchImpl = async () => { called += 1; throw new Error('must not be called'); };
  const empty = workdir(t, { config: false });
  const broken = workdir(t);
  writeFileSync(join(broken, 'config', 'webui.json'), '{not json');
  for (const root of [empty, broken]) {
    const client = createNapCatWebui({ workdir: root, statusTtlMs: 0, fetchImpl });
    assert.deepEqual(await client.status(), { state: 'disabled', online: false, qrAt: 0 });
    await assert.rejects(client.refresh(), /WEBUI_DISABLED/);
  }
  assert.equal(called, 0);
});

test('a refused WebUI token is a stable error code without the token or the hash', async t => {
  const napcat = await startNapcat(t);
  const root = workdir(t, { port: napcat.port, token: 'wrong-token-must-not-leak' });
  const status = await clientFor(root).status();
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'WEBUI_AUTH_FAILED');
  const text = JSON.stringify(status);
  for (const secret of [WEBUI_TOKEN, 'wrong-token-must-not-leak', HASH, CREDENTIAL]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test('the credential is cached, and a refused call re-logs in exactly once', async t => {
  const napcat = await startNapcat(t);
  const client = clientFor(workdir(t, { port: napcat.port }));
  await client.status();
  await client.status();
  await client.status();
  assert.equal(napcat.state.authCount, 1, 'three polls share one login');
  napcat.state.ticket = 'credential-after-restart'; // NapCat restarted: old ticket dead
  const status = await client.status();
  assert.equal(status.state, 'waiting');
  assert.equal(napcat.state.authCount, 2, 'one re-login, not one per poll');
});

test('concurrent status calls share a single login', async t => {
  const napcat = await startNapcat(t, { authDelayMs: 60 });
  const client = clientFor(workdir(t, { port: napcat.port }));
  const all = await Promise.all([client.status(), client.status(), client.status(), client.status()]);
  assert.equal(napcat.state.authCount, 1);
  for (const status of all) assert.equal(status.state, 'waiting');
});

test('logins keep the one-second floor the WebUI rate limiter needs', async t => {
  assert.equal(MIN_LOGIN_GAP_MS, 1000);
  const napcat = await startNapcat(t);
  const sleeps = [];
  let clock = 5000;
  const client = createNapCatWebui({
    workdir: workdir(t, { port: napcat.port }),
    statusTtlMs: 0,
    now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
  });
  await client.status();
  assert.deepEqual(sleeps, [], 'the first login waits for nothing');
  napcat.state.ticket = 'credential-after-restart';
  await client.status();
  assert.deepEqual(sleeps, [1000], 'the second login waits out the floor');
});

test('a napcat that never answers times out instead of hanging the console', async t => {
  const napcat = await startNapcat(t, { hang: true });
  const client = clientFor(workdir(t, { port: napcat.port }), { authTimeoutMs: 60, statusTimeoutMs: 60 });
  const status = await client.status();
  assert.deepEqual(status, { state: 'unreachable', online: false, qrAt: 0 });
});

test('refresh returns the new code, and the png is served from the workdir', async t => {
  const napcat = await startNapcat(t);
  const root = workdir(t, { port: napcat.port });
  napcat.state.pngPath = join(root, 'cache', 'qrcode.png');
  const { base } = await consoleUp(t, clientFor(root));
  const missing = await fetch(`${base}/api/login/qr.png?token=${TOKEN}`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'QR_NOT_FOUND');
  const refreshed = await jsonPost(base, '/api/login/qr', {});
  assert.equal(refreshed.status, 200);
  const body = await refreshed.json();
  assert.equal(body.ok, true);
  assert.equal(body.state, 'waiting');
  assert.equal(typeof body.qrAt, 'number');
  assert.ok(!JSON.stringify(body).includes('qq.example'), 'the qr text must not be forwarded');
  const png = await fetch(`${base}/api/login/qr.png?token=${TOKEN}`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  // the workdir is not on the static whitelist, so the file cannot be fetched directly
  assert.equal((await fetch(`${base}/runtime/napcat/cache/qrcode.png`)).status, 404);
  assert.equal((await fetch(`${base}/api/login/qr.png`)).status, 401);
});

test('the refresh route needs a header token and a loopback origin', async t => {
  const napcat = await startNapcat(t, { pngPath: '' });
  const { base } = await consoleUp(t, clientFor(workdir(t, { port: napcat.port })));
  assert.equal((await fetch(`${base}/api/login/qr`, { method: 'POST' })).status, 401);
  const query = await fetch(`${base}/api/login/qr?token=${TOKEN}`, { method: 'POST' });
  assert.equal(query.status, 403);
  assert.equal((await query.json()).error, 'header_token_required');
  const foreign = await fetch(`${base}/api/login/qr`, {
    method: 'POST', headers: { ...auth, Origin: 'http://evil.example' },
  });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');
  const loopback = await fetch(`${base}/api/login/qr`, {
    method: 'POST', headers: { ...auth, Origin: 'http://127.0.0.1:3200' },
  });
  assert.equal(loopback.status, 200);
});

test('an account that is already logged in is not asked for another code', async t => {
  const napcat = await startNapcat(t, { isLogin: true, selfOnline: true, phase: 'ready' });
  const { base } = await consoleUp(t, clientFor(workdir(t, { port: napcat.port })));
  const res = await jsonPost(base, '/api/login/qr', {});
  assert.equal(res.status, 409);
  const body = await res.text();
  assert.ok(body.includes('LOGIN_ALREADY_ONLINE'));
  assert.equal(napcat.state.authCount, 1, 'a business refusal must not trigger a re-login');
});

test('an expired code is a code-0-free failure the client must judge by body.code', async t => {
  const napcat = await startNapcat(t, { failRefresh: '二维码已过期，请刷新' });
  const { base } = await consoleUp(t, clientFor(workdir(t, { port: napcat.port })));
  const res = await jsonPost(base, '/api/login/qr', {});
  assert.equal(res.status, 409, 'HTTP 200 upstream still becomes a real status here');
  assert.ok((await res.text()).includes('QR_EXPIRED'));
  assert.equal(napcat.state.authCount, 1, 'no re-login for a known business failure');
});

test('a restarting login core reports a wait, not a failure', async t => {
  const napcat = await startNapcat(t, { restarting: true });
  const client = clientFor(workdir(t, { port: napcat.port }));
  assert.deepEqual(await client.refresh(), {
    ok: false, restarting: true, state: 'idle', error: 'QR_RESTARTING',
  });
});

test('no console response or log line ever carries the token, the hash or the credential', async t => {
  const napcat = await startNapcat(t);
  const log = [];
  const { base } = await consoleUp(t, clientFor(workdir(t, { port: napcat.port })), line => log.push(String(line)));
  const texts = [
    await (await fetch(`${base}/api/login/status?token=${TOKEN}`)).text(),
    await (await fetch(`${base}/api/login/qr.png?token=${TOKEN}`)).text(),
    await (await jsonPost(base, '/api/login/qr', {})).text(),
    await (await fetch(`${base}/api/login/status`)).text(),
    await (await fetch(`${base}/api/login/qr`, { method: 'POST' })).text(),
  ];
  for (const secret of [WEBUI_TOKEN, HASH, CREDENTIAL, 'credential-after-restart']) {
    for (const text of texts) assert.ok(!text.includes(secret), `response leaked ${secret}`);
    assert.ok(!log.join('\n').includes(secret), `log leaked ${secret}`);
  }
});

test('the login panel polls only while it is on screen and inlines no script', async t => {
  const source = readFileSync(join('src', 'console', 'public', 'pages-settings.js'), 'utf8');
  for (const banned of ['onclick=', 'style="', 'eval(', 'new Function']) {
    assert.ok(!source.includes(banned), `CSP would drop ${banned}`);
  }
  let open = true;
  const nodes = new Map();
  const intervals = [];
  const timeouts = [];
  const cleared = [];
  const calls = [];
  const answer = {
    '/api/settings': { fields: [], groups: [] },
    '/api/login/status': { state: 'waiting', online: false, qrAt: 1700000000000, phase: 'waiting_qrcode' },
  };
  const sandbox = {
    document: {
      hidden: false,
      getElementById(id) {
        if (!open) return null;
        if (!nodes.has(id)) nodes.set(id, { innerHTML: '', dataset: {}, classList: { contains: () => false } });
        return nodes.get(id);
      },
    },
    esc: value => String(value ?? ''),
    num: value => String(value),
    dur: ms => `${Math.round(ms / 1000)} 秒`,
    card: (title, sub, body, extra = '') => `<div class="card">${body}${extra}</div>`,
    dot: kind => `<span class="dot dot-${kind}"></span>`,
    badge: (text, kind = 'muted') => `<span class="badge badge-${kind}">${text}</span>`,
    pageHead: (title, desc) => `<div class="page-head">${title}${desc}</div>`,
    alertBox: (level, title, body) => `<div class="alert alert-${level}">${title}${body}</div>`,
    stat: () => '<div class="stat"></div>',
    kv: () => '<dl class="kv"></dl>',
    sw: () => '<span class="sw"></span>',
    field: () => '<div class="field"></div>',
    switchRow: () => '<div class="switch"></div>',
    seg: () => '<div class="seg"></div>',
    readNumbers: () => ({}), refuse: () => {}, toast: () => {}, flash: () => {}, rerender: () => {},
    explain: code => `说明 ${code}`,
    reason: error => `原因 ${(error && error.message) || error}`,
    token: TOKEN,
    DASH: '—',
    api: async path => { calls.push(['GET', path, '']); return answer[path]; },
    post: async (path, body) => { calls.push(['POST', path, JSON.stringify(body)]); return {}; },
    fetch: async (path, options) => {
      calls.push([options.method, path, options.headers['x-console-token']]);
      return { ok: true, status: 200, json: async () => ({ ok: true, state: 'waiting', qrAt: 1700000000001 }) };
    },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    setTimeout: (fn, ms) => { timeouts.push(ms); fn(); return timeouts.length; },
    clearTimeout: id => { cleared.push(id); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 100 + intervals.length; },
    clearInterval: id => { cleared.push(id); },
  };
  sandbox.globalThis = sandbox;
  const actions = {};
  sandbox.action = (name, handler) => { actions[name] = handler; };
  sandbox.pages = {};
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);

  const html = await sandbox.pages.settings();
  assert.ok(html.includes('data-act="loginRefresh"'), 'the refresh button is an action, not an onclick');
  assert.ok(html.includes('id="login-text"'));
  assert.ok(html.includes('id="login-qr"'));
  assert.ok(intervals.some(entry => entry.ms === 3000), 'the panel polls every 3 s');
  assert.ok(calls.some(([method, path]) => method === 'GET' && path === '/api/login/status'));
  await new Promise(done => setImmediate(done)); // let the first poll paint
  const qr = nodes.get('login-qr').innerHTML;
  assert.ok(qr.includes('/api/login/qr.png?token='), 'the qr is same-origin and carries the read token');
  assert.ok(!/^https?:/m.test(qr.replace(/src="[^"]*"/g, '')), 'no external image origin');

  await actions.loginRefresh();
  const posted = calls.find(([method, path]) => method === 'POST' && path === '/api/login/qr');
  assert.ok(posted, 'refresh posts to the write route');
  assert.equal(posted[2], TOKEN, 'the write carries the header token');
  assert.ok(timeouts.includes(15000), 'the browser waits 15 s, longer than the 12 s server timeout');

  open = false;
  intervals[0].fn();
  await new Promise(done => setImmediate(done));
  assert.ok(cleared.includes(101), 'a closed panel stops its own timer');
});
