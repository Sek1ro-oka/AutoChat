// The multi-instance skeleton (I-10 · P2): naming, env files, port allocation,
// conflict checking, secret masking, and the supervisor's `--instance` plumbing.
// This sandbox forbids child pipes, so nothing here spawns: the CLI is driven
// in-process through `run()` with captured output, and every supervisor function
// exercised here is pure or takes its files from a temp directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CODES, addInstance, baseConsolePort, checkInstances, defaultDatabasePath, displayWidth,
  instanceFile, instanceSettings, instanceSupervisorLockPath, maskSecret, nextFreePort, parsePort,
  readInstanceEnv, relativePath, renderInstance, reservedPorts, run, scanInstances, validInstanceName,
} from '../scripts/instances.js';
import {
  EXIT_USAGE, childArgs, childEnv, instanceLaunch, instanceStatusReport, lockPaths, parseArgs,
  statusReport,
} from '../scripts/supervisor.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, '.env.example');

// A checkout-shaped temp root: the real template, nothing else. `data/` is
// deliberately absent, because src/store.js is what creates it on first open.
function setup(t, { template = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-instances-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (template) copyFileSync(TEMPLATE, join(root, '.env.example'));
  return root;
}

function writeInstance(root, file, lines) {
  mkdirSync(join(root, 'instances'), { recursive: true });
  const name = file.endsWith('.env') ? file : `${file}.env`;
  writeFileSync(join(root, 'instances', name), `${lines.join('\n')}\n`);
}

function writeLock(path, pid) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z' }));
}

