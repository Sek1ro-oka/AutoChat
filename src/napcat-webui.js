// NapCat WebUI client for the console login panel (I-10 / T-016).
//
// The browser never talks to the WebUI port itself: the page cannot reach that
// origin (CSP `connect-src 'self'`) and the WebUI token must not be shipped to a
// browser at all. Every call below goes through the console server, and the
// token plus the Credential stay in this process's memory: they never appear in
// a response, a log line or an error message.
//
// Three upstream facts shape this file (verified against the installed
// v4.18.28 release by scripts/napcat-login.js):
//   - /api/* answers HTTP 200 even when it failed; the verdict is `body.code`
//     (0 = ok, -1 = failed), so judging by `response.ok` always "succeeds";
//   - the Credential expires after about an hour and dies with every NapCat
//     restart, hence the cache, the one-shot re-login and the single flight;
//   - RefreshQRcode polls for up to 10 s inside NapCat, so the socket timeout
//     has to sit above that or a slow refresh looks like a dead process.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_WORKDIR = 'runtime/napcat';
// The WebUI limiter allows 3 logins per minute, so one attempt per second is the
// tightest spacing that cannot trip it.
export const MIN_LOGIN_GAP_MS = 1000;
// The panel polls every 3 s; this only collapses several open tabs into one call.
export const STATUS_TTL_MS = 1000;

// Stable codes only. The raw upstream body never leaves this module: `code: -1`
// plus a message is turned into one of these, so nothing NapCat says can reach
// the browser unchecked.
const FAIL = {
  disabled: 'WEBUI_DISABLED',      // no readable config/webui.json
  unreachable: 'WEBUI_UNREACHABLE', // refused, reset, timed out, not NapCat
  auth: 'WEBUI_AUTH_FAILED',       // the token in webui.json was refused
  twoFactor: 'WEBUI_2FA_REQUIRED', // require2FA, nothing we can do from here
  request: 'WEBUI_REQUEST_FAILED', // code -1 twice, reason unknown
  online: 'LOGIN_ALREADY_ONLINE',
  refreshTimeout: 'QR_REFRESH_TIMEOUT',
  refreshFailed: 'QR_REFRESH_FAILED',
  expired: 'QR_EXPIRED',
  restarting: 'QR_RESTARTING',
};

const PHASES = new Set(['offline', 'generating_qrcode', 'waiting_qrcode', 'qrcode_scanned',
  'initializing', 'ready', 'reconnecting']);

// The three failures NapCat answers with code 0-free prose. Everything else is
// treated as a possibly dead Credential and retried once after a fresh login.
const businessCode = message => {
  const text = String(message ?? '');
  if (/is\s*logined/i.test(text)) return FAIL.online;
  if (text.includes('超时')) return FAIL.refreshTimeout;
  if (text.includes('过期')) return FAIL.expired;
  return '';
};

const loopbackHost = value => (value === 'localhost' || value === '::1' || value === '[::1]' ? value : '127.0.0.1');

