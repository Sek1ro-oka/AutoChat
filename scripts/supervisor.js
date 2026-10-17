// Thin supervisor for the bot process (T-019).
//
// Why it lives outside the bot: the console runs inside the bot process (it holds
// the live store/bot/transport objects), so the only thing that can bring the bot
// back after it exits is another process. This one stays deliberately thin —
// spawn, forward output, apply the exit protocol, repeat — and the policy it
// applies is a pure function (`nextAction`), testable without spawning anything.
//
// Exit protocol (borrowed, not invented; see C11/C12 of
// work/program/research/console-control-plane-and-dsh.md):
//   75  a restart was asked for: relaunch at once and reset the failure count;
//   0   a normal stop: this supervisor stops too;
//   2   another instance owns the lock: report it and stop retrying;
//   *   abnormal: exponential backoff (1s, 2s, 4s … capped at 30s), giving up
//       after MAX_ATTEMPTS consecutive fast failures.
//
// CLI: `node scripts/supervisor.js` supervises; `--status` prints one JSON line —
// the single "is it running" judgement that insert/stop scripts consume.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLock, defaultIsAlive, lockPathFor, readLockHolder, supervisorLockPathFor,
} from '../src/lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const EXIT_RESTART = 75;
export const EXIT_ALREADY_RUNNING = 2;
export const MAX_ATTEMPTS = 6;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30000;
// A child that stayed up this long was not a crash loop: the count starts over.
export const STABLE_AFTER_MS = 60000;
export const CHILD_STOP_TIMEOUT_MS = 8000;

export function backoffDelay(attempt) {
  const step = Math.max(1, Math.trunc(Number(attempt) || 1));
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (step - 1));
}

// The whole restart policy in one place: `attempt` counts consecutive crashes.
export function nextAction(code, attempt) {
  const failures = Math.max(0, Math.trunc(Number(attempt) || 0));
  if (code === 0) return { action: 'stop', attempt: 0, delayMs: 0 };
  if (code === EXIT_RESTART) return { action: 'restart', attempt: 0, delayMs: 0 };
  // Not a crash: retrying would fight the first instance for the lock and the port.
  if (code === EXIT_ALREADY_RUNNING) {
    return { action: 'give_up', reason: 'already_running', attempt: failures, delayMs: 0 };
  }
  const next = failures + 1;
  if (next > MAX_ATTEMPTS) {
    return { action: 'give_up', reason: 'too_many_failures', attempt: next, delayMs: 0 };
  }
  return { action: 'retry', attempt: next, delayMs: backoffDelay(next) };
}

export function childArgs(root = ROOT) {
  return [`--env-file=${join(root, '.env')}`, join(root, 'src', 'main.js')];
}

// The supervisor's only channel to the console: a flag and its own pid, so the
// console never has to guess the process tree.
export function childEnv(base = process.env, supervisorPid = process.pid) {
  return { ...base, AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: String(supervisorPid) };
}

export function lockPaths(root = ROOT, env = process.env) {
  // Same default as src/config.js `databasePath`, resolved against the checkout
  // rather than the caller's cwd so both sides name the same file.
  const databasePath = resolve(root, env.DATABASE_PATH || join('data', 'autochat.sqlite'));
  return {
    databasePath,
    botLock: lockPathFor(databasePath),
    supervisorLock: supervisorLockPathFor(databasePath),
  };
}

// One answer to "is it running", shared with the start/stop scripts: the bot lock
// is authoritative and only counts while its pid is alive. The supervisor lock is
// a mutex, so its holder is reported beside that answer, never instead of it.
export function inspectLocks({ botLock, supervisorLock, isAlive = defaultIsAlive }) {
  const bot = readLockHolder(botLock);
  const supervisor = readLockHolder(supervisorLock);
  const botAlive = Boolean(bot && isAlive(bot.pid));
  return {
    running: botAlive,
    botPid: botAlive ? bot.pid : null,
    botStartedAt: botAlive ? bot.startedAt ?? null : null,
    supervisorPid: supervisor && isAlive(supervisor.pid) ? supervisor.pid : null,
  };
}