function capture() {
  const out = [];
  const err = [];
  return {
    out: text => out.push(text),
    err: text => err.push(text),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const alive = pid => pid === 4242;

test('实例名只接受小写短名', () => {
  for (const name of ['alpha', 'bot-1', 'a_b_2', 'x', 'a'.repeat(24)]) {
    assert.equal(validInstanceName(name), true, `应接受 ${name}`);
  }
  for (const name of ['', 'Alpha', '-alpha', '_alpha', '.hidden', 'alpha.env', 'a b', 'a'.repeat(25), 'a/../../b', null, undefined, 7]) {
    assert.equal(validInstanceName(name), false, `应拒绝 ${String(name)}`);
  }
});

test('实例路径、数据库路径和监管锁都由名字推导', () => {
  const root = join('C:', 'bot');
  assert.equal(instanceFile(root, 'alpha'), join(root, 'instances', 'alpha.env'));
  assert.equal(defaultDatabasePath('alpha'), join('data', 'bots', 'alpha', 'autochat.sqlite'));
  assert.equal(instanceSupervisorLockPath(root, 'alpha'), join(root, 'data', 'autochat-supervisor-alpha.lock'));
  assert.equal(relativePath(root, join(root, 'instances', 'alpha.env')), 'instances/alpha.env');
});

test('端口从 3200 起分配并跳过已占用的', () => {
  assert.equal(nextFreePort(new Set([3200])), 3201);
  assert.equal(nextFreePort(new Set([3200, 3201, 3202])), 3203);
  assert.equal(nextFreePort(new Set(), 65535), 65535);
  assert.equal(nextFreePort(new Set([65535]), 65535), null);
  assert.equal(parsePort('3200'), 3200);
  assert.equal(parsePort(3000), 3000);
  for (const bad of ['80', '70000', 'abc', '', null, undefined]) assert.equal(parsePort(bad), null);
  assert.equal(displayWidth('实例'), 4);
  assert.equal(displayWidth('ok'), 2);
});

test('add 从模板生成实例文件并分配空闲端口', t => {
  const root = setup(t);
  assert.equal(baseConsolePort(root), 3200, '默认 .env 的端口视为已占用');
  const first = addInstance(root, 'alpha');
  assert.equal(first.ok, true);
  assert.equal(first.port, 3201);
  assert.equal(first.databasePath, 'data/bots/alpha/autochat.sqlite');
  assert.equal(first.file, join(root, 'instances', 'alpha.env'));
  const text = readFileSync(first.file, 'utf8');
  assert.match(text, /^# 实例 alpha/m);
  assert.match(text, /^DATABASE_PATH=data\/bots\/alpha\/autochat\.sqlite$/m);
  assert.match(text, /^CONSOLE_PORT=3201$/m);
  assert.match(text, /^PERSONA_DIR=personas$/m);
  // 除这三个键以外，模板必须逐行原样保留（不依赖模板当前内容，模板改版也不会误报）。
  const template = readFileSync(TEMPLATE, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const rewritten = new Set(['DATABASE_PATH', 'CONSOLE_PORT', 'PERSONA_DIR']);
  for (const line of template.split('\n')) {
    if (!rewritten.has(line.split('=')[0])) assert.ok(text.includes(line), `模板行未保留：${line}`);
  }
  assert.equal(existsSync(join(root, 'data')), false, 'add 不预先创建数据库目录');
  const second = addInstance(root, 'beta');
  assert.equal(second.port, 3202, '第二个实例避开第一个的端口');
  assert.deepEqual([...reservedPorts(root)].sort((a, b) => a - b), [3200, 3201, 3202]);
});

test('add 拒绝覆盖已存在的实例', t => {
  const root = setup(t);
  const first = addInstance(root, 'alpha');
  const before = readFileSync(first.file, 'utf8');
  const again = addInstance(root, 'alpha');
  assert.equal(again.ok, false);
  assert.equal(again.code, CODES.exists);
  assert.match(again.message, /不覆盖/);
  assert.equal(readFileSync(first.file, 'utf8'), before);
});

test('add 拒绝非法名字与缺失模板', t => {
  const root = setup(t);
  for (const name of ['Alpha', '../alpha', 'a b', '']) {
    const result = addInstance(root, name);
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.invalidName);
  }
  assert.equal(existsSync(join(root, 'instances', 'Alpha.env')), false);
  const bare = setup(t, { template: false });
  const missing = addInstance(bare, 'alpha');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, CODES.templateMissing);
  assert.equal(existsSync(join(bare, 'instances', 'alpha.env')), false);
});

test('add 的显式端口同样校验冲突与范围', t => {
  const root = setup(t);
  addInstance(root, 'alpha');
  const free = addInstance(root, 'beta', { port: 4400 });
  assert.equal(free.ok, true);
  assert.equal(free.port, 4400);
  assert.equal(addInstance(root, 'gamma', { port: 3201 }).code, CODES.portConflict);
  assert.equal(addInstance(root, 'gamma', { port: 3200 }).code, CODES.portConflict, '默认 .env 的端口也不能用');
  assert.equal(addInstance(root, 'gamma', { port: 'nope' }).code, CODES.portInvalid);
  assert.equal(addInstance(root, 'gamma', { port: 80 }).code, CODES.portInvalid);
  assert.equal(existsSync(join(root, 'instances', 'gamma.env')), false);
});

test('check 抓出端口、数据库和 BOT_QQ 的重复', t => {
  const root = setup(t);
  writeInstance(root, 'alpha', ['BOT_QQ=111', 'CONSOLE_PORT=3301', 'DATABASE_PATH=data/bots/shared/autochat.sqlite']);
  writeInstance(root, 'beta', ['BOT_QQ=111', 'CONSOLE_PORT=3301', 'DATABASE_PATH=data/bots/shared/autochat.sqlite']);
  const result = checkInstances(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(item => item.code).sort(), [
    CODES.botQqDuplicate, CODES.databaseDuplicate, CODES.portConflict,
  ].sort());
  for (const problem of result.problems) {
    assert.deepEqual(problem.instances, ['alpha', 'beta'], problem.code);
    assert.match(problem.message, /alpha、beta/);
  }
});

test('check 报告非法实例名与非法端口', t => {
  const root = setup(t);
  writeInstance(root, 'Bad Name.env', ['BOT_QQ=1', 'CONSOLE_PORT=3301']);
  writeInstance(root, 'gamma', ['BOT_QQ=2', 'CONSOLE_PORT=abc']);
  const result = checkInstances(root);
  assert.equal(result.ok, false);
  const codes = result.problems.map(item => item.code).sort();
  assert.deepEqual(codes, [CODES.invalidName, CODES.portInvalid].sort());
  assert.equal(result.problems.find(item => item.code === CODES.invalidName).instances[0], 'Bad Name');
});

test('check 在互不冲突的实例集上通过', t => {
  const root = setup(t);
  writeInstance(root, 'alpha', ['BOT_QQ=111', 'CONSOLE_PORT=3301', 'DATABASE_PATH=data/bots/alpha/autochat.sqlite']);
  writeInstance(root, 'beta', ['BOT_QQ=222', 'CONSOLE_PORT=3302', 'DATABASE_PATH=data/bots/beta/autochat.sqlite']);
  const result = checkInstances(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.instances.map(item => item.name), ['alpha', 'beta']);
});

test('render 对密钥打码且不暴露原值', t => {
  const root = setup(t);
  writeInstance(root, 'alpha', [
    'BOT_QQ=123456789',
    'CONSOLE_PORT=3301',
    'DATABASE_PATH=data/bots/alpha/autochat.sqlite',
    'CONSOLE_TOKEN=0123456789abcdef',
    'DEEPSEEK_API_KEY=sk-1234567890abcdef',
    'EMPTY_SECRET=',
    'ONEBOT_WS_URL=ws://127.0.0.1:3001',
  ]);
  const result = renderInstance(root, 'alpha', { isAlive: () => false });
  assert.equal(result.ok, true);
  const fields = new Map(result.fields);
  assert.equal(fields.get('密钥 CONSOLE_TOKEN'), '****cdef');
  assert.equal(fields.get('密钥 DEEPSEEK_API_KEY'), '****cdef');
  assert.equal(fields.get('密钥 EMPTY_SECRET'), '<未设置>');
  assert.equal(fields.get('运行状态'), '已停止');
  assert.match(fields.get('人格库'), /personas（共享默认）/);
  const printed = result.fields.map(([, value]) => value).join(' ');
  assert.equal(printed.includes('sk-1234567890abcdef'), false, '原值不得出现在任何字段');
  assert.equal(printed.includes('0123456789abcdef'), false);
  assert.equal(maskSecret('short'), '<已设置>', '短值只显示是否设置');
  assert.equal(maskSecret('0123456789ab'), '****89ab');
  assert.equal(maskSecret(undefined), '<未设置>');
});

test('读实例文件容忍 BOM 与 CRLF，缺失实例返回稳定错误码', t => {
  const root = setup(t);
  mkdirSync(join(root, 'instances'), { recursive: true });
  writeFileSync(join(root, 'instances', 'alpha.env'), '\uFEFFBOT_QQ=123\r\nCONSOLE_PORT=3305\r\nDATABASE_PATH=data/bots/alpha/autochat.sqlite\r\n');
  const entry = readInstanceEnv(root, 'alpha');
  assert.equal(entry.ok, true);
  const settings = instanceSettings(root, 'alpha', entry.values);
  assert.equal(settings.botQq, '123');
  assert.equal(settings.consolePort, 3305);
  assert.equal(settings.databaseDeclared, true);
  assert.equal(readInstanceEnv(root, 'ghost').code, CODES.missing);
  assert.equal(instanceSettings(root, 'alpha').botQq, '', '没有字段时用约定默认值');
  assert.equal(instanceSettings(root, 'alpha').databasePath, join(root, 'data', 'bots', 'alpha', 'autochat.sqlite'));
});

test('运行状态取自该实例自己的 bot 锁', t => {
  const root = setup(t);
  writeInstance(root, 'alpha', ['BOT_QQ=111', 'CONSOLE_PORT=3301', 'DATABASE_PATH=data/bots/alpha/autochat.sqlite']);
  writeLock(join(root, 'data', 'bots', 'alpha', 'autochat.lock'), 4242);
  const [running] = scanInstances(root, { isAlive: alive });
  assert.equal(running.running, true);
  assert.equal(running.pid, 4242);
  const [stopped] = scanInstances(root, { isAlive: () => false });
  assert.equal(stopped.running, false);
  assert.equal(stopped.pid, null, '死进程不算运行中');
});

test('list、check、render、add 的 CLI 行为与退出码', t => {
  const root = setup(t);
  const empty = capture();
  assert.equal(run(['list'], { root, out: empty.out, err: empty.err }), 0);
  assert.match(empty.stdout(), /还没有任何实例/);

  addInstance(root, 'alpha');
  const listed = capture();
  assert.equal(run(['list'], { root, out: listed.out, err: listed.err }), 0);
  assert.match(listed.stdout(), /alpha/);
  assert.match(listed.stdout(), /3201/);
  assert.match(listed.stdout(), /已停止/);
  assert.match(listed.stdout(), /共 1 个实例/);

  const rendered = capture();
  assert.equal(run(['render', 'alpha'], { root, out: rendered.out, err: rendered.err }), 0);
  assert.match(rendered.stdout(), /生效配置/);
  assert.match(rendered.stdout(), /密钥已打码/);

  const missing = capture();
  assert.equal(run(['render', 'nope'], { root, out: missing.out, err: missing.err }), 1);
  assert.match(missing.stderr(), /INSTANCE_MISSING/);

  for (const [argv, code, pattern] of [
    [['render', 'Bad'], EXIT_USAGE, /INVALID_INSTANCE_NAME/],
    [['add'], EXIT_USAGE, /INVALID_INSTANCE_NAME/],
    [['add', 'Bad'], EXIT_USAGE, /INVALID_INSTANCE_NAME/],
    [['add', 'alpha'], 1, /INSTANCE_EXISTS/],
    [['wat'], EXIT_USAGE, /未知子命令/],
  ]) {
    const io = capture();
    assert.equal(run(argv, { root, out: io.out, err: io.err }), code, argv.join(' '));
    assert.match(io.stderr(), pattern, argv.join(' '));
  }

  const added = capture();
  assert.equal(run(['add', 'beta'], { root, out: added.out, err: added.err }), 0);
  assert.match(added.stdout(), /已创建 instances\/beta\.env/);
  assert.match(added.stdout(), /控制台端口 3202/);
});

test('check 子命令在发现冲突时以非 0 退出', t => {
  const root = setup(t);
  writeInstance(root, 'alpha', ['BOT_QQ=111', 'CONSOLE_PORT=3301']);
  writeInstance(root, 'beta', ['BOT_QQ=111', 'CONSOLE_PORT=3301']);
  const io = capture();
  assert.equal(run(['check'], { root, out: io.out, err: io.err }), 1);
  assert.match(io.stdout(), /PORT_CONFLICT/);
  assert.match(io.stdout(), /BOT_QQ_DUPLICATE/);
  assert.match(io.stdout(), /发现 2 个问题/);
});

test('supervisor 的 --instance 参数解析', () => {
  assert.deepEqual(parseArgs([]), { ok: true, status: false, instance: null });
  assert.deepEqual(parseArgs(['--status']), { ok: true, status: true, instance: null });
  assert.deepEqual(parseArgs(['--instance', 'alpha']), { ok: true, status: false, instance: 'alpha' });
  assert.deepEqual(parseArgs(['--instance=alpha']), { ok: true, status: false, instance: 'alpha' });
  assert.deepEqual(parseArgs(['--status', '--instance', 'alpha']), { ok: true, status: true, instance: 'alpha' });
  assert.equal(parseArgs(['--instance']).code, 'INSTANCE_NAME_MISSING');
  assert.equal(parseArgs(['--instance', '--status']).code, 'INSTANCE_NAME_MISSING');
  assert.equal(parseArgs(['--instance', '-x']).code, 'INSTANCE_NAME_MISSING');
  assert.equal(parseArgs(['--instance', 'Alpha']).code, 'INVALID_INSTANCE_NAME');
  assert.equal(parseArgs(['--instance=Alpha']).code, 'INVALID_INSTANCE_NAME');
  assert.equal(parseArgs(['--wat']).code, 'UNKNOWN_ARGUMENT');
  assert.equal(parseArgs(['--wat']).ok, false);
});

test('--instance 更换子进程的 env 文件并注入实例名，默认路径不变', () => {
  const root = join('C:', 'bot');
  assert.deepEqual(childArgs(root), [`--env-file=${join(root, '.env')}`, join(root, 'src', 'main.js')]);
  assert.deepEqual(childArgs(root, { instance: 'alpha' }), [
    `--env-file=${join(root, 'instances', 'alpha.env')}`,
    join(root, 'src', 'main.js'),
  ]);
  // The default call must stay byte-for-byte what T-019's tests pin down.
  assert.deepEqual(childEnv({ KEEP: '1', AUTOCHAT_SUPERVISED: '0' }, 777), {
    KEEP: '1', AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: '777',
  });
  const env = childEnv(
    { DATABASE_PATH: 'data/autochat.sqlite', BOT_QQ: '999', CONSOLE_PORT: '3200', KEEP: '1' },
    777,
    { instance: 'alpha', shadow: ['DATABASE_PATH', 'BOT_QQ', 'CONSOLE_PORT'] },
  );
  assert.deepEqual(env, {
    KEEP: '1', AUTOCHAT_SUPERVISED: '1', AUTOCHAT_SUPERVISOR_PID: '777', AUTOCHAT_INSTANCE: 'alpha',
  });
});

test('instanceLaunch 用实例的锁、配置文件和清理过的环境', t => {
  const root = setup(t);
  assert.equal(instanceLaunch(root, 'ghost', { base: {}, pid: 1 }).code, CODES.missing);
  writeInstance(root, 'alpha', ['BOT_QQ=', 'DATABASE_PATH=data/bots/alpha/autochat.sqlite', 'CONSOLE_PORT=3301']);
  const target = instanceLaunch(root, 'alpha', {
    base: { DATABASE_PATH: 'data/autochat.sqlite', BOT_QQ: '999', KEEP: '1' }, pid: 777,
  });
  assert.equal(target.ok, true);
  assert.equal(target.paths.supervisorLock, join(root, 'data', 'autochat-supervisor-alpha.lock'));
  assert.equal(target.paths.botLock, join(root, 'data', 'bots', 'alpha', 'autochat.lock'));
  assert.deepEqual(target.args, [`--env-file=${join(root, 'instances', 'alpha.env')}`, join(root, 'src', 'main.js')]);
  assert.equal(target.env.AUTOCHAT_INSTANCE, 'alpha');
  assert.equal(target.env.AUTOCHAT_SUPERVISOR_PID, '777');
  assert.equal(target.env.DATABASE_PATH, undefined, '继承的根 .env 值必须被删掉');
  assert.equal(target.env.BOT_QQ, undefined);
  assert.equal(target.env.KEEP, '1');
});

test('instanceStatusReport 每个实例一份状态', t => {
  const root = setup(t);
  const missing = instanceStatusReport(root, 'ghost', { isAlive: () => false });
  assert.equal(missing.error, CODES.missing);
  assert.equal(missing.running, false);
  assert.equal(missing.locks.supervisor, join(root, 'data', 'autochat-supervisor-ghost.lock'));
  writeInstance(root, 'alpha', ['BOT_QQ=111', 'CONSOLE_PORT=3301', 'DATABASE_PATH=data/bots/alpha/autochat.sqlite']);
  writeLock(join(root, 'data', 'bots', 'alpha', 'autochat.lock'), 4242);
  const live = instanceStatusReport(root, 'alpha', { isAlive: alive });
  assert.equal(live.running, true);
  assert.equal(live.botPid, 4242);
  assert.equal(live.locks.supervisor, join(root, 'data', 'autochat-supervisor-alpha.lock'));
  const dead = instanceStatusReport(root, 'alpha', { isAlive: () => false });
  assert.equal(dead.running, false);
  assert.equal(dead.botPid, null);
});

test('实例监管锁按实例区分，默认锁定路径不受影响', () => {
  const root = join('C:', 'bot');
  const defaults = lockPaths(root, {});
  assert.equal(defaults.supervisorLock, join(root, 'data', 'autochat-supervisor.lock'));
  assert.equal(defaults.botLock, join(root, 'data', 'autochat.lock'));
  assert.notEqual(instanceSupervisorLockPath(root, 'alpha'), instanceSupervisorLockPath(root, 'beta'));
  assert.notEqual(instanceSupervisorLockPath(root, 'alpha'), defaults.supervisorLock);
  const report = statusReport(root, () => false);
  assert.deepEqual(Object.keys(report).sort(), ['botPid', 'botStartedAt', 'locks', 'running', 'supervisorPid']);
  assert.deepEqual(report.locks, { bot: join(root, 'data', 'autochat.lock'), supervisor: join(root, 'data', 'autochat-supervisor.lock') });
  assert.equal(report.running, false);
});
