// Console transport and authentication: the token gate, the framing/CSP headers,
// the loopback bind and the shell page (I-08: split out of the 587-line file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, auth, fixture } from './support/console-harness.js';

test('every api route requires the console token', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/summary', '/api/sessions', '/api/charges', '/api/logs', '/api/config',
    '/api/cost', '/api/cost/turns', '/api/personas', '/api/personas/file', '/api/social',
    '/api/settings', '/api/slang', '/api/slang/entry', '/api/slang/export']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/summary?token=wrong`)).status, 401);
  assert.equal((await fetch(`${base}/api/summary`, { headers: { 'x-console-token': 'wrong' } })).status, 401);
});

test('responses refuse to be framed and carry no external origin', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  // The write endpoints accept same-origin requests, so a third-party page that
  // could frame the console would have a clickjacking path into the persona and
  // slang editors. Both the legacy header and the CSP directive are sent.
  for (const path of ['/', '/app.js', '/api/summary?token=' + TOKEN]) {
    const response = await fetch(base + path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /base-uri 'none'/, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('a valid token returns data through header and query string', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const header = await fetch(`${base}/api/summary`, { headers: auth });
  assert.equal(header.status, 200);
  const summary = await header.json();
  assert.equal(summary.budget.limitMicro, 1000000);
  assert.equal(summary.connection.ready, true);
  assert.equal(summary.participants[0].name, 'core');
  assert.equal((await fetch(`${base}/api/sessions?token=${TOKEN}`)).status, 200);
});

test('unknown api routes 404 and the shell page needs no token', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/nope`, { headers: auth })).status, 404);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /AutoChat 控制台/);
  for (const page of ['social', 'slang', 'stickers', 'settings']) assert.match(html, new RegExp(`data-page="${page}"`), `${page} is reachable from the nav`);
  // Load order matters: pages.js defines the `pages` object, pages-extra.js,
  // pages-stickers.js and pages-settings.js add their pages to it, and app.js
  // renders the result.
  assert.match(html, /<script src="pages\.js"><\/script>\s*<script src="pages-extra\.js"><\/script>\s*<script src="pages-stickers\.js"><\/script>\s*<script src="pages-settings\.js"><\/script>\s*<script src="app\.js"><\/script>/);
  // The script assets are served without a token: they are code, not data, and
  // the browser cannot attach a header to its own <script> fetch.
  for (const asset of ['app.js', 'pages.js', 'pages-extra.js', 'pages-stickers.js', 'pages-settings.js']) {
    const served = await fetch(`${base}/${asset}`);
    assert.equal(served.status, 200, asset);
    assert.match(served.headers.get('content-type'), /javascript/, asset);
  }
  assert.match(await (await fetch(`${base}/app.js`)).text(), /autochat\.console\.token/);
  assert.match(await (await fetch(`${base}/pages.js`)).text(), /async overview\(\)/);
  assert.match(await (await fetch(`${base}/pages-extra.js`)).text(), /async slang\(\)/);
  assert.match(await (await fetch(`${base}/pages-stickers.js`)).text(), /async stickers\(\)/);
  assert.match(await (await fetch(`${base}/pages-settings.js`)).text(), /async settings\(\)/);
  assert.equal((await fetch(`${base}/../src/config.js`)).status, 404, 'no path traversal out of public/');
  assert.equal((await fetch(`${base}/app.js.bak`)).status, 404);
});

test('credentials never appear in console responses', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const text = await (await fetch(`${base}/api/config`, { headers: auth })).text();
  for (const secret of ['sk-supersecret-key', 'onebot-supersecret', TOKEN]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.match(text, /sk-s••••ey/);
});

test('the console binds loopback only', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  assert.equal(server.address().address, '127.0.0.1');
});

