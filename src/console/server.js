// Local console.
//
// Security posture (see docs/console.md):
//   - binds 127.0.0.1 only, never 0.0.0.0;
//   - every /api/* request needs the console token (header or ?token=);
//   - writes go further: the token must arrive in the header, and a present
//     `Origin` must be loopback. A cross-site page can neither set a custom
//     header on a simple request nor pass the CORS preflight we never answer,
//     so the persona editor is not reachable by CSRF;
//   - the token is auto-generated on first run and stored in runtime/console-token.txt;
//   - credentials are masked in every response (see api.js `redact`).

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServiceApi } from './api.js';
import { createRoutes } from './routes.js';
import { harden } from '../permissions.js';
import { createNapCatWebui } from '../napcat-webui.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, 'public', 'index.html');
// Whitelisted shell assets: page logic lives in its own files so none of them has
// to grow past the 400-line ceiling. core.js defines the helpers (and `pages`);
// the page scripts must be listed and loaded before app.js, which owns the one
// click/change listener that renders whatever page is open.
const JS = 'text/javascript; charset=utf-8';
const ASSETS = new Map([
  ['/console.css', ['public/console.css', 'text/css; charset=utf-8']], ['/core.js', ['public/core.js', JS]],
  ['/pages-overview.js', ['public/pages-overview.js', JS]], ['/pages-model.js', ['public/pages-model.js', JS]],
  ['/pages-personas.js', ['public/pages-personas.js', JS]], ['/pages-groups.js', ['public/pages-groups.js', JS]],
  ['/pages-activity.js', ['public/pages-activity.js', JS]], ['/pages-qzone.js', ['public/pages-qzone.js', JS]],
  ['/pages-assets.js', ['public/pages-assets.js', JS]], ['/assets-stickers.js', ['public/assets-stickers.js', JS]],
  ['/assets-slang.js', ['public/assets-slang.js', JS]], ['/pages-cost.js', ['public/pages-cost.js', JS]],
  ['/pages-logs.js', ['public/pages-logs.js', JS]], ['/pages-settings.js', ['public/pages-settings.js', JS]],
  ['/app.js', ['public/app.js', JS]],
]);
const TOKEN_HEADER = 'x-console-token';
const MAX_BODY_BYTES = 128 * 1024;
// A slang backup may hold the full 2000-entry library: bigger than any other body.
const BODY_LIMITS = new Map([['/api/slang/import', 2 * 1024 * 1024], ['/api/stickers/upload', 8 * 1024 * 1024]]);
const bodyLimit = pathname => BODY_LIMITS.get(pathname) ?? MAX_BODY_BYTES;

// Client-caused failures get real status codes instead of a blanket 500.
const ERROR_STATUS = new Map([
  ['PERSONA_NAME_INVALID', 400], ['PERSONA_CONTENT_INVALID', 400], ['PERSONA_CONTENT_EMPTY', 400],
  ['PERSONA_CONTENT_TOO_LARGE', 413], ['PERSONA_LIMIT', 409], ['PERSONA_NOT_FOUND', 404],
  ['PERSONA_UNAVAILABLE', 503], ['BODY_TOO_LARGE', 413], ['bad_json', 400],
  ['SOCIAL_UNAVAILABLE', 503], ['SOCIAL_PARAM_INVALID', 400],
  // A group-scoped patch that could not write anything (the idle fields are
  // global-only): without it the operator sees a 500 instead of the reason (I-01).
  ['SOCIAL_PARAM_NOT_GROUP_SCOPED', 400],
  // The slang library: 4xx for what the operator can fix, 502 for upstream.
  ['SLANG_UNAVAILABLE', 503], ['SLANG_PARAM_INVALID', 400], ['SLANG_NOT_FOUND', 404],
  ['SLANG_DISABLED', 409], ['SLANG_BUDGET_BLOCKED', 409], ['SLANG_SEARCH_DISABLED', 409],
  ['SLANG_SEARCH_LIMIT', 429], ['SLANG_IMPORT_INVALID', 400],
  ['SLANG_MODEL_FAILED', 502], ['SLANG_EXTRACT_UNPARSABLE', 502],
  ['SLANG_LOOKUP_UNVERIFIED', 502], ['SLANG_LOOKUP_EMPTY', 502],
  // Per-group specialisation: 4xx for what the operator can fix.
  ['GROUP_PARAM_INVALID', 400], ['GROUP_NOT_FOUND', 404],
  // The sticker library: 4xx for what the operator can fix.
  ['STICKER_UNAVAILABLE', 503], ['STICKER_PARAM_INVALID', 400], ['STICKER_NOT_FOUND', 404],
  ['STICKER_UPLOAD_INVALID', 400],
  // Runtime settings: 4xx for what the operator can fix.
  ['CONFIG_PARAM_INVALID', 400],
  // Console login (I-10): 503 while NapCat is unusable, 4xx/409 for fixable input, 502 refused.
  ['WEBUI_DISABLED', 503], ['WEBUI_UNREACHABLE', 503], ['WEBUI_REQUEST_FAILED', 502],
  ['WEBUI_AUTH_FAILED', 502], ['WEBUI_2FA_REQUIRED', 409], ['LOGIN_ALREADY_ONLINE', 409],
  ['QR_REFRESH_FAILED', 502], ['QR_REFRESH_TIMEOUT', 504], ['QR_EXPIRED', 409],
  ['QR_NOT_FOUND', 404],
  // QQ Zone (I-09): 4xx for fixable input, 502/503/504 for the protocol side.
  ['QZONE_POST_NOT_FOUND', 404], ['QZONE_POST_ALREADY_DELETED', 409], ['QZONE_POST_NO_TID', 409],
  ['QZONE_DELETE_UNAVAILABLE', 503], ['QZONE_DELETE_TIMEOUT', 504], ['QZONE_DELETE_REJECTED', 502], ['QZONE_DELETE_FAILED', 502],
  // Service control (T-019): 409 when nobody would bring the bot back, so a click
  // can never turn into a silent shutdown.
  ['SERVICE_NOT_MANAGED', 409], ['SERVICE_ACTION_INVALID', 400],
]);

