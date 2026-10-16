import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLock, defaultIsAlive, lockPathFor, withTimeout } from '../src/lifecycle.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url));
const LIFECYCLE = pathToFileURL(fileURLToPath(new URL('../src/lifecycle.js', import.meta.url))).href;

const dirs = [];
function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'autochat-lock-'));
  dirs.push(dir);
  return dir;
}
// Temp trees are the only files removed here, and only on the way out.
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const payloadOf = path => JSON.parse(readFileSync(path, 'utf8'));

test('the lock lives next to the database file, never inside it', () => {
  assert.equal(lockPathFor(join('data', 'autochat.sqlite')), join('data', 'autochat.lock'));
  assert.equal(lockPathFor('E:\\tmp\\nested\\db.sqlite'), join('E:\\tmp\\nested', 'autochat.lock'));
});

test('liveness asks the OS about a real pid', () => {
  assert.equal(defaultIsAlive(process.pid), true, 'this process is obviously alive');
});

test('a live holder is reported and its lock file is not touched', () => {
  const path = join(makeDir(), 'autochat.lock');
  const first = acquireLock(path, { pid: 4242, now: 111, isAlive: () => true });
  assert.equal(first.ok, true);
  const before = readFileSync(path);

  const second = acquireLock(path, { pid: 777, now: 222, isAlive: () => true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_running');
  assert.deepEqual(second.holder, { pid: 4242, startedAt: 111 });
  assert.deepEqual(readFileSync(path), before, 'the refused attempt rewrote nothing');
  assert.equal(payloadOf(path).pid, 4242);
  unlinkSync(path);
});

test('a dead pid, an empty file and garbage are all reclaimed exactly once', () => {
  const dir = makeDir();
  const path = join(dir, 'autochat.lock');
  const dead = acquireLock(path, { pid: 1000, now: 1, isAlive: () => true });
  assert.equal(dead.ok, true);

  const taken = acquireLock(path, { pid: 2000, now: 2, isAlive: () => false });
  assert.equal(taken.ok, true, 'a pid that is gone does not block the next start');
  assert.deepEqual(payloadOf(path), { pid: 2000, startedAt: 2 }, 'the stale file was replaced');
  unlinkSync(path);

  for (const content of ['', '{ broken', '{"pid":"1000"}', 'null', '[]']) {
    writeFileSync(path, content);
    const reclaimed = acquireLock(path, { pid: 3000, now: 3, isAlive: () => true });
    assert.equal(reclaimed.ok, true, `reclaimed over ${JSON.stringify(content)}`);
    assert.deepEqual(payloadOf(path), { pid: 3000, startedAt: 3 });
  }
});

test('release is idempotent and never deletes someone else lock', () => {
  const dir = makeDir();
  const path = join(dir, 'autochat.lock');
  const lock = acquireLock(path);
  assert.equal(payloadOf(path).pid, process.pid, 'acquire records the caller pid by default');
  assert.equal(lock.release(), true);
  assert.equal(existsSync(path), false, 'our own lock is gone after release');
  assert.equal(lock.release(), false, 'a second release is a no-op, not an error');

  const foreign = acquireLock(path);
  writeFileSync(path, `${JSON.stringify({ pid: process.pid + 1, startedAt: 999 })}\n`);
  assert.equal(foreign.release(), false);
  assert.equal(existsSync(path), true, 'a lock that has since been replaced survives release()');
  unlinkSync(path);
});

test('a real process exit runs the exit hook and removes the lock', async () => {
  const path = join(makeDir(), 'autochat.lock');
  // A worker is a real second thread with its own process object, so its
  // `process.exit()` exercises the same exit hook `src/main.js` registers.
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    import(workerData.module).then(({ acquireLock }) => {
      const lock = acquireLock(workerData.lockPath);
      if (!lock.ok) process.exit(2);
      process.on('exit', () => lock.release());
      setTimeout(() => process.exit(0), workerData.holdMs);
    });
  `, { eval: true, workerData: { module: LIFECYCLE, lockPath: path, holdMs: 200 } });
  const exited = once(worker, 'exit');
  let seen = false;
  for (let tries = 0; tries < 100 && !seen; tries += 1) {
    if (existsSync(path)) seen = true;
    else await sleep(10);
  }
  assert.equal(seen, true, 'the worker is holding the lock while it runs');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(existsSync(path), false, 'the exit hook released it on the way out');
});

test('withTimeout reports a timeout, passes values through and never rejects', async () => {
  const started = Date.now();
  const slow = await withTimeout(new Promise(() => {}), 20, 'console');
  assert.deepEqual(slow, { ok: false, reason: 'timeout', label: 'console', ms: 20 });
  assert.ok(Date.now() - started >= 15, 'it really waited for the timer, it did not fake it');

  assert.deepEqual(await withTimeout(Promise.resolve('done'), 5000, 'runtime'), { ok: true, value: 'done' });
  assert.deepEqual(
    await withTimeout(Promise.reject(new Error('DRAIN_FAILED')), 5000, 'social'),
    { ok: false, reason: 'failed', label: 'social', ms: 5000, error: new Error('DRAIN_FAILED') },
  );
});

test('the success path clears its own timer instead of leaving it armed', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created = [];
  const cleared = new Set();
  globalThis.setTimeout = (...args) => { const handle = realSet(...args); created.push(handle); return handle; };
  globalThis.clearTimeout = handle => { cleared.add(handle); return realClear(handle); };
  try {
    // No await between patching and the call: this timer is provably ours.
    assert.deepEqual(await withTimeout(Promise.resolve(7), 600000, 'fast'), { ok: true, value: 7 });
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(created.length >= 1, true);
  assert.equal(cleared.has(created[0]), true, 'the 10-minute timer was cleared, not left pending');
});

// A literal scan, not an AST pass: the argument list is delimited by counting
// parentheses (a `)` inside a string would mis-align it) and only the delay —
// the last top-level argument — is inspected. Missing a computed delay is
// acceptable; the tripwire only has to catch literal ones.
function callBody(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
}

function delayArgument(body) {
  let depth = 0;
  let quote = null;
  let cut = -1;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (char === quote && body[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) cut = index;
  }
  return body.slice(cut + 1).trim();
}

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

test('no timer in src/ is asked to wait longer than Node can represent', () => {
  const ceiling = 2147483647;
  const seen = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/set(?:Timeout|Interval)\s*\(/g)) {
      const delay = delayArgument(callBody(source, match.index + match[0].length - 1));
      for (const literal of delay.matchAll(/(?<![\w.$])(\d[\d_]*)(?![\w.])/g)) {
        seen.push({ file: file.slice(SRC.length + 1), delay, value: Number(literal[1].replaceAll('_', '')) });
      }
    }
  }
  assert.ok(seen.length >= 4, `the scan found delays at all (${seen.length})`);
  for (const { file, delay, value } of seen) {
    assert.ok(value <= ceiling, `${file}: ${delay} exceeds the ${ceiling}ms timer ceiling`);
  }
});

test('every source file stays inside the 400-line ceiling', () => {
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n').length - 1;
    assert.ok(lines <= 400, `${file.slice(SRC.length + 1)} is ${lines} lines`);
  }
  const engine = readFileSync(join(SRC, 'social', 'engine.js'), 'utf8').split('\n').length - 1;
  assert.ok(engine <= 401, `engine.js is ${engine} lines (the issue allows at most 401)`);
  const lifecycle = readFileSync(join(SRC, 'lifecycle.js'), 'utf8').split('\n').length - 1;
  assert.ok(lifecycle <= 120, `lifecycle.js is ${lifecycle} lines (target 120)`);
});

test('main.js wires the lock before the database and bounds every shutdown step', () => {
  const main = readFileSync(MAIN, 'utf8');
  const atCheck = main.indexOf("'--check'");
  const atLock = main.indexOf('acquireLock(');
  const atStore = main.indexOf('new Store(');
  assert.ok(atCheck >= 0 && atCheck < atLock, '--check still returns before anything is locked');
  assert.ok(atLock < atStore, 'the lock is taken before the database is opened');
  assert.match(main.slice(atLock, atStore), /process\.exit\(1\)/, 'a refused start exits non-zero');
  assert.match(main, /process\.on\('exit', \(\) => lock\.release\(\)\)/);

  assert.match(main, /SHUTDOWN_STEP_TIMEOUT_MS = 3000/);
  assert.match(main, /SHUTDOWN_CONSOLE_TIMEOUT_MS = 2000/);
  // Every step goes through one wrapper that bounds it and reports the overrun.
  assert.match(main, /const step = async \(promise, ms, name\) => \{[\s\S]{0,240}?withTimeout\(promise, ms, name\)/);
  for (const label of ['console', 'runtime', 'tails', 'social', 'slang']) {
    assert.ok(main.includes(`'${label}')`), `step ${label} is wrapped`);
  }
  assert.match(main, /SHUTDOWN_CONSOLE_TIMEOUT_MS, 'console'\)/);
  assert.match(main, /shutdown_step_slow/);
  assert.match(main, /shutdown_forced[\s\S]{0,80}?process\.exit\(1\)/);
  assert.match(main, /finally \{[\s\S]{0,200}?store\.close\(\)[\s\S]{0,100}?lock\.release\(\)/);
  assert.match(main, /process\.on\('SIGINT', \(\) => stop\('SIGINT'\)\)/);
  assert.match(main, /process\.on\('SIGTERM', \(\) => stop\('SIGTERM'\)\)/);
  // The refusal is explainable without reading the code.
  assert.match(main, /已在运行/);
  assert.match(main, /lock_unwritable/);
});

test('the store exposes no unprotected read-modify-write for counters', () => {
  const store = readFileSync(join(SRC, 'store.js'), 'utf8');
  assert.match(store, /bump\(key, delta = 1\)[\s\S]{0,200}?BUMP_INVALID/);
  const engine = readFileSync(join(SRC, 'social', 'engine.js'), 'utf8');
  assert.match(engine, /store\.bump\(`social_count:\$\{day\}:\$\{group\}`, 1\)/);
  assert.equal(/store\.set\(`social_count/.test(engine), false, 'the racy write is gone');
  assert.equal(statSync(join(SRC, 'social', 'engine.js')).isFile(), true);
});
