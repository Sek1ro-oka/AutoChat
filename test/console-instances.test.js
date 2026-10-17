// Instance aggregation (T-035): the read-only hub endpoint behind the switcher,
// plus the two cards that consume it. Every fixture here lives in its own
// mkdtemp root — the repo's own `instances/` and `data/` are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInContext } from 'node:vm';

import { createConsole } from '../src/console/server.js';
import { createHub } from '../src/console/hub.js';
import { Store } from '../src/store.js';
import { TOKEN, auth, fixture, loadConsoleScripts } from './support/console-harness.js';

// A throw-away machine root: `instances/` for the env files, `data/bots/` for the
// databases, exactly the shape scripts/instances.js writes on the real box.
const machineRoot = t => {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-instances-'));
  mkdirSync(join(root, 'instances'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

// A real database with the current schema, so `costCards` can actually read it:
// `new Store(path)` creates the directory and applies the schema, unlike the hub's
// read-only connection which refuses to create anything.
const seedDatabase = (root, name) => {
  const file = join(root, 'data', 'bots', name, 'autochat.sqlite');
  const store = new Store(file);
  store.close();
  return file;
};

const writeInstance = (root, name, lines = []) => {
  writeFileSync(join(root, 'instances', `${name}.env`), lines.join('\n') + '\n');
};

// Same shape as console-harness `fixture`, plus an injected hub: the default hub
// would read process.cwd() (this checkout) and that is not a temp directory.
// `ttlMs: 0` turns off the hub's own 5 s cache so a file written mid-test is seen
// at once; the page-side 5 s cache is what the last test below pins down.
const instancesFixture = t => {
  const root = machineRoot(t);
  const { store, config } = fixture(t);
  const bot = { queued: 0, sendFailures: 0 };
  const transport = { ready: true, retry: 0 };
  const runtime = { stats: () => [{ name: 'core', failures: 0, lastError: null }] };
  const hub = createHub({ root, config, isAlive: () => false, now: () => Date.now(), ttlMs: 0 });
  const server = createConsole({ config, store, hub, bot, transport, runtime, log: () => {}, port: 0 });
  return { root, store, config, server };
};

test('GET /api/instances needs the token and reports an added instance as unreadable', async t => {
  const { root, server } = instancesFixture(t);
  seedDatabase(root, 'main');
  writeInstance(root, 'main', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3210', 'BOT_QQ=10001']);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/instances`)).status, 401);
  const before = await (await fetch(`${base}/api/instances?token=${TOKEN}`)).json();
  assert.ok(before.counts.total >= 1);
  assert.equal(typeof before.instances[0].name, 'string');
  assert.equal(typeof before.aggregate.today.calls, 'number');

  writeInstance(root, 'x', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3211']);
  const listed = await (await fetch(`${base}/api/instances`, { headers: auth })).json();
  assert.equal(listed.counts.total, before.counts.total + 1);
  const added = listed.instances.find(row => row.name === 'x');
  assert.equal(added.ok, false);
  assert.equal(added.error, 'DATABASE_MISSING');
  assert.equal(added.database, false);
  assert.equal(added.cards.today.totalMicro, 0);
  // The rows only carry numbers; the "—" placeholder is the renderer's job.
  assert.equal(listed.instances.find(row => row.name === 'main').ok, true);
});

test('the aggregate only adds up rows whose database could be read', async t => {
  const { root, server } = instancesFixture(t);
  seedDatabase(root, 'readable');
  writeInstance(root, 'readable', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3220']);
  writeInstance(root, 'missing', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3221']);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/instances`, { headers: auth })).json();
  const readable = view.instances.find(row => row.name === 'readable');
  const missing = view.instances.find(row => row.name === 'missing');
  assert.equal(readable.ok, true);
  assert.equal(missing.ok, false);
  assert.equal(view.aggregate.today.calls, readable.cards.today.calls,
    '缺库那一行不能混进合计（它连一行都没读到）');
  assert.equal(view.aggregate.today.totalMicro, readable.cards.today.totalMicro);
  assert.equal(view.counts.ready, 1);
});

test('the cost and settings pages render the instance rows without leaking raw values', async t => {
  const { root, server } = instancesFixture(t);
  seedDatabase(root, 'main');
  writeInstance(root, 'main', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3210', 'BOT_QQ=10001']);
  writeInstance(root, 'spare', ['CONSOLE_ENABLED=false', 'CONSOLE_PORT=3211']);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const { context } = loadConsoleScripts(base);
  await new Promise(resolve => setTimeout(resolve, 150)); // 首次渲染的请求落地

  const cost = await context.__pages.cost();
  const costAt = cost.indexOf('多实例对照');
  assert.ok(costAt > 0, '计费看板要有「多实例对照」卡');
  const costCard = cost.slice(costAt);
  assert.match(costCard, /main/, '计费看板要画出实例名');
  assert.match(costCard, /spare/, '计费看板要画出第二个实例');
  assert.match(costCard, /合计/);
  assert.match(costCard, /合计只累加能读到的库/);
  assert.match(costCard, /—/, '缺库那一行的金额是破折号，不是 0');
  assert.doesNotMatch(costCard, /undefined/);
  assert.doesNotMatch(costCard, /NaN/);
  assert.doesNotMatch(costCard, /\[object Object\]/);

  const settings = await context.__pages.settings();
  const setAt = settings.indexOf('实例管理');
  assert.ok(setAt > 0, '设置页要有「实例管理」卡');
  const setCard = settings.slice(setAt);
  assert.match(setCard, /main/);
  assert.match(setCard, /spare/);
  // 缺库的行必须如实说，金额不能写成 0。
  assert.match(setCard, /这个实例还没启动过，没有库文件/);
  assert.match(setCard, /node scripts\/instances\.js add\|list\|check\|render/);
  // 只查这张卡：设置页的表单里本来就有一处 value="NaN"（「群会话清理（小时）」那个字段，
  // 与本单无关，已写进报告的遗留风险），所以整页断言会把别人的老问题算到这张卡头上。
  assert.doesNotMatch(setCard, /undefined/);
  assert.doesNotMatch(setCard, /NaN/);
  assert.doesNotMatch(setCard, /\[object Object\]/);
});

test('the switcher reads the instance list once inside five seconds and shows both names', async t => {
  const { root, server } = instancesFixture(t);
  seedDatabase(root, 'main');
  writeInstance(root, 'main', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3210']);
  writeInstance(root, 'spare', ['CONSOLE_ENABLED=true', 'CONSOLE_PORT=3211']);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const { calls, input, context } = loadConsoleScripts(base);
  await new Promise(resolve => setTimeout(resolve, 150));

  // boot 已经读过一次；先把那次请求等回来（它可能还在路上，否则待会儿两次调用会
  // 复用同一个 pending，反而看不到新请求），再把缓存时钟拨到过期。
  await runInContext('loadInstances()', context);
  runInContext('INSTANCES.at = 0; INSTANCES.value = null; INSTANCES.error = "";', context);
  calls.length = 0;
  const first = await runInContext('loadInstances()', context);
  const second = await runInContext('loadInstances()', context);
  assert.equal(calls.filter(call => call.path === '/api/instances').length, 1,
    '5 秒缓存内只许请求一次 /api/instances');
  assert.equal(first.counts.total, 2);
  assert.equal(second.counts.total, 2);

  await runInContext('renderInstances()', context);
  const html = input('#instsw').innerHTML;
  assert.match(html, /全部实例（2）/);
  assert.match(html, /main/);
  assert.match(html, /spare/);
  assert.match(html, /只筛「计费看板」与「系统设置」两张卡/, '切换器旁边必须说清它只筛哪两页');
  assert.match(html, /data-act="instance"/, '菜单项走 data-act，不许内联 onclick');
  assert.doesNotMatch(html, /onclick=/);
});
