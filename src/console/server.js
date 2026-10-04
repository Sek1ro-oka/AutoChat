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
import {
  buildSummary, buildSessions, buildCharges, buildConfig, buildCost, buildCostTurns,
  buildPersonas, buildPersonaFile, buildSocial, buildSlang, buildSlangEntry,
  buildGroups, applyGroupPatch, buildStickers, buildStickerEntry,
} from './api.js';
import { readLogs } from './logs.js';
import { harden } from '../permissions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, 'public', 'index.html');
// Whitelisted shell assets. The page logic lives in its own files so none of
// them has to grow past the project's 400-line ceiling as pages are added.
// pages.js and pages-extra.js must be listed (and loaded) before app.js: they
// define the `pages` object that app.js's render() dispatches to.
const ASSETS = new Map([
  ['/pages.js', ['public/pages.js', 'text/javascript; charset=utf-8']],
  ['/pages-extra.js', ['public/pages-extra.js', 'text/javascript; charset=utf-8']],
  ['/pages-stickers.js', ['public/pages-stickers.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
]);
const TOKEN_HEADER = 'x-console-token';
const MAX_BODY_BYTES = 128 * 1024;
// A slang backup may legitimately hold the full 2000-entry library, which is far
// larger than any structured body the other endpoints accept.
const BODY_LIMITS = new Map([['/api/slang/import', 2 * 1024 * 1024], ['/api/stickers/upload', 8 * 1024 * 1024]]);
const bodyLimit = pathname => BODY_LIMITS.get(pathname) ?? MAX_BODY_BYTES;

// Persona failures are the only ones a client can cause, so they get real
// status codes instead of a blanket 500.
const ERROR_STATUS = new Map([
  ['PERSONA_NAME_INVALID', 400], ['PERSONA_CONTENT_INVALID', 400], ['PERSONA_CONTENT_EMPTY', 400],
  ['PERSONA_CONTENT_TOO_LARGE', 413], ['PERSONA_LIMIT', 409], ['PERSONA_NOT_FOUND', 404],
  ['PERSONA_UNAVAILABLE', 503], ['BODY_TOO_LARGE', 413], ['bad_json', 400],
  ['SOCIAL_UNAVAILABLE', 503], ['SOCIAL_PARAM_INVALID', 400],
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
    // A malicious page must not be able to frame the console: the write
    // endpoints accept same-origin requests, so an invisible iframe over a
    // logged-in browser would be a clickjacking path to the persona editor.
    // The page loads no external asset, so a deny-everything CSP costs nothing.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(payload);
}

// Cap the body so a stuck or hostile client cannot grow the process heap.
function readBody(req, max = MAX_BODY_BYTES) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createConsole({
  config, store, bot, transport, runtime, personas = null, social = null, slang = null, stickers = null, log = () => {},
  startedAt = Date.now(), host = '127.0.0.1', port = null, logDirectory = 'logs',
} = {}) {
  const token = resolveToken(config, log);
  const listenPort = port ?? config.consolePort ?? 3200;
  const now = () => Date.now();

  const requirePersonas = () => {
    if (!personas) throw new Error('PERSONA_UNAVAILABLE');
    return personas;
  };
  const requireSocial = () => {
    if (!social) throw new Error('SOCIAL_UNAVAILABLE');
    return social;
  };
  const requireSlang = () => {
    if (!slang) throw new Error('SLANG_UNAVAILABLE');
    return slang;
  };
  const requireStickers = () => {
    if (!stickers) throw new Error('STICKER_UNAVAILABLE');
    return stickers;
  };

  const reads = {
    '/api/summary': () => buildSummary({ config, store, bot, transport, runtime, now: now(), startedAt }),
    '/api/sessions': (url) => buildSessions({ store, limit: Number(url.searchParams.get('limit')) || 200 }),
    '/api/charges': (url) => buildCharges({ store, days: Number(url.searchParams.get('days')) || 30 }),
    '/api/logs': (url) => ({ logs: readLogs(logDirectory, Number(url.searchParams.get('limit')) || 120) }),
    '/api/config': () => buildConfig({ config }),
    '/api/cost': (url) => buildCost({ config, store, range: url.searchParams.get('range') ?? '24h', now: now() }),
    '/api/cost/turns': (url) => buildCostTurns({
      config, store, session: url.searchParams.get('session') ?? '',
      limit: Number(url.searchParams.get('limit')) || 100,
    }),
    '/api/personas': () => buildPersonas({ personas }),
    '/api/personas/file': (url) => buildPersonaFile({
      personas, kind: url.searchParams.get('kind') === 'behavior' ? 'behavior' : 'card',
      name: url.searchParams.get('name') ?? '',
    }),
    '/api/social': () => buildSocial({ social, now: now() }),
    '/api/groups': () => buildGroups({ config, personas, social, slang, now: now() }),
    '/api/slang': () => buildSlang({ slang }),
    '/api/slang/entry': (url) => buildSlangEntry({ slang: requireSlang(), id: url.searchParams.get('id') ?? '' }),
    '/api/stickers': () => buildStickers({ stickers }),
    '/api/stickers/entry': (url) => buildStickerEntry({ stickers: requireStickers(), id: url.searchParams.get('id') ?? '' }),
    // The backup is served as a plain JSON document so the browser can save it
    // with one click; restoring goes through the write route below.
    '/api/slang/export': () => requireSlang().exportAll(),
  };

  // Every write returns the freshly described persona state so the page can
  // re-render from one response instead of chaining a follow-up GET.
  const writes = {
    '/api/personas/file': (url, body) => {
      const target = requirePersonas();
      if (body?.kind === 'behavior') return { restart: true, ...target.saveBehavior(body?.content), ...buildPersonas({ personas }) };
      return { saved: target.save(body?.name, body?.content), ...buildPersonas({ personas }) };
    },
    '/api/personas/delete': (url, body) => {
      const target = requirePersonas();
      return { deleted: target.remove(body?.name), ...buildPersonas({ personas }) };
    },
    '/api/personas/active': (url, body) => {
      const target = requirePersonas();
      return { active: target.setActive(body?.name ?? ''), ...buildPersonas({ personas }) };
    },
    '/api/social/config': (url, body) => requireSocial().setParams(body ?? {}),
    // Per-group specialisation: one endpoint, routed by `subsystem`, so the page
    // has a single save path for persona / social / slang / reset.
    '/api/groups/config': (url, body) => {
      applyGroupPatch({ personas, social, slang, store, group: body?.group, patch: body ?? {} });
      return buildGroups({ config, personas, social, slang, now: now() });
    },
    // Slang review (Phase 4). Every write returns the re-described library, so
    // the page re-renders from one response instead of chaining a read.
    '/api/slang/config': (url, body) => requireSlang().setParams(body ?? {}),
    '/api/slang/extract': (url, body) => requireSlang().extract({ group: body?.group ?? null }).then(result => ({ result, ...requireSlang().describe() })),
    '/api/slang/status': (url, body) => requireSlang().setStatus(body?.id, body?.status),
    '/api/slang/entry': (url, body) => requireSlang().edit(body?.id, body ?? {}),
    '/api/slang/scopes': (url, body) => requireSlang().setScopes(body?.id, body?.groups),
    '/api/slang/delete': (url, body) => requireSlang().remove(body?.id),
    '/api/slang/lookup': (url, body) => requireSlang().lookup(body?.id),
    '/api/slang/import': (url, body) => requireSlang().importAll(body?.text),
    // Sticker library (Phase 6). Every write re-describes the library, so the
    // page re-renders from one response instead of chaining a read.
    '/api/stickers/config': (url, body) => requireStickers().setParams(body ?? {}),
    '/api/stickers/status': (url, body) => requireStickers().setStatus(body?.id, body?.status),
    '/api/stickers/entry': (url, body) => requireStickers().edit(body?.id, body ?? {}),
    '/api/stickers/delete': (url, body) => requireStickers().remove(body?.id),
    '/api/stickers/upload': (url, body) => requireStickers().upload(body ?? {}),
  };

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
      send(res, ERROR_STATUS.get(code) ?? 500, { error: ERROR_STATUS.has(code) ? code : 'internal' });
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
