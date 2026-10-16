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
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADMINISTRATORS_SID, SYSTEM_SID, currentUserSid, harden, hardenAll, secretTargets,
} from '../src/permissions.js';
import { createLogger } from '../src/logger.js';
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

// The `subject:(flags)` parse of `aces()`, on text instead of on a path, so the
// rule below can be checked on a listing without spawning anything.
const ACE_ENTRY = /([^\s]+):((?:\((?:OI|CI|IO|I|F|M|RX|GR|GE|D|N|WD|AD|S|X|W|R)\))+)\s*$/;
const acesFromText = text => String(text)
  .split(/\r?\n/)
  .map(line => line.match(ACE_ENTRY))
  .filter(Boolean)
  .map(match => ({ subject: match[1], flags: match[2] }));

// A verdict on "is this DACL tightened?" must come from the entries, so the
// integrity-label line is dropped before the principal is read rather than being
// left to the flag alternation: `icacls` prints it as
// `Mandatory Label\Low Mandatory Level:(I)(NW)`, and on a tightened directory it
// always carries the inherited marker. The marker belongs to a mandatory label,
// which is not an access control entry at all.
const parseAces = text => String(text)
  .split(/\r?\n/)
  .filter(line => !/Mandatory Label\\/i.test(line))
  .map(line => line.match(ACE_ENTRY))
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
    const records = [];
    const missing = join(root, 'does-not-exist.txt');
    const result = harden(missing, { log: (event, detail) => records.push({ event, detail }), label: 'console-token' });
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'the reason is kept for diagnosis');
    assert.equal(result.label, 'console-token', 'the caller-supplied label survives');
    assert.deepEqual(records.map(record => record.event), ['permissions_failed'], 'failures are logged, not swallowed silently');
    // The reason used to reach the return value only, so a failure left nothing in
    // the log to diagnose after the fact. It now rides along with the event.
    assert.equal(records[0].detail.label, 'console-token', 'the failing target is named in the log');
    assert.ok(typeof records[0].detail.reason === 'string' && records[0].detail.reason.length > 0,
      'the log carries the reason, not just the fact of failure');

    // A synchronous argument-validation throw must be caught by the same path:
    // refusing to start over an ACL would be worse than the missing ACL.
    const events2 = [];
    const broken = harden('bad\u0000name', { log: event => events2.push(event) });
    assert.equal(broken.ok, false);
    assert.deepEqual(events2, ['permissions_failed']);

    // The same failure through the *real* logger: the day's log file — not just a
    // spy — has to name the target and the reason, or an ACL failure is
    // undiagnosable after the fact (which is how it used to be). This goes
    // through the pre-existing failing-path fixture above; the assertion adds no
    // new process spawn of its own and holds whether the failure comes from a
    // missing path or from a blocked `whoami`.
    const logDir = join(root, 'logs');
    const logged = harden(join(root, 'also-gone.txt'), { log: createLogger(logDir), label: 'gone' });
    assert.equal(logged.ok, false, 'a path that does not exist cannot be hardened');
    const day = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(join(logDir, `${day}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const failure = lines.find(record => record.event === 'permissions_failed');
    assert.ok(failure, 'the failure reaches logs/<UTC date>.jsonl');
    assert.equal(failure.detail.label, 'gone', 'the log line names the failing target');
    assert.ok(typeof failure.detail.reason === 'string' && failure.detail.reason.length > 0,
      'the log line carries a non-empty reason');
  });
});

test('hardenAll aggregates, skips entries without a path and reports partial success', () => {
  withTemp((root) => {
    const good = join(root, 'a.txt');
    writeFileSync(good, 'a');
    const records = [];
    const events = [];
    const outcome = hardenAll([
      { path: good, label: 'a' },
      { path: '' },            // skipped: nothing to do
      null,                    // skipped: malformed entry
      { path: join(root, 'gone.txt'), label: 'gone' },
    ], { log: (event, detail) => { events.push(event); records.push({ event, detail }); } });

    assert.equal(outcome.failed, 1, 'one path really failed');
    assert.equal(outcome.ok, false);
    // The `''` and `null` entries are dropped, not counted as passes.
    assert.equal(outcome.results.length, 2);
    if (IS_WINDOWS) {
      assert.equal(outcome.results.find(item => item.label === 'a').ok, true);
      assert.equal(outcome.results.find(item => item.label === 'gone').ok, false);
    }
    assert.ok(events.includes('permissions_incomplete'), 'a partial run is summarised in one event');
    const summary = records.find(record => record.event === 'permissions_incomplete');
    assert.deepEqual(summary?.detail.failed, ['gone'],
      'the summary names every target that failed, not just how many did');
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

// --- startup target list (structural, no process spawned) --------------------

// Reading the module as text keeps these assertions runnable on a machine where
// the sandbox refuses to spawn `icacls.exe` — which is exactly the machine the
// breakage they guard against would be discovered on.

const readSource = () => readFileSync(new URL('../src/permissions.js', import.meta.url), 'utf8');

test('the startup target list is data, and never contains a runtime/ path', () => {
  const config = { databasePath: join('data', 'autochat.sqlite'), personaDirectory: 'personas' };
  const scenario = (envExists, personasExists) => secretTargets(config, {
    exists: path => (path.endsWith('.env') ? envExists : personasExists),
    logDirectory: join('logs'),
  });
  const plain = target => ({ path: target.path, directory: target.directory, label: target.label });

  // Order is part of the contract: the sweep runs in this order at startup.
  assert.deepEqual(scenario(true, true).map(plain), [
    { path: 'data', directory: true, label: 'data' },
    { path: join('logs'), directory: true, label: 'logs' },
    { path: resolve('.env'), directory: undefined, label: 'env' },
    { path: resolve('personas'), directory: true, label: 'personas' },
  ]);
  // `data/` and `logs/` are created by `new Store()` and `createLogger()` before
  // the sweep, so they are tightened even on a machine where neither exists yet.
  // `env` and `personas/` are created later (`.env` by hand, `personas/` lazily),
  // so they are guarded — and the guard really is consulted.
  assert.deepEqual(scenario(false, false).map(target => target.label), ['data', 'logs']);
  assert.deepEqual(scenario(false, true).map(target => target.label), ['data', 'logs', 'personas']);
  assert.deepEqual(scenario(true, false).map(target => target.label), ['data', 'logs', 'env']);
  // `runtime/` is deliberately not tightened as a whole (see docs/security.md):
  // it holds the portable Node runtime, the NapCat install and the download
  // cache. Files there are tightened at the moment they are written instead.
  for (const target of scenario(true, true)) {
    assert.ok(!String(target.path).replace(/\\/g, '/').split('/').includes('runtime'), `no runtime/ target: ${target.path}`);
  }
});

test('the hardening command never gains the recursive flag, and says why in the source', () => {
  const source = readSource();
  // The three ordered steps that make one call converge to exactly three ACEs.
  for (const flag of ['/inheritance:r', '/remove:g', '/grant:r']) {
    assert.ok(source.includes(`'${flag}'`), `${flag} must be passed as a quoted literal`);
  }
  // Built from character codes on purpose: spelling the pattern out as a literal
  // here would make this very file the first thing a whole-repo search reports,
  // and the rule is about the module that spawns icacls — not about the
  // assertion that guards it. Equivalent to a pattern matching a quoted slash
  // followed by `t` or `T`, then the same quote again.
  const recursiveFlag = new RegExp(`${String.fromCharCode(40, 91, 39, 34, 93, 41)}${String.fromCharCode(92)}/[tT]${String.fromCharCode(92)}1`);
  assert.ok(!recursiveFlag.test(source),
    'a quoted /T or /t literal reappeared: it strips inherited ACEs from every child first, and a file left with no explicit ACE has an empty DACL — denied to everyone, owner included');
  // The incident is one argument away, so the reason lives next to the command.
  const prose = source.replace(/`/g, '').toLowerCase();
  assert.ok(prose.includes('(oi)(ci)') && prose.includes('directory-only'),
    'the module must spell out that the (OI)/(CI) flags are directory-only propagation flags');
  assert.ok(prose.includes('inheritance:r') && prose.includes('empty dacl') && prose.includes('owner'),
    'and that /inheritance:r runs first, so a file without an explicit ACE ends up with an empty DACL — including for the owner');
  assert.ok(prose.includes('already-existing children'),
    'and that no recursive flag is needed, because icacls updates existing children on its own');
});