const equal = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

const isLoopbackOrigin = origin => {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
};

function resolveToken(config, log) {
  if (config.consoleToken) return config.consoleToken;
  const file = resolve('runtime/console-token.txt');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) {
      // A file written before the DACL step existed is still world-readable:
      // `mode: 0o600` is a no-op on Windows. Tighten on every start, not just
      // on creation, so an upgrade repairs the old file in place.
      harden(file, { log, label: 'console-token' });
      return existing;
    }
  } catch { /* first run */ }
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch { /* non-fatal: the token still works for this process */ }
  harden(file, { log, label: 'console-token' });
  log('console_token_created');
  return token;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  if (res.writableEnded) return;
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // A malicious page must not frame the console: the write endpoints accept
    // same-origin requests, so an invisible iframe would be a clickjacking path
    // into the editors. The shell has no inline <script>, no on* handler and no
    // style="" (all delegated through data-act / data-page), so script-src and
    // style-src 'self' are the load-bearing part; sticker thumbnails are
    // same-origin images behind ?token=, hence img-src 'self'.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; " +
      "img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(payload);
}

// A request whose body was never read to the end leaves the connection unusable
// for a second request, so drain it and only then drop the socket: closing one
// with unread data in its buffer makes the stack reply with RST, which throws
// away the response we just flushed — the very ECONNRESET this fix removes
// (I-07 / D-26). `readBody` drops every chunk after the overflow, so nothing is
// buffered while draining.
function closeAfterOverflow(req) {
  const drop = () => req.destroy();
  req.on('error', drop);
  req.on('end', drop);
  req.resume();
}

