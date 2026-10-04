// File-permission tightening (docs/security.md).
//
// The behaviour under test is OS-level: on Windows the assertion is read back
// from `icacls`, because that is the only thing that proves the ACL really
// changed. `mode: 0o600` is deliberately not asserted on — it is a no-op on
// Windows, and that is the entire reason this module exists.
//
// On POSIX the DACL concept does not apply, so the Windows-only assertions are
// skipped rather than faked; the "never throws" contract is checked everywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADMINISTRATORS_SID, SYSTEM_SID, currentUserSid, harden, hardenAll,
} from '../src/permissions.js';
import { Store } from '../src/store.js';
import { createConsole } from '../src/console/server.js';

const IS_WINDOWS = process.platform === 'win32';
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const STDIO = ['ignore', 'pipe', 'pipe'];

// Read the ACL back. Uses the same stdio shape as the module: a stdin pipe
// cannot always be created, and the default `pipe` would make this helper fail
// for a reason that has nothing to do with what is being asserted.
const acl = path => execFileSync(join(SYSTEM32, 'icacls.exe'), [path], { encoding: 'utf8', stdio: STDIO });

// `icacls` prints one ACE per line, continuation lines indented. Keep only the
// `subject:(flags)` part so localised account names do not break the assertion.
const aces = path => acl(path)
  .split(/\r?\n/)
  .map(line => line.match(/([^\s]+):((?:\((?:OI|CI|IO|I|F|M|RX|GR|GE|D|N|WD|AD|S|X|W|R)\))+)\s*$/))
  .filter(Boolean)
  .map(match => ({ subject: match[1], flags: match[2] }));

const withTemp = (body) => {
  const root = mkdtempSync(join(tmpdir(), 'autochat-perm-'));
  try { return body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('the current account SID is read as a SID, not as a localised name', { skip: !IS_WINDOWS && 'Windows-only' }, () => {
  const sid = currentUserSid();
  assert.match(sid, /^S-\d+(-\d+)+$/, 'the SID must be parsed out of whoami output');
  // The two system SIDs are fixed by Microsoft and must never be looked up by
  // name: "Administrators" is "Administratoren" elsewhere.
  assert.equal(SYSTEM_SID, 'S-1-5-18');
  assert.equal(ADMINISTRATORS_SID, 'S-1-5-32-544');
});

test('hardening a file strips inherited access and leaves exactly three entries', { skip: !IS_WINDOWS && 'Windows-only' }, () => {
  withTemp((root) => {
    const file = join(root, 'token.txt');
    // Written exactly the way the console writes it, mode included: the point
    // is that the mode does not do the job, so something else has to.
    writeFileSync(file, 'secret\n', { mode: 0o600 });
    const before = aces(file);
    assert.ok(before.length > 3, `expected a broad inherited ACL to start from, saw ${before.length}`);
    // Every starting entry is inherited. That is what makes the count below
    // conclusive: `/inheritance:r` wipes them all, so whatever remains can only
    // be the three grants this module passed on the command line.
    assert.ok(before.every(ace => ace.flags.includes('(I)')), 'nothing explicit should pre-exist');

    const result = harden(file);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.applied, true);

    const after = aces(file);
    assert.equal(after.length, 3, `expected 3 entries, saw ${JSON.stringify(after)}`);
    assert.ok(after.every(ace => !ace.flags.includes('(I)')), 'no inherited entry may survive');
    assert.ok(after.every(ace => ace.flags === '(F)'), 'each survivor gets full control');
    // icacls prints resolved account names (`NT AUTHORITY\SYSTEM`), localised and
    // in the console code page, so identity is asserted by count and by the fact
    // that the three principals differ — not by matching a name string.
    assert.equal(new Set(after.map(ace => ace.subject)).size, 3, 'three distinct principals');

    // The property that actually matters for the owner: we did not lock
    // ourselves out. Losing this would turn a security fix into an outage.
    writeFileSync(file, 'secret-again\n');
    assert.equal(readFileSync(file, 'utf8').trim(), 'secret-again');
  });
});

test('hardening a directory covers files that already exist and files created later', { skip: !IS_WINDOWS && 'Windows-only' }, () => {
  withTemp((root) => {
    const dir = join(root, 'data');
    mkdirSync(dir);
    const existing = join(dir, 'autochat.sqlite');
    writeFileSync(existing, 'db');

    const result = harden(dir, { directory: true });
    assert.equal(result.ok, true, result.reason);

    // Inheritable flags on the directory, not on the contents.
    const dirAces = aces(dir);
    assert.equal(dirAces.length, 3);
    assert.ok(dirAces.every(ace => ace.flags.includes('(OI)(CI)')), 'the grants must be inheritable');

    // The already-existing child is rewritten by icacls without `/t`.
    const existingAces = aces(existing);
    assert.equal(existingAces.length, 3, 'an existing child is tightened too');
    assert.ok(existingAces.every(ace => ace.flags === '(I)(F)'), 'and it inherits the new grants');

    // A child written afterwards inherits as well, which is what makes the
    // SQLite `-wal` / `-shm` files safe without a second call.
    const fresh = join(dir, 'autochat.sqlite-wal');
    writeFileSync(fresh, 'wal');
    assert.equal(aces(fresh).length, 3, 'a later child inherits without a second call');
  });
});

test('a path that cannot be hardened is reported, and never thrown', () => {
  withTemp((root) => {
    const events = [];
    const missing = join(root, 'does-not-exist.txt');
    const result = harden(missing, { log: event => events.push(event), label: 'console-token' });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'the reason is kept for diagnosis');
    assert.equal(result.label, 'console-token', 'the caller-supplied label survives');
    assert.deepEqual(events, ['permissions_failed'], 'failures are logged, not swallowed silently');

    // A synchronous argument-validation throw must be caught by the same path:
    // refusing to start over an ACL would be worse than the missing ACL.
    const events2 = [];
    const broken = harden('bad\u0000name', { log: event => events2.push(event) });
    assert.equal(broken.ok, false);
    assert.deepEqual(events2, ['permissions_failed']);
  });
});

