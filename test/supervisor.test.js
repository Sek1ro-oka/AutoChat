// The supervisor's policy and its loop (T-019). This sandbox forbids child pipes,
// so nothing here spawns: the loop is driven by fake children, and the pure
// functions (`nextAction`, `backoffDelay`, `inspectLocks`) are tested directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BACKOFF_CAP_MS, EXIT_ALREADY_RUNNING, EXIT_RESTART, MAX_ATTEMPTS, STABLE_AFTER_MS,
  backoffDelay, childArgs, childEnv, createSupervisor, inspectLocks, lockPaths, nextAction, statusReport,
} from '../scripts/supervisor.js';

// A child that only emits what a child emits: 'exit', 'error' and stdio 'data'.
function fakeChild(exitCode, { pid = 4200, auto = true } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  child.finish = code => child.emit('exit', code ?? exitCode, null);
  if (auto) setImmediate(() => child.finish());
  return child;
}

function harness(codes, options = {}) {
  const children = [];
  const waits = [];
  const events = [];
  const out = [];
  const err = [];
  let clock = 0;
  const supervisor = createSupervisor({
    launch: () => {
      if (children.length >= codes.length) {
        throw new Error(`the supervisor launched child #${children.length + 1}, which the test did not script`);
      }
      const child = fakeChild(codes[children.length], { pid: 4200 + children.length, auto: options.auto !== false });
      children.push(child);
      return child;
    },
    wait: async ms => { waits.push(ms); },
    now: () => { clock += options.stepMs ?? 0; return clock; },
    write: () => {},
    record: event => events.push(event),
    stdout: { write: chunk => out.push(String(chunk)) },
    stderr: { write: chunk => err.push(String(chunk)) },
    beforeLaunch: options.beforeLaunch ?? (() => ({ ok: true })),
  });
  return { supervisor, children, waits, events, out, err };
}

test('nextAction: the exit protocol in one table', () => {
  assert.deepEqual(nextAction(0, 3), { action: 'stop', attempt: 0, delayMs: 0 });
  assert.deepEqual(nextAction(EXIT_RESTART, 4), { action: 'restart', attempt: 0, delayMs: 0 });
  assert.deepEqual(nextAction(EXIT_ALREADY_RUNNING, 2), {
    action: 'give_up', reason: 'already_running', attempt: 2, delayMs: 0,
  });
  assert.deepEqual(nextAction(1, 0), { action: 'retry', attempt: 1, delayMs: 1000 });
  assert.deepEqual(nextAction(1, 2), { action: 'retry', attempt: 3, delayMs: 4000 });
  assert.deepEqual(nextAction(137, MAX_ATTEMPTS), {
    action: 'give_up', reason: 'too_many_failures', attempt: MAX_ATTEMPTS + 1, delayMs: 0,
  });
});

test('backoff doubles from 1s and is capped at 30s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffDelay), [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(backoffDelay(9), BACKOFF_CAP_MS);
  assert.equal(backoffDelay(0), 1000, 'a missing attempt still starts at the base delay');
});

test('the child is main.js with the env file, and knows which supervisor it has', () => {
  const root = resolve('root');
  assert.deepEqual(childArgs(root), [`--env-file=${join(root, '.env')}`, join(root, 'src', 'main.js')]);
  assert.deepEqual(childEnv({ KEEP: '1', AUTOCHAT_SUPERVISED: '0' }, 777), {
    KEEP: '1', AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: '777',
  });
});

test('inspectLocks: the bot lock is the only answer to "running"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-supervisor-'));
  try {
    const botLock = join(dir, 'autochat.lock');
    const supervisorLock = join(dir, 'autochat-supervisor.lock');
    // A live supervisor next to a dead bot is not "running" — the bug the old pid
    // file produced, now answered by the bot lock itself.
    writeFileSync(supervisorLock, `${JSON.stringify({ pid: 222, startedAt: 2 })}\n`);
    assert.deepEqual(inspectLocks({ botLock, supervisorLock, isAlive: pid => pid === 222 }), {
      running: false, botPid: null, botStartedAt: null, supervisorPid: 222,
    });
    writeFileSync(botLock, `${JSON.stringify({ pid: 333, startedAt: 3 })}\n`);
    const alive = inspectLocks({ botLock, supervisorLock, isAlive: pid => pid === 222 || pid === 333 });
    assert.equal(alive.running, true);
    assert.equal(alive.botPid, 333);
    assert.equal(alive.botStartedAt, 3);
    assert.equal(alive.supervisorPid, 222);
    assert.equal(inspectLocks({ botLock, supervisorLock, isAlive: () => false }).running, false);
    writeFileSync(botLock, 'not json');
    assert.equal(inspectLocks({ botLock, supervisorLock, isAlive: () => true }).running, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lockPaths name both locks next to the database file', () => {
  const root = resolve('root');
  const paths = lockPaths(root, {});
  assert.equal(paths.databasePath, join(root, 'data', 'autochat.sqlite'));
  assert.equal(paths.botLock, join(root, 'data', 'autochat.lock'));
  assert.equal(paths.supervisorLock, join(root, 'data', 'autochat-supervisor.lock'));
  const report = statusReport(root, () => false);
  assert.equal(report.running, false);
  assert.deepEqual(Object.keys(report).sort(), ['botPid', 'botStartedAt', 'locks', 'running', 'supervisorPid']);
});