// Cap the body so a stuck or hostile client cannot grow the process heap.
function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', chunk => {
      if (overflowed) return;
      size += chunk.length;
      if (size > max) {
        // Stop consuming instead of `req.destroy()`: the socket has to stay
        // alive long enough for the 413 to be flushed, otherwise the client only
        // ever sees ECONNRESET (I-07 / D-26). The overflowing chunk is dropped,
        // so the heap stays bounded by `max` plus one chunk.
        overflowed = true;
        req.pause();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createConsole({
  config, store, bot, transport, runtime, personas = null, social = null, slang = null, stickers = null, webui = null,
  log = () => {},
  startedAt = Date.now(), host = '127.0.0.1', port = null, logDirectory = 'logs',
  // The console may ask this process to exit (T-019); both hooks are injectable so
  // a test never has to kill the test process.
  exit = code => process.exit(code), schedule = setTimeout,
} = {}) {
  const token = resolveToken(config, log);
  const listenPort = port ?? config.consolePort ?? 3200;
  const now = () => Date.now();
  // The console proxies the NapCat WebUI so the browser never learns the WebUI
  // token and never has to reach the WebUI port itself (I-10).
  const login = webui ?? createNapCatWebui();
  // Start/stop from the console: answer first, exit afterwards, and only when the
  // injected supervisor flag says somebody would bring the bot back (see api.js).
  const service = createServiceApi({ startedAt, exit, schedule });

  const requireOf = (value, code) => () => {
    if (!value) throw new Error(code);
    return value;
  };
  const requirePersonas = requireOf(personas, 'PERSONA_UNAVAILABLE');
  const requireSocial = requireOf(social, 'SOCIAL_UNAVAILABLE');
  const requireSlang = requireOf(slang, 'SLANG_UNAVAILABLE');
  const requireStickers = requireOf(stickers, 'STICKER_UNAVAILABLE');

  // The endpoint tables live in routes.js: this file only owns the transport.
  const { reads, writes } = createRoutes({
    config, store, bot, transport, runtime, personas, social, slang, stickers,
    now, startedAt, logDirectory,
    requirePersonas, requireSocial, requireSlang, requireStickers, login, service,
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const { pathname } = url;
    if (pathname === '/' || pathname === '/index.html') {
      try { send(res, 200, readFileSync(INDEX_PATH, 'utf8'), 'text/html; charset=utf-8'); }
      catch { send(res, 500, { error: 'console_assets_missing' }); }
      return;
    }
    const asset = ASSETS.get(pathname);
    if (asset) {
      // No token here on purpose: this is static code, not data. Requiring one
      // would break the browser's own <script> fetch, which cannot set headers.
      try { send(res, 200, readFileSync(join(HERE, asset[0]), 'utf8'), asset[1]); }
      catch { send(res, 500, { error: 'console_assets_missing' }); }
      return;
    }
    if (!pathname.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
    const method = String(req.method ?? 'GET').toUpperCase();
    const writing = method === 'POST';
    if (method !== 'GET' && !writing) { send(res, 405, { error: 'method_not_allowed' }); return; }
    const header = req.headers[TOKEN_HEADER];
    const query = url.searchParams.get('token');
    const authed = (typeof header === 'string' && equal(header, token)) || (query !== null && equal(query, token));
    if (!authed) { send(res, 401, { error: 'unauthorized' }); return; }
    if (writing) {
      // Reads may carry the token in the URL (that is how the printed link
      // works). Writes must not: a URL can be replayed by any third party.
      if (typeof header !== 'string' || !equal(header, token)) { send(res, 403, { error: 'header_token_required' }); return; }
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== 'null' && !isLoopbackOrigin(origin)) {
        send(res, 403, { error: 'origin_rejected' }); return;
      }
    }
    const route = writing ? writes[pathname] : reads[pathname];
    // Sticker thumbnails are binary, not JSON; they are served after auth (an
    // <img> cannot set a header, so the page passes the token in the query).
    if (pathname === '/api/stickers/image' && !writing) {
      const img = stickers?.image(url.searchParams.get('id') ?? '');
      if (!img) { send(res, 404, { error: 'not_found' }); return; }
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(img.bytes);
      return;
    }
    // The login QR is the other binary: an <img> cannot set a header either, so it
    // sits behind the same ?token= read gate and is read from NapCat's workdir by
    // the proxy — never from the static whitelist above.
    if (pathname === '/api/login/qr.png' && !writing) {
      const png = login.png();
      if (!png) { send(res, 404, { error: 'QR_NOT_FOUND' }); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(png);
      return;
    }
    if (!route) { send(res, 404, { error: 'not_found' }); return; }
    try {
      let body = null;
      if (writing) {
        const raw = await readBody(req, bodyLimit(pathname));
        try { body = JSON.parse(raw || '{}'); } catch { throw new Error('bad_json'); }
      }
      send(res, 200, await route(url, body));
    } catch (error) {
      const code = String(error?.message ?? 'internal');
      if (code === 'BODY_TOO_LARGE') {
        // The request body was never read to the end, so this connection
        // cannot carry a second request: announce the close, and drop the
        // socket only after the response has been flushed. Destroying it any
        // earlier is what made the 413 unreachable (I-07 / D-26).
        res.setHeader('Connection', 'close');
        res.once('finish', () => closeAfterOverflow(req));
      }
      // A failure may carry a short, already-sanitised reason (a protocol message
      // such as ONEBOT_TIMEOUT). Only errors that set `detail` expose it, so the
      // shape of every other error body stays exactly `{ error }`.
      const body = { error: ERROR_STATUS.has(code) ? code : 'internal' };
      if (typeof error?.detail === 'string' && error.detail) body.detail = error.detail;
      send(res, ERROR_STATUS.get(code) ?? 500, body);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { error: 'internal' }));
  });

  return {
    token,
    server,
    address: () => server.address(),
    url: () => {
      const address = server.address();
      return address ? `http://${host}:${address.port}/?token=${encodeURIComponent(token)}` : null;
    },
    start() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => { log('console_started'); resolvePromise(server.address().port); });
      });
    },
    stop() {
      return new Promise(resolvePromise => {
        server.closeAllConnections?.();
        server.close(() => { log('console_stopped'); resolvePromise(); });
      });
    },
  };
}
