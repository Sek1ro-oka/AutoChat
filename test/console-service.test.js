// The console's service control plane (T-019): the read route tells the truth
// about supervision, and the two write routes answer *before* scheduling the exit
// through an injected hook, so no test ever kills the test process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/console/server.js';
import {
  EXIT_RESTART, EXIT_STOP, buildService, createServiceApi, requestServiceAction,
} from '../src/console/api.js';

const TOKEN = 'service-test-token-1234';
const auth = { 'x-console-token': TOKEN };
// The console asks for these two things and nothing else from the page shell.
const webui = { status: () => ({ configured: false }), refresh: () => ({ configured: false }), png: () => null };

function useEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function fixture(t, { managed = false, supervisorPid } = {}) {
  useEnv(t, {
    AUTOCHAT_SUPERVISED: managed ? '1' : undefined,
    AUTOCHAT_SUPERVISOR_PID: supervisorPid,
  });
  const exits = [];
  const scheduled = [];
  const server = createConsole({
    config: { consoleToken: TOKEN, consolePort: 0 },
    webui,
    exit: code => exits.push(code),
    schedule: (run, ms) => scheduled.push({ run, ms }),
  });
  await server.start();
  t.after(() => server.stop());
  return { server, exits, scheduled, base: `http://127.0.0.1:${server.address().port}` };
}

test('buildService derives the whole answer from the injected env', () => {
  assert.deepEqual(buildService({ env: {}, pid: 7, startedAt: 1000, now: 1500 }), {
    managed: false, pid: 7, supervisorPid: null, uptimeMs: 500, restartable: false,
  });
  assert.deepEqual(
    buildService({ env: { AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: '9' }, pid: 7, startedAt: 2000, now: 1000 }),
    { managed: true, pid: 7, supervisorPid: 9, uptimeMs: 0, restartable: true },
  );
  // A half-set flag never invents a supervisor pid.
  assert.equal(buildService({ env: { AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: 'nope' }, pid: 7 }).supervisorPid, null);
  assert.equal(buildService({ env: { AUTOCHAT_SUPERVISOR_PID: '9' }, pid: 7 }).managed, false);
});

test('requestServiceAction refuses an unmanaged bot before scheduling anything', () => {
  const calls = [];
  assert.throws(
    () => requestServiceAction({ action: 'restart', managed: false, exit: code => calls.push(code), schedule: () => calls.push('scheduled') }),
    /SERVICE_NOT_MANAGED/,
  );
  assert.deepEqual(calls, []);
  const scheduled = [];
  assert.deepEqual(requestServiceAction({
    action: 'stop', managed: true, exit: code => calls.push(code),
    schedule: (run, ms) => { scheduled.push(ms); run(); },
  }), { ok: true, action: 'stop' });
  assert.deepEqual(scheduled, [500]);
  assert.deepEqual(calls, [EXIT_STOP]);
  assert.throws(() => requestServiceAction({ action: 'reboot', managed: true, exit: () => {}, schedule: () => {} }), /SERVICE_ACTION_INVALID/);
});

test('createServiceApi binds one env and one exit hook', () => {
  const exits = [];
  const scheduled = [];
  const api = createServiceApi({
    env: { AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: '55' },
    pid: 11,
    startedAt: 5,
    exit: code => exits.push(code),
    schedule: (run, ms) => scheduled.push({ run, ms }),
  });
  assert.equal(api.read().managed, true);
  assert.equal(api.read().supervisorPid, 55);
  assert.equal(api.read().pid, 11);
  assert.deepEqual(api.restart(), { ok: true, action: 'restart' });
  assert.deepEqual(api.stop(), { ok: true, action: 'stop' });
  assert.deepEqual(scheduled.map(entry => entry.ms), [500, 500], 'a reply is always sent before the exit');
  assert.deepEqual(exits, [], 'nothing exits until the scheduled callback runs');
  for (const entry of scheduled) entry.run();
  assert.deepEqual(exits, [EXIT_RESTART, EXIT_STOP]);
});

test('GET /api/service is honest when nobody supervises the bot', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/service`, { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['managed', 'pid', 'restartable', 'supervisorPid', 'uptimeMs']);
  assert.equal(body.managed, false);
  assert.equal(body.restartable, false);
  assert.equal(body.pid, process.pid);
  assert.equal(body.supervisorPid, null);
  assert.ok(body.uptimeMs >= 0);
});

test('GET /api/service reports the supervisor it was started with', async t => {
  const f = await fixture(t, { managed: true, supervisorPid: '4321' });
  const body = await (await fetch(`${f.base}/api/service`, { headers: auth })).json();
  assert.equal(body.managed, true);
  assert.equal(body.restartable, true);
  assert.equal(body.supervisorPid, 4321);
});

test('GET /api/service still needs the console token', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.base}/api/service`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/service?token=wrong`)).status, 401);
});

test('an unmanaged restart is refused with 409 and the bot keeps serving', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/service/restart`, { method: 'POST', headers: auth });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'SERVICE_NOT_MANAGED' });
  assert.deepEqual(f.scheduled, [], 'a refused restart never schedules an exit');
  assert.deepEqual(f.exits, []);
  assert.equal((await fetch(`${f.base}/api/service`, { headers: auth })).status, 200, 'the bot is still up');
  const stop = await fetch(`${f.base}/api/service/stop`, { method: 'POST', headers: auth });
  assert.equal(stop.status, 409);
  assert.deepEqual(await stop.json(), { error: 'SERVICE_NOT_MANAGED' });
});

test('a managed restart replies first, then exits with 75', async t => {
  const f = await fixture(t, { managed: true, supervisorPid: '4321' });
  const response = await fetch(`${f.base}/api/service/restart`, { method: 'POST', headers: auth });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, action: 'restart' });
  assert.deepEqual(f.exits, [], 'the receipt exists before anything exits');
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].ms, 500);
  f.scheduled[0].run();
  assert.deepEqual(f.exits, [EXIT_RESTART]);
});

test('a managed stop replies first, then exits with 0', async t => {
  const f = await fixture(t, { managed: true, supervisorPid: '4321' });
  const response = await fetch(`${f.base}/api/service/stop`, { method: 'POST', headers: auth });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, action: 'stop' });
  assert.deepEqual(f.exits, []);
  f.scheduled[0].run();
  assert.deepEqual(f.exits, [EXIT_STOP]);
});

test('the new write routes keep the header-token and loopback-origin gate', async t => {
  const f = await fixture(t, { managed: true });
  const noHeader = await fetch(`${f.base}/api/service/restart?token=${TOKEN}`, { method: 'POST' });
  assert.equal(noHeader.status, 403);
  assert.deepEqual(await noHeader.json(), { error: 'header_token_required' });
  const foreign = await fetch(`${f.base}/api/service/restart`, {
    method: 'POST', headers: { ...auth, origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await foreign.json(), { error: 'origin_rejected' });
  assert.equal((await fetch(`${f.base}/api/service/stop`, { method: 'POST' })).status, 401);
  // A literal "null" origin is accepted, exactly as for every other write.
  const nullOrigin = await fetch(`${f.base}/api/service/restart`, {
    method: 'POST', headers: { ...auth, origin: 'null' },
  });
  assert.equal(nullOrigin.status, 200);
  assert.deepEqual(f.exits, []);
  assert.equal(f.scheduled.length, 1);
});