test('exit 0 stops the supervisor instead of relaunching', async () => {
  const h = harness([0]);
  assert.equal(await h.supervisor.run(), 0);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.events.at(-1).event, 'stop');
});

test('exit 75 relaunches at once and resets the failure count', async () => {
  const h = harness([EXIT_RESTART, EXIT_RESTART, 0]);
  assert.equal(await h.supervisor.run(), 0);
  assert.equal(h.children.length, 3);
  assert.deepEqual(h.waits, []);
  assert.deepEqual(h.events.filter(event => event.event === 'restart_requested').map(event => event.attempt), [0, 0]);
});

test('exit 2 gives up instead of fighting the instance that owns the lock', async () => {
  const h = harness([EXIT_ALREADY_RUNNING]);
  assert.equal(await h.supervisor.run(), EXIT_ALREADY_RUNNING);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.waits, []);
  assert.equal(h.events.at(-1).reason, 'already_running');
});

test('a crash loop backs off then gives up', async () => {
  const h = harness(Array(MAX_ATTEMPTS + 2).fill(1));
  assert.equal(await h.supervisor.run(), 1);
  assert.equal(h.children.length, MAX_ATTEMPTS + 1);
  assert.deepEqual(h.waits, [1000, 2000, 4000, 8000, 16000, 30000]);
  assert.equal(h.events.at(-1).event, 'give_up');
  assert.equal(h.events.at(-1).reason, 'too_many_failures');
});

test('a child that served long enough is not counted as a crash', async () => {
  const h = harness([1, 1, 1, 0], { stepMs: STABLE_AFTER_MS + 1000 });
  assert.equal(await h.supervisor.run(), 0);
  assert.equal(h.children.length, 4);
  assert.deepEqual(h.waits, [1000, 1000, 1000], 'the count never grows past the first retry');
});

test('a bot that already holds the lock is never started twice', async () => {
  let calls = 0;
  const h = harness([1], {
    beforeLaunch: () => (++calls === 2 ? { ok: false, reason: 'already_running', pid: 999 } : { ok: true }),
  });
  assert.equal(await h.supervisor.run(), EXIT_ALREADY_RUNNING);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.waits, [1000]);
  assert.equal(h.events.at(-1).pid, 999);
});

test('child stdout and stderr are forwarded, never swallowed', async () => {
  const h = harness([0], { auto: false });
  const running = h.supervisor.run();
  await new Promise(done => setImmediate(done));
  h.children[0].stdout.emit('data', 'boot log\n');
  h.children[0].stderr.emit('data', 'warning\n');
  h.children[0].finish(0);
  assert.equal(await running, 0);
  assert.deepEqual(h.out, ['boot log\n']);
  assert.deepEqual(h.err, ['warning\n']);
});

test('SIGINT is forwarded, then SIGKILL, and the supervisor exits 0', async () => {
  const h = harness([0], { auto: false });
  const running = h.supervisor.run();
  await new Promise(done => setImmediate(done));
  h.supervisor.handle('SIGINT');
  assert.deepEqual(h.children[0].signals, ['SIGINT']);
  h.supervisor.handle('SIGINT');
  assert.deepEqual(h.children[0].signals, ['SIGINT', 'SIGKILL']);
  h.children[0].finish(1); // a stop we asked for is a stop, never a crash
  assert.equal(await running, 0);
  assert.equal(h.children.length, 1);
});

test('the launcher starts the supervisor and no longer writes runtime/autochat.pid', () => {
  const start = readFileSync(new URL('../scripts/start-autochat.ps1', import.meta.url), 'utf8');
  assert.match(start, /supervisor\.js/);
  assert.match(start, /--status/);
  assert.equal(/Set-Content[^\n]*autochat\.pid/.test(start), false);
  const stop = readFileSync(new URL('../scripts/stop-autochat.ps1', import.meta.url), 'utf8');
  assert.match(stop, /--status/);
  assert.match(stop, /Refusing to stop it/);
});