export function statusReport(root = ROOT, isAlive = defaultIsAlive) {
  const paths = lockPaths(root);
  return { ...inspectLocks({ ...paths, isAlive }), locks: { bot: paths.botLock, supervisor: paths.supervisorLock } };
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

// The loop, with every side effect injected so the tests can drive fake children
// and assert the protocol without spawning (this sandbox forbids child pipes).
export function createSupervisor({
  launch, write = line => process.stderr.write(`[supervisor] ${line}\n`), record = () => {},
  wait = sleep, now = Date.now, stdout = process.stdout, stderr = process.stderr,
  beforeLaunch = () => ({ ok: true }),
} = {}) {
  let child = null;
  let stopping = false;

  const forward = (stream, target) => {
    if (stream && typeof stream.on === 'function' && typeof target?.write === 'function') {
      stream.on('data', chunk => target.write(chunk));
    }
  };
  // A spawn failure (missing node, ENOENT) arrives as 'error', never as 'exit'.
  const waitForExit = target => new Promise(done => {
    if (!target || typeof target.once !== 'function') { done({ code: 1, signal: null }); return; }
    target.once('exit', (code, signal) => done({ code: code ?? 1, signal: signal ?? null }));
    target.once('error', error => done({ code: 1, signal: null, error }));
  });

  async function run() {
    let attempt = 0;
    for (;;) {
      if (stopping) return 0;
      const ready = beforeLaunch();
      if (!ready.ok) {
        write(`refusing to start the bot: it is already running (pid ${ready.pid ?? 'unknown'}).`);
        record({ event: 'give_up', reason: ready.reason ?? 'preflight', pid: ready.pid ?? null });
        return EXIT_ALREADY_RUNNING;
      }
      const startedAt = now();
      child = launch();
      forward(child?.stdout, stdout);
      forward(child?.stderr, stderr);
      record({ event: 'child_started', childPid: child?.pid ?? null });
      const result = await waitForExit(child);
      const livedMs = now() - startedAt;
      child = null;
      record({ event: 'child_exited', code: result.code, signal: result.signal, livedMs });
      if (stopping) { write('stopped.'); return 0; }
      const decision = nextAction(result.code, livedMs >= STABLE_AFTER_MS ? 0 : attempt);
      attempt = decision.attempt;
      if (decision.action === 'stop') {
        write('the bot exited on its own (0); leaving it stopped.');
        record({ event: 'stop' });
        return 0;
      }
      if (decision.action === 'give_up') {
        write(decision.reason === 'already_running'
          ? 'another instance is running; not restarting.'
          : `giving up after ${attempt} failed starts.`);
        record({ event: 'give_up', reason: decision.reason, attempts: attempt });
        return decision.reason === 'already_running' ? EXIT_ALREADY_RUNNING : 1;
      }
      record({ event: decision.action === 'restart' ? 'restart_requested' : 'backoff', attempt, delayMs: decision.delayMs });
      if (decision.delayMs > 0) {
        write(`exit ${result.code}; retrying in ${decision.delayMs}ms (attempt ${attempt}).`);
        await wait(decision.delayMs);
      } else {
        write('restart requested; relaunching.');
      }
    }
  }

  // Ctrl+C / SIGTERM: hand the signal over, escalate if the child hangs, and let
  // run() return 0 once it is really gone — a requested stop is not a failure.
  function handle(signal) {
    if (stopping) {
      write('forcing shutdown.');
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      return;
    }
    stopping = true;
    if (!child) { write('no child to stop.'); return; }
    write(`${signal} received; stopping the bot.`);
    try { child.kill(signal); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    }, CHILD_STOP_TIMEOUT_MS);
    timer.unref?.();
  }

  return { run, handle, childPid: () => child?.pid ?? null };
}

function main(argv) {
  if (argv.includes('--status')) {
    process.stdout.write(`${JSON.stringify(statusReport(ROOT))}\n`);
    return 0;
  }
  const { botLock, supervisorLock } = lockPaths(ROOT);
  const own = acquireLock(supervisorLock);
  if (!own.ok) {
    const why = own.reason === 'already_running'
      ? `another supervisor is already running (pid ${own.holder.pid})`
      : `cannot take ${supervisorLock} (${own.error?.code ?? 'unknown'})`;
    process.stderr.write(`[supervisor] ${why}; refusing to start a second one.\n`);
    return EXIT_ALREADY_RUNNING;
  }
  // `release` is idempotent and the exit hook covers the crash path too.
  const release = () => own.release();
  process.on('exit', release);
  const supervisor = createSupervisor({
    // The bot lock is released by the bot on exit, so a lock that is still held by
    // a live pid belongs to someone else: never start a second bot over it.
    beforeLaunch: () => {
      const state = inspectLocks({ botLock, supervisorLock });
      return state.running ? { ok: false, reason: 'already_running', pid: state.botPid } : { ok: true };
    },
    launch: () => spawn(process.execPath, childArgs(ROOT), {
      cwd: ROOT, env: childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'],
    }),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => supervisor.handle(signal));
  supervisor.run().then(code => {
    release();
    process.exit(code);
  });
  return null;
}

// Importing this module must not start anything: the tests import it.
const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}
