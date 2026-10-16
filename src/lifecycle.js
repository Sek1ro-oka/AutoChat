// Process lifecycle helpers used by `src/main.js`: a single-instance lock and a
// bounded shutdown step.
//
// Why a lock *file* and not an OS lock: `flock`/`LockFileEx` have no stable API
// shared by Node on Windows and Linux, while `writeFileSync(..., { flag: 'wx' })`
// is atomic everywhere (O_CREAT|O_EXCL). The lock is therefore advisory: a human
// may delete the file, and that is in fact the recovery path for a crashed run
// whose pid is gone.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function lockPathFor(databasePath) {
  return join(dirname(databasePath), 'autochat.lock');
}

// `kill(pid, 0)` only asks the OS whether the pid exists.
export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM means the process exists but belongs to someone else; anything else
    // is unknown. Both stay "alive" so a foreign lock is never stolen.
    return true;
  }
}

// A holder is trusted only when the file parses to an object with an integer pid.
// Empty, truncated or hand-mangled content counts as no holder at all and is
// reclaimed exactly like a dead pid.
function readHolder(lockPath) {
  let holder;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  return holder && typeof holder === 'object' && Number.isInteger(holder.pid) ? holder : null;
}

export function acquireLock(lockPath, { pid = process.pid, now = Date.now(), isAlive = defaultIsAlive } = {}) {
  const payload = `${JSON.stringify({ pid, startedAt: now })}\n`;
  const create = () => writeFileSync(lockPath, payload, { flag: 'wx' });
  try {
    create();
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, reason: 'lock_unwritable', error };
    const holder = readHolder(lockPath);
    if (holder && isAlive(holder.pid)) {
      return { ok: false, reason: 'already_running', holder: { pid: holder.pid, startedAt: holder.startedAt ?? null } };
    }
    // Stale lock (dead pid, empty or unparsable file): drop it and retry the
    // exclusive create exactly once. A second failure — another process won the
    // race, or the directory is not writable — is reported, never retried.
    try {
      unlinkSync(lockPath);
    } catch (error2) {
      return { ok: false, reason: 'lock_unwritable', error: error2 };
    }
    try {
      create();
    } catch (error2) {
      return { ok: false, reason: 'lock_unwritable', error: error2 };
    }
  }
  let held = true;
  // Idempotent, and never removes a lock that has since been replaced: the file
  // is re-read and only our own pid is unlinked.
  const release = () => {
    if (!held) return false;
    held = false;
    if (readHolder(lockPath)?.pid !== process.pid) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  };
  return { ok: true, path: lockPath, release };
}

// Bound one shutdown step. A timeout is reported, never thrown: shutdown must
// keep making progress, and the abandoned promise deliberately keeps running in
// the background (it is a drain, not something to cancel).
export async function withTimeout(promise, ms, label = '') {
  let timer;
  const expired = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', label, ms }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        value => ({ ok: true, value }),
        error => ({ ok: false, reason: 'failed', label, ms, error }),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
