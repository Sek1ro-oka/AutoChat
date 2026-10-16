// Request-body ceiling (I-07 / D-26). The 413 path was unreachable: `readBody`
// called `req.destroy()` on overflow, so the response never left the process and
// the client saw `TypeError: fetch failed` with `ECONNRESET` instead of a status.
// These tests talk to a real listening socket on 127.0.0.1 — the only way to see
// what a client actually receives — and they cover both sides of the boundary:
// over the 128 KiB default, just under it, and over it on a route with a larger
// per-route limit (`/api/slang/import`, 2 MiB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN, auth, fixture, slangFixture } from './support/console-harness.js';

const DEFAULT_LIMIT = 128 * 1024;

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body,
});

test('a body over 128 KiB is answered with 413 and the JSON error, not a reset', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const body = JSON.stringify({ name: 'botName', value: 'x'.repeat(200 * 1024) });
  assert.ok(Buffer.byteLength(body) > DEFAULT_LIMIT, 'fixture body must exceed the default limit');

  const response = await post(base, '/api/settings', body);
  // Read the body before anything else: a reset connection fails right here.
  const payload = await response.json();
  assert.equal(response.status, 413);
  assert.deepEqual(payload, { error: 'BODY_TOO_LARGE' });
  // The request body was never consumed, so the connection cannot be reused.
  assert.equal(response.headers.get('connection'), 'close');

  // The overflow must not take the process or the listener down with it.
  const after = await post(base, '/api/settings', JSON.stringify({ name: 'botName', value: 'ok' }));
  assert.equal(after.status, 200);
});

test('a body just under the limit still reaches the route', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  // The padding keeps the body under the cap while the real edit is small, so a
  // 200 here also proves the ceiling itself was not quietly tightened.
  const body = JSON.stringify({ name: 'botName', value: '小助手', pad: 'x'.repeat(127 * 1024) });
  assert.ok(Buffer.byteLength(body) < DEFAULT_LIMIT, 'fixture body must stay under the default limit');

  const response = await post(base, '/api/settings', body);
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.equal(settings.fields.find(field => field.name === 'botName').value, '小助手');
});

test('a route with a larger body limit still accepts a body over the default', async t => {
  const { server } = slangFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  // A full slang backup legitimately exceeds 128 KiB (`/api/slang/import` allows
  // 2 MiB); the 413 fix must not have flattened the per-route limits.
  const entries = Array.from({ length: 4000 }, (_, i) => ({ content: `term${i}`, meaning: `意思${i}` }));
  const body = JSON.stringify({ text: JSON.stringify(entries) });
  assert.ok(Buffer.byteLength(body) > DEFAULT_LIMIT, 'fixture body must exceed the default limit');

  const response = await post(base, '/api/slang/import', body);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.entries.length > 0, 'the import returns the re-described library');
});

test('a malformed body under the limit is still a 400, and auth is unchanged', async t => {
  const { server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const malformed = await post(base, '/api/settings', '{ not json');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'bad_json' });

  // D-26 changed the read path only: the token gate still answers first.
  const unauthenticated = await fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await fetch(`${base}/api/settings?token=${TOKEN}`)).status, 200);
});
