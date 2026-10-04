// Local read-only console.
//
// Security posture (see docs/console.md):
//   - binds 127.0.0.1 only, never 0.0.0.0;
//   - every /api/* request needs the console token (header or ?token=);
//   - the token is auto-generated on first run and stored in runtime/console-token.txt;
//   - credentials are masked in every response (see api.js `redact`).

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSummary, buildSessions, buildCharges, buildConfig } from './api.js';
import { readLogs } from './logs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, 'public', 'index.html');
const TOKEN_HEADER = 'x-console-token';

const equal = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
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
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

export function createConsole({
  config, store, bot, transport, runtime, log = () => {},
  startedAt = Date.now(), host = '127.0.0.1', port = null, logDirectory = 'logs',
} = {}) {
  const token = resolveToken(config, log);
  const listenPort = port ?? config.consolePort ?? 3200;
  const now = () => Date.now();

  const routes = {
    '/api/summary': (url) => buildSummary({
      config, store, bot, transport, runtime, now: now(), startedAt,
    }),
    '/api/sessions': (url) => buildSessions({ store, limit: Number(url.searchParams.get('limit')) || 200 }),
    '/api/charges': (url) => buildCharges({ store, days: Number(url.searchParams.get('days')) || 30 }),
    '/api/logs': (url) => ({ logs: readLogs(logDirectory, Number(url.searchParams.get('limit')) || 120) }),
    '/api/config': () => buildConfig({ config }),
  };

  const handle = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const { pathname } = url;
    if (pathname === '/' || pathname === '/index.html') {
      try { send(res, 200, readFileSync(INDEX_PATH, 'utf8'), 'text/html; charset=utf-8'); }
      catch { send(res, 500, { error: 'console_assets_missing' }); }
      return;
    }
    if (!pathname.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
    const header = req.headers[TOKEN_HEADER];
    const query = url.searchParams.get('token');
    const authed = (typeof header === 'string' && equal(header, token)) || (query !== null && equal(query, token));
    if (!authed) { send(res, 401, { error: 'unauthorized' }); return; }
    const route = routes[pathname];
    if (!route) { send(res, 404, { error: 'not_found' }); return; }
    try { send(res, 200, route(url)); }
    catch { send(res, 500, { error: 'internal' }); }
  };

  const server = createServer((req, res) => {
    try { handle(req, res); }
    catch { send(res, 500, { error: 'internal' }); }
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