test('hardenAll aggregates, skips entries without a path and reports partial success', () => {
  withTemp((root) => {
    const good = join(root, 'a.txt');
    writeFileSync(good, 'a');
    const events = [];
    const outcome = hardenAll([
      { path: good, label: 'a' },
      { path: '' },            // skipped: nothing to do
      null,                    // skipped: malformed entry
      { path: join(root, 'gone.txt'), label: 'gone' },
    ], { log: event => events.push(event) });

    assert.equal(outcome.failed, 1, 'one path really failed');
    assert.equal(outcome.ok, false);
    // The `''` and `null` entries are dropped, not counted as passes.
    assert.equal(outcome.results.length, 2);
    if (IS_WINDOWS) {
      assert.equal(outcome.results.find(item => item.label === 'a').ok, true);
      assert.equal(outcome.results.find(item => item.label === 'gone').ok, false);
    }
    assert.ok(events.includes('permissions_incomplete'), 'a partial run is summarised in one event');
  });
});

test('the console token file is hardened on first run and repaired on later runs', { skip: !IS_WINDOWS && 'Windows-only' }, () => {
  withTemp((root) => {
    const cwd = process.cwd();
    // The token path is cwd-relative by design (`runtime/console-token.txt`), so
    // the test moves into a scratch directory rather than touching the real one.
    process.chdir(root);
    try {
      const file = join(root, 'runtime', 'console-token.txt');
      const store = new Store();
      // No `consoleToken` in the config: this is the auto-generation path.
      const first = createConsole({ config: { consolePort: 0 }, store, log: () => {}, port: 0 });
      assert.ok(existsSync(file), 'the token file is created on first run');
      assert.equal(aces(file).length, 3, 'and tightened at the moment it is written');

      // Simulate a file left behind by an older build: widen the ACL the way
      // inheritance would have, then confirm the next start repairs it. Checking
      // on read as well as on write is the whole point — an upgrade has to fix
      // the file that already exists.
      execFileSync(join(SYSTEM32, 'icacls.exe'), [file, '/grant', '*S-1-5-11:F'], { stdio: STDIO });
      assert.ok(aces(file).length > 3, 'the widened ACL is what the repair has to remove');

      const second = createConsole({ config: { consolePort: 0 }, store, log: () => {}, port: 0 });
      assert.equal(aces(file).length, 3, 'starting again narrows the pre-existing file');
      // The repair must not rotate the token: that would log the operator out
      // for no reason, and it would be an easy mistake to make by rewriting the
      // file instead of only its ACL.
      assert.equal(second.token, first.token, 'the existing token is reused, not regenerated');
      assert.equal(readFileSync(file, 'utf8').trim(), first.token);
      store.close();
    } finally {
      process.chdir(cwd);
    }
  });
});