test('DACL verdicts must parse ACE entries, never match (I) anywhere in the output', () => {
  // A real `icacls` listing, shape preserved: the first line is prefixed with the
  // path it describes, continuation lines are indented, the footer is noise, and
  // the last line is an integrity label rather than an access control entry. That
  // label line carries the inherited marker — on a genuinely tightened directory.
  const listing = [
    'data AUTCHAT\\user:(OI)(CI)(F)',
    '     BUILTIN\\Administrators:(OI)(CI)(F)',
    '     BUILTIN\\Users:(RX)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
    '',
    '',
    'Mandatory Label\\Low Mandatory Level:(I)(NW)',
  ].join('\r\n');

  // The plain `subject:(flags)` parse already refuses this label line, but only by
  // accident: an integrity label's flags (`NW`, `NR`, `NX`) are not access masks,
  // so nothing in the alternation matches `(I)(NW)` as a whole. Printed with
  // access-shaped flags the same line would read as an inherited entry held by a
  // principal called `Level` — which is why the filter above states the rule out
  // loud instead of resting on that accident.
  assert.deepEqual(acesFromText('Mandatory Label\\Low Mandatory Level:(I)(NW)'), [],
    'an integrity label is not an access control entry');
  assert.deepEqual(acesFromText('Mandatory Label\\Low Mandatory Level:(I)'), [{ subject: 'Level', flags: '(I)' }],
    'the accidental skip above is one flag list away from failing');
  assert.deepEqual(parseAces('Mandatory Label\\Low Mandatory Level:(I)'), [],
    'the explicit filter is what makes the verdict independent of the flag list');

  // The verdict that counts: three principals, nothing inherited, no label.
  const verdicts = parseAces(listing);
  assert.deepEqual(verdicts.map(entry => entry.subject),
    ['AUTCHAT\\user', 'BUILTIN\\Administrators', 'BUILTIN\\Users'],
    'the settings line and the integrity label are not entries');
  assert.equal(verdicts[0].flags, '(OI)(CI)(F)');
  assert.equal(verdicts.filter(entry => entry.flags.includes('(I)')).length, 0,
    'nothing on a tightened directory is inherited, however the raw text reads');
  assert.ok(!verdicts.some(entry => entry.subject === 'Level' || entry.subject.includes('Mandatory')),
    'the integrity label must never reach the principal set');

  // Now the trap, on the same sample: a whole-output search reports "inherited
  // ACE present" for the very directory whose parsed entries say otherwise. Wire
  // that search to a re-run of the command above and every startup repeats a
  // destructive step (upstream incident (2)).
  const wholeOutputVerdict = /\(I\)/.test(listing);
  assert.equal(wholeOutputVerdict, true, 'the trap really is present in this sample');
  assert.notEqual(wholeOutputVerdict, verdicts.some(entry => entry.flags.includes('(I)')),
    'the two verdicts must disagree — that is the whole point of parsing entries');
});
