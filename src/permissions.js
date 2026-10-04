// File-permission tightening for the secrets this project writes to disk.
//
// The problem: `writeFileSync(path, text, { mode: 0o600 })` is a **no-op on
// Windows** — Node maps POSIX modes onto the read-only bit and nothing else, so
// a file created that way is still readable by every account on the machine.
// This project runs on Windows, so the console token and the chat database were
// in practice readable by any local user despite looking "0o600" in the source.
//
// The fix on Windows is an explicit DACL: break inheritance and grant only the
// own account, SYSTEM and Administrators. Measured on this machine (2026-10-04)
// this needs no elevation — the owner of an object implicitly holds WRITE_DAC —
// and it needs no `/t`: once inheritable ACEs are set on a directory, icacls
// updates the already-existing children too, so a directory holding a handful of
// files is done in one shot.
//
// Deliberately NOT applied to `runtime/` as a whole: that directory also holds
// the portable Node runtime, the NapCat install and the download cache (>120 MB),
// and icacls walks inherited children, which would turn a 50 ms startup step into
// a multi-second tree rewrite for no security gain. Individual sensitive files
// are tightened at the moment they are written instead.
//
// Everything here is best-effort. A failure is reported, never thrown: refusing
// to start because an ACL could not be set would push operators to disable the
// whole mechanism.

import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const TIMEOUT_MS = 10000;
// Absolute paths on purpose. A Git Bash / MSYS / Cygwin shell puts its own
// `whoami` (coreutils) ahead of the Windows one on PATH, and that build rejects
// `/user` — resolving through PATH turns a working probe into a hard failure.
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const WHOAMI = join(SYSTEM32, 'whoami.exe');
const ICACLS = join(SYSTEM32, 'icacls.exe');
// Well-known, language-independent SIDs: the local SYSTEM account and the
// built-in Administrators group. Using SIDs avoids matching on localised names.
export const SYSTEM_SID = 'S-1-5-18';
export const ADMINISTRATORS_SID = 'S-1-5-32-544';

// Broad principals that must not hold an ACE on a secret file. SIDs again — and
// the list is needed because `/grant:r` only replaces the grants for the
// principals it names: an *explicit* ACE for `Authenticated Users` survives both
// it and `/inheritance:r`. `/remove:g` exits 0 when a principal is absent, so
// the whole list goes in one call without probing first.
export const BROAD_SIDS = Object.freeze([
  'S-1-1-0',      // Everyone
  'S-1-5-2',      // NETWORK
  'S-1-5-4',      // INTERACTIVE
  'S-1-5-6',      // SERVICE
  'S-1-5-7',      // ANONYMOUS LOGON
  'S-1-5-11',     // Authenticated Users
  'S-1-5-19',     // LOCAL SERVICE
  'S-1-5-20',     // NETWORK SERVICE
  'S-1-5-32-545', // BUILTIN\Users
  'S-1-5-32-546', // BUILTIN\Guests
]);

// stdin is `ignore`, not the default `pipe`: neither command reads it, and a
// stdin pipe is the one handle that cannot always be created here — opening an
// unused pipe turns a working probe into a spurious `EBUSY` failure.
const STDIO = ['ignore', 'pipe', 'pipe'];

const run = args => execFileSync(ICACLS, args, { stdio: STDIO, timeout: TIMEOUT_MS, windowsHide: true });

// `whoami /user /fo csv /nh` prints `"DOMAIN\user","S-1-5-21-…"`.
// Memoised: the answer cannot change within a process, and the spawn is the
// slow part of the whole hardening step.
let cachedSid;
export function currentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  const output = execFileSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8', stdio: STDIO, timeout: TIMEOUT_MS, windowsHide: true,
  });
  const last = output.trim().split(/\r?\n/).pop() ?? '';
  const fields = last.split(',');
  const sid = (fields[fields.length - 1] ?? '').trim().replace(/^"|"$/g, '');
  cachedSid = /^S-\d+(-\d+)+$/.test(sid) ? sid : null;
  return cachedSid;
}

// Test hook: the cache is process-wide, and a test that has to exercise the
// "whoami failed" branch needs it cleared.
export function resetSidCache() { cachedSid = undefined; }

// Tighten one path. `directory` adds the inheritable flags so files created
// inside it later are covered as well.
export function harden(path, { directory = false, log = () => {}, label = null } = {}) {
  const tag = label ?? path;
  if (!IS_WINDOWS) {
    // On POSIX the mode really is enforced, so this is a plain chmod. It runs on
    // existing files too, not just on creation: a token written by an older build
    // is exactly the file that needs repairing.
    try {
      chmodSync(path, directory ? 0o700 : 0o600);
      return { path, applied: true, ok: true };
    } catch (error) {
      log('permissions_failed');
      return { path, applied: true, ok: false, reason: String(error?.message ?? error), label: tag };
    }
  }
  try {
    const sid = currentUserSid();
    if (!sid) throw new Error('whoami_sid_unparsable');
    const flags = directory ? '(OI)(CI)' : '';
    // One call, three ordered steps:
    //   /inheritance:r  drop everything the parent handed down;
    //   /remove:g       drop explicit ACEs held by broad principals, which
    //                   `/inheritance:r` cannot touch and `/grant:r` would
    //                   leave in place;
    //   /grant:r        install exactly three entries.
    run([
      path,
      '/inheritance:r',
      '/remove:g', ...BROAD_SIDS.map(value => `*${value}`),
      '/grant:r', `*${sid}:${flags}F`, `*${SYSTEM_SID}:${flags}F`, `*${ADMINISTRATORS_SID}:${flags}F`,
    ]);
    log('permissions_hardened');
    return { path, applied: true, ok: true };
  } catch (error) {
    // Non-fatal by design; see the module comment.
    log('permissions_failed');
    return { path, applied: true, ok: false, reason: String(error?.message ?? error), label: tag };
  }
}

// Tighten several paths, swallowing nothing but reporting everything.
export function hardenAll(paths, { log = () => {} } = {}) {
  const results = [];
  for (const entry of paths) {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    if (!spec?.path) continue;
    results.push({ ...harden(spec.path, { directory: Boolean(spec.directory), log, label: spec.label }), label: spec.label ?? spec.path });
  }
  const failed = results.filter(item => !item.ok);
  if (failed.length) log('permissions_incomplete');
  return { results, ok: failed.length === 0, failed: failed.length };
}
