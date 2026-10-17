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
// `--instance <name>` supervises `instances/<name>.env` instead of `.env`: it loads
// that file, injects AUTOCHAT_INSTANCE so the console can tell which account it
// manages, and takes a per-instance mutex (data/autochat-supervisor-<name>.lock).
// Without the flag nothing changes, which is what the default-path tests pin down.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireLock, defaultIsAlive, lockPathFor, readLockHolder, supervisorLockPathFor,
} from '../src/lifecycle.js';
import {
  instanceFile, instanceSettings, instanceSupervisorLockPath, readInstanceEnv, validInstanceName,
} from './instances.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export const EXIT_RESTART = 75;
export const EXIT_ALREADY_RUNNING = 2;
// Bad arguments, and "the instance file is missing or unreadable": the start script
// can tell a configuration mistake apart from a crash.
export const EXIT_USAGE = 64;
export const EXIT_CONFIG = 78;
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

export function childArgs(root = ROOT, { instance = null } = {}) {
  // An instance file *is* the configuration of that bot, so it replaces `.env`
  // rather than layering on top of it.
  const envFile = instance ? instanceFile(root, instance) : join(root, '.env');
  return [`--env-file=${envFile}`, join(root, 'src', 'main.js')];
}

// The supervisor's only channel to the console: a flag and its own pid, so the
// console never has to guess the process tree.
export function childEnv(base = process.env, supervisorPid = process.pid, { instance = null, shadow = [] } = {}) {
  const env = { ...base };
  // Node's --env-file never overrides a variable that is already set, and the
  // supervisor is itself started with .env (scripts/start-autochat.ps1). Dropping
  // every key the instance file declares is what lets the instance file win.
  for (const key of shadow) delete env[key];
  env.AUTOCHAT_SUPERVISED = '1';
  env.AUTOCHAT_SUPERVISOR_PID = String(supervisorPid);
  if (instance) env.AUTOCHAT_INSTANCE = instance;
  return env;
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

// `--instance` is the only new argument. An unknown flag is now an error instead of
// being ignored, because a typo in --instance must not silently start the default
// bot against the default database.
export function parseArgs(argv = []) {
  let status = false;
  let instance = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === '--status') { status = true; continue; }
    let value;
    if (arg === '--instance') {
      value = argv[index + 1];
      index += 1;
      if (value === undefined || String(value).startsWith('-')) {
        return { ok: false, code: 'INSTANCE_NAME_MISSING', message: '--instance 后需要一个实例名。' };
      }
    } else if (arg.startsWith('--instance=')) {
      value = arg.slice('--instance='.length);
    } else {
      return { ok: false, code: 'UNKNOWN_ARGUMENT', message: `未知参数：${arg}` };
    }
    if (!validInstanceName(String(value))) {
      return { ok: false, code: 'INVALID_INSTANCE_NAME', message: `实例名 "${value}" 不合法：只能是小写字母、数字、下划线、短横线，以字母或数字开头，最多 24 个字符。` };
    }
    instance = String(value);
  }
  return { ok: true, status, instance };
}

// The same judgement as statusReport, but for one instance: the bot lock still
// decides "running", while the mutex it reports beside it is the per-instance one.
export function instanceStatusReport(root = ROOT, name, { isAlive = defaultIsAlive, entry = readInstanceEnv(root, name) } = {}) {
  const supervisorLock = instanceSupervisorLockPath(root, name);
  if (!entry.ok) {
    return {
      instance: name,
      running: false,
      botPid: null,
      botStartedAt: null,
      supervisorPid: null,
      locks: { bot: null, supervisor: supervisorLock },
      error: entry.code,
    };
  }
  const settings = instanceSettings(root, name, entry.values);
  return {
    instance: name,
    ...inspectLocks({ botLock: settings.botLock, supervisorLock, isAlive }),
    locks: { bot: settings.botLock, supervisor: supervisorLock },
  };
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

// Everything one instance's launch needs, resolved in one place: its locks follow
// its own database and name, its child loads its own file, and the inherited
// environment loses exactly the keys that file owns.
export function instanceLaunch(root, name, { entry = readInstanceEnv(root, name), base = process.env, pid = process.pid } = {}) {
  if (!entry.ok) return { ok: false, code: entry.code, file: entry.file };
  const settings = instanceSettings(root, name, entry.values);
  return {
    ok: true,
    settings,
    paths: { botLock: settings.botLock, supervisorLock: settings.supervisorLock },
    args: childArgs(root, { instance: name }),
    env: childEnv(base, pid, { instance: name, shadow: Object.keys(entry.values) }),
  };
}

function main(argv, { root = ROOT, base = process.env } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`[supervisor] ${parsed.message}\n`);
    return EXIT_USAGE;
  }
  if (parsed.status) {
    if (!parsed.instance) {
      process.stdout.write(`${JSON.stringify(statusReport(root))}\n`);
      return 0;
    }
    const report = instanceStatusReport(root, parsed.instance);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.error ? EXIT_CONFIG : 0;
  }
  const label = parsed.instance ? `[supervisor:${parsed.instance}] ` : '[supervisor] ';
  let paths;
  let launchArgs = childArgs(root);
  let launchEnv = childEnv(base);
  if (parsed.instance) {
    const target = instanceLaunch(root, parsed.instance, { base });
    if (!target.ok) {
      process.stderr.write(`${label}cannot read ${target.file} (${target.code}); refusing to start.\n`);
      return EXIT_CONFIG;
    }
    paths = target.paths;
    launchArgs = target.args;
    launchEnv = target.env;
    // data/ need not exist on a fresh checkout; the mutex lives in it.
    mkdirSync(dirname(paths.supervisorLock), { recursive: true });
  } else {
    const defaults = lockPaths(root);
    paths = { botLock: defaults.botLock, supervisorLock: defaults.supervisorLock };
  }
  const own = acquireLock(paths.supervisorLock);
  if (!own.ok) {
    const why = own.reason === 'already_running'
      ? `another supervisor is already running (pid ${own.holder.pid})`
      : `cannot take ${paths.supervisorLock} (${own.error?.code ?? 'unknown'})`;
    process.stderr.write(`${label}${why}; refusing to start a second one.\n`);
    return EXIT_ALREADY_RUNNING;
  }
  // `release` is idempotent and the exit hook covers the crash path too.
  const release = () => own.release();
  process.on('exit', release);
  const supervisor = createSupervisor({
    // The bot lock is released by the bot on exit, so a lock that is still held by
    // a live pid belongs to someone else: never start a second bot over it.
    beforeLaunch: () => {
      const state = inspectLocks(paths);
      return state.running ? { ok: false, reason: 'already_running', pid: state.botPid } : { ok: true };
    },
    launch: () => spawn(process.execPath, launchArgs, {
      cwd: root, env: launchEnv, stdio: ['ignore', 'pipe', 'pipe'],
    }),
    ...(parsed.instance ? { write: line => process.stderr.write(`${label}${line}\n`) } : {}),
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
