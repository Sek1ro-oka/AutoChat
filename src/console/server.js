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
  buildPersonas, buildPersonaFile,
} from './api.js';
import { readLogs } from './logs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, 'public', 'index.html');
const TOKEN_HEADER = 'x-console-token';
const MAX_BODY_BYTES = 128 * 1024;

// Persona failures are the only ones a client can cause, so they get real
// status codes instead of a blanket 500.
const ERROR_STATUS = new Map([
  ['PERSONA_NAME_INVALID', 400], ['PERSONA_CONTENT_INVALID', 400], ['PERSONA_CONTENT_EMPTY', 400],
  ['PERSONA_CONTENT_TOO_LARGE', 413], ['PERSONA_LIMIT', 409], ['PERSONA_NOT_FOUND', 404],
  ['PERSONA_UNAVAILABLE', 503], ['BODY_TOO_LARGE', 413], ['bad_json', 400],
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
    if (existing.length >= 16) return existing;
  } catch { /* first run */ }
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch { /* non-fatal: the token still works for this process */ }
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
  });
  res.end(payload);
}

// Cap the body so a stuck or hostile client cannot grow the process heap.
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createConsole({
  config, store, bot, transport, runtime, personas = null, log = () => {},
  startedAt = Date.now(), host = '127.0.0.1', port = null, logDirectory = 'logs',
} = {}) {
  const token = resolveToken(config, log);
  const listenPort = port ?? config.consolePort ?? 3200;
  const now = () => Date.now();

  const requirePersonas = () => {
    if (!personas) throw new Error('PERSONA_UNAVAILABLE');
    return personas;
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
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const { pathname } = url;
    if (pathname === '/' || pathname === '/index.html') {
      try { send(res, 200, readFileSync(INDEX_PATH, 'utf8'), 'text/html; charset=utf-8'); }
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
    if (!route) { send(res, 404, { error: 'not_found' }); return; }
    try {
      let body = null;
      if (writing) {
        const raw = await readBody(req);
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