export function createNapCatWebui({
  workdir = DEFAULT_WORKDIR,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  statusTtlMs = STATUS_TTL_MS,
  minLoginGapMs = MIN_LOGIN_GAP_MS,
  authTimeoutMs = 4000,
  statusTimeoutMs = 4000,
  refreshTimeoutMs = 12000,
} = {}) {
  const configPath = join(workdir, 'config', 'webui.json');
  const qrPath = join(workdir, 'cache', 'qrcode.png');

  let credential = '';       // in memory only, never serialised
  let credentialAt = 0;
  let loginFlight = null;    // single flight: concurrent callers await one login
  let lastAttemptAt = -Infinity;
  let cached = null;         // { at, value } for status()
  let statusFlight = null;

  // A bad file is "not configured", not a crash: the panel says "disabled".
  const readConfig = () => {
    let raw;
    try { raw = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; }
    const port = Number(raw?.port);
    const token = typeof raw?.token === 'string' ? raw.token : '';
    if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: loopbackHost(raw?.host), port, token };
  };

  const hashOf = value => createHash('sha256').update(`${value}.napcat`).digest('hex');

  // One POST to the WebUI. Every failure mode here means "we cannot talk to
  // NapCat"; the reason is deliberately not propagated (it can quote the body).
  const request = async (cfg, path, payload, timeoutMs, ticket = '') => {
    const headers = { 'Content-Type': 'application/json' };
    if (ticket) headers.Authorization = `Bearer ${ticket}`;
    let response;
    try {
      response = await fetchImpl(`http://${cfg.host}:${cfg.port}${path}`, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(FAIL.unreachable);
    }
    if (!response.ok) throw new Error(FAIL.unreachable);
    let body;
    try { body = await response.json(); } catch { throw new Error(FAIL.unreachable); }
    if (!body || typeof body !== 'object') throw new Error(FAIL.unreachable);
    return body;
  };

  const login = cfg => {
    if (credential && now() - credentialAt < 55 * 60 * 1000) return Promise.resolve(credential);
    if (loginFlight) return loginFlight;
    loginFlight = (async () => {
      const wait = minLoginGapMs - (now() - lastAttemptAt);
      if (wait > 0) await sleep(wait);
      lastAttemptAt = now();
      const body = await request(cfg, '/api/auth/login', { hash: hashOf(cfg.token) }, authTimeoutMs);
      const data = Number(body.code) === 0 && body.data && typeof body.data === 'object' ? body.data : null;
      if (data?.require2FA === true) throw new Error(FAIL.twoFactor);
      const ticket = data && typeof data.Credential === 'string' ? data.Credential : '';
      if (!ticket) { credential = ''; throw new Error(FAIL.auth); }
      credential = ticket;
      credentialAt = now();
      return ticket;
    })();
    const settle = () => { loginFlight = null; };
    loginFlight.then(settle, settle);
    return loginFlight;
  };

  // Authenticated call: on an unexplained `code: -1` the Credential is assumed
  // dead (NapCat restarted), so it is dropped and the call retried exactly once.
  const call = async (cfg, path, payload, timeoutMs) => {
    const first = await request(cfg, path, payload, timeoutMs, await login(cfg));
    if (Number(first.code) === 0) return first.data && typeof first.data === 'object' ? first.data : {};
    const known = businessCode(first.message);
    if (known) throw new Error(known);
    credential = '';
    const second = await request(cfg, path, payload, timeoutMs, await login(cfg));
    if (Number(second.code) === 0) return second.data && typeof second.data === 'object' ? second.data : {};
    throw new Error(businessCode(second.message) || FAIL.request);
  };

  // Already logged in? Both halves matter: `loginPhase` alone says "ready" while
  // the account is still offline, and `isLogin` alone is only what NapCat folded
  // together upstream. The raw `selfInfo.online` is required when it is present.
  const isOnline = data => {
    if (data?.isLogin !== true) return false;
    if (data?.selfInfo && typeof data.selfInfo === 'object') return data.selfInfo.online === true;
    return true;
  };

  const stateOf = data => {
    if (isOnline(data)) return 'online';
    const phase = String(data?.loginPhase ?? '');
    if (data?.qrLoginAccepted === true || phase === 'qrcode_scanned') return 'scanned';
    if (phase === 'waiting_qrcode' || phase === 'generating_qrcode') return 'waiting';
    // The scan was accepted; NapCat is booting the core towards `online`.
    if (phase === 'initializing') return 'scanned';
    return 'idle';
  };

  const qrAt = () => {
    try { return Math.round(statSync(qrPath).mtimeMs); } catch { return 0; }
  };

  const uinOf = data => {
    for (const value of [data?.uin, data?.qq, data?.userId, data?.user_id]) {
      const digits = String(value ?? '').replace(/\D/g, '');
      if (digits) return digits;
    }
    return '';
  };

  const readStatus = async () => {
    const cfg = readConfig();
    if (!cfg) return { state: 'disabled', online: false, qrAt: 0 };
    let data;
    try {
      data = await call(cfg, '/api/QQLogin/CheckLoginStatus', {}, statusTimeoutMs);
    } catch (error) {
      const code = String(error?.message ?? '');
      if (code === FAIL.unreachable) return { state: 'unreachable', online: false, qrAt: 0 };
      return { state: 'error', online: false, qrAt: 0, error: code || FAIL.request };
    }
    const state = stateOf(data);
    const view = { state, online: state === 'online', qrAt: qrAt() };
    const phase = String(data?.loginPhase ?? '');
    if (PHASES.has(phase)) view.phase = phase;
    if (String(data?.loginError ?? '').includes('过期')) view.expired = true;
    if (view.online) {
      // Decoration only: a failed lookup must not turn a healthy login into an
      // error, so the number is dropped instead of the state.
      try {
        const uin = uinOf(await call(cfg, '/api/QQLogin/GetQQLoginInfo', {}, statusTimeoutMs));
        if (uin) view.uin = uin;
      } catch { /* keep the online verdict */ }
    }
    return view;
  };

  return {
    // Never throws: the panel has a state for every outcome.
    status() {
      if (cached && now() - cached.at < statusTtlMs) return Promise.resolve(cached.value);
      if (statusFlight) return statusFlight;
      statusFlight = readStatus().then(value => {
        cached = { at: now(), value };
        return value;
      });
      const settle = () => { statusFlight = null; };
      statusFlight.then(settle, settle);
      return statusFlight;
    },
    // Throws a stable code; the console maps it to a status and the page to text.
    async refresh() {
      const cfg = readConfig();
      if (!cfg) throw new Error(FAIL.disabled);
      cached = null;
      const data = await call(cfg, '/api/QQLogin/RefreshQRcode', {}, refreshTimeoutMs);
      const url = typeof data?.qrcodeurl === 'string' ? data.qrcodeurl : '';
      if (!url) {
        // `restarting: true`: NapCat is relaunching its login core and the next
        // code arrives on its own, so this is a wait, not a failure to fix.
        if (data?.restarting === true) return { ok: false, restarting: true, state: 'idle', error: FAIL.restarting };
        throw new Error(FAIL.refreshFailed);
      }
      // The QR text itself is a login URL for the QQ account: never forwarded.
      return { ok: true, state: 'waiting', qrAt: qrAt() };
    },
    // The PNG NapCat writes next to its config. Null means "no code on disk".
    png() {
      try { return readFileSync(qrPath); } catch { return null; }
    },
  };
}
