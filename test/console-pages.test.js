// Console page reads and guarded writes: persona, behaviour, simulation,
// settings, slang and group pages (I-08: split out of the 587-line file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { GROUP_KEYS } from '../src/group-settings.js';
import { Slang } from '../src/social/slang.js';
import { DEFAULT_PERSONA } from '../src/persona.js';
import { TOKEN, auth, jsonPost, fixture, personaFixture, socialFixture, slangFixture, Social } from './support/console-harness.js';

test('persona writes require the header token and a loopback origin', async t => {
  const { server } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  // A query-string token is fine for reads (that is how the printed link works)
  // but never for writes: a URL can be replayed by a third party.
  const onlyQuery = await fetch(`${base}/api/personas/file?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '甲', content: '内容' }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/personas/file', { name: '甲', content: '内容' },
    { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');
  assert.equal((await jsonPost(base, '/api/personas/file', { name: '甲', content: '内容' })).status, 200);
});

test('a card saved in the console changes the very next resolved prompt', async t => {
  const { server, personas } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const saved = await (await jsonPost(base, '/api/personas/file', { name: '测试卡', content: '你是测试角色。' })).json();
  assert.equal(saved.saved.name, '测试卡');
  assert.equal(saved.characters.length, 1);
  assert.equal(saved.characters[0].active, false);

  const activated = await (await jsonPost(base, '/api/personas/active', { name: '测试卡' })).json();
  assert.equal(activated.source, 'card');
  assert.equal(personas.resolve(), '你是测试角色。');

  const file = await (await fetch(`${base}/api/personas/file?name=${encodeURIComponent('测试卡')}`, { headers: auth })).json();
  assert.equal(file.content, '你是测试角色。');
  assert.equal(file.exists, true);

  // Only client-caused failures get a real status code instead of a blanket 500.
  const bad = await jsonPost(base, '/api/personas/file', { name: '../evil', content: '内容' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'PERSONA_NAME_INVALID');
  assert.equal((await jsonPost(base, '/api/personas/file', { name: '测试卡', content: '' })).status, 400);
  assert.equal((await jsonPost(base, '/api/personas/active', { name: '不存在' })).status, 404);
  assert.equal((await jsonPost(base, '/api/personas/file', null)).status, 400, 'a malformed body is 400');

  const removed = await (await jsonPost(base, '/api/personas/delete', { name: '测试卡' })).json();
  assert.equal(removed.deleted, '测试卡');
  assert.equal(removed.active, '', 'deleting the active card clears the selection');
  assert.equal((await jsonPost(base, '/api/personas/delete', { name: '测试卡' })).status, 404);
});

test('the behaviour layer round-trips through the console but only applies after a restart', async t => {
  const { server, personas } = personaFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const before = await (await fetch(`${base}/api/personas/file?kind=behavior`, { headers: auth })).json();
  assert.equal(before.kind, 'behavior');
  assert.equal(before.exists, false);
  assert.equal(before.restart, true);

  const after = await (await jsonPost(base, '/api/personas/file', { kind: 'behavior', content: '先观察再开口。' })).json();
  assert.equal(after.restart, true);
  assert.equal(after.behavior.onDisk, true);
  assert.equal(after.behavior.loaded, false, 'the running process keeps its old protocol');
  assert.equal(after.behavior.pending, true);
  assert.equal(personas.resolve(), DEFAULT_PERSONA);
});

test('the simulation page reads state and accepts only guarded parameter writes', async t => {
  const { server } = socialFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/social`, { headers: auth })).json();
  assert.equal(view.available, true);
  assert.equal(view.enabled, false, 'off by default, matching a stock .env');
  assert.equal(view.groups[0].id, '20000');
  assert.equal(view.groups[0].state, 'observing');
  assert.equal(view.groups[0].decision, null);

  const onlyQuery = await fetch(`${base}/api/social/config?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/social/config', { enabled: true }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');

  const enabled = await (await jsonPost(base, '/api/social/config', { enabled: true, threshold: 3 })).json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.params.threshold, 3);
  assert.equal((await jsonPost(base, '/api/social/config', { threshold: 999 })).status, 400);
  assert.equal((await jsonPost(base, '/api/social/config', { cooldownSeconds: 1 })).status, 400);
  assert.equal((await jsonPost(base, '/api/social/config', { group: '99999', muted: true })).status, 400);
});

test('the settings page lists configurable fields and applies guarded edits', async t => {
  const { server, store } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const view = await (await fetch(`${base}/api/settings`, { headers: auth })).json();
  assert.ok(view.fields.length > 0);
  assert.ok(view.groups.some(group => group.id === 'budget'));
  const budget = view.fields.find(field => field.name === 'budgetMicro');
  assert.equal(budget.value, '1', '1,000,000 micro = 1 yuan');
  assert.equal(budget.defaultValue, '1');

  // Writes need the header token and a loopback origin, like every other write.
  const onlyQuery = await fetch(`${base}/api/settings?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'budgetMicro', value: '2' }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');

  const edited = await (await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '2' })).json();
  assert.equal(edited.fields.find(field => field.name === 'budgetMicro').value, '2');
  assert.equal(store.setting('cfg:budget_cny', null), '2');

  // Out-of-range or unknown fields are rejected with a real status code.
  assert.equal((await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '-5' })).status, 400);
  assert.equal((await jsonPost(base, '/api/settings', { name: 'nope', value: '1' })).status, 400);

  // Clearing the value deletes the row, restoring the .env default.
  const cleared = await (await jsonPost(base, '/api/settings', { name: 'budgetMicro', value: '' })).json();
  assert.equal(cleared.fields.find(field => field.name === 'budgetMicro').value, '1');
  assert.equal(store.setting('cfg:budget_cny', null), null);
});

test('the slang page reads the library, guards its writes and keeps chat text out of the list', async t => {
  const { server, slang, store } = slangFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  const empty = await (await fetch(`${base}/api/slang`, { headers: auth })).json();
  assert.equal(empty.available, true);
  assert.equal(empty.enabled, true);
  assert.equal(empty.stats.total, 0);
  assert.equal(empty.preview, '', 'nothing is injected before a human confirms anything');
  assert.deepEqual(empty.groups, ['20000']);

  // Writes need the header token and a loopback origin, like every other write.
  const onlyQuery = await fetch(`${base}/api/slang/config?token=${TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(onlyQuery.status, 403);
  assert.equal((await onlyQuery.json()).error, 'header_token_required');
  const foreign = await jsonPost(base, '/api/slang/extract', { group: '20000' }, { Origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'origin_rejected');

  // Extraction costs a model call, so the failure modes must be real statuses.
  assert.equal((await jsonPost(base, '/api/slang/extract', { group: '99999' })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/extract', { group: '20000' })).status, 200);

  const listed = await (await fetch(`${base}/api/slang`, { headers: auth })).json();
  assert.equal(listed.stats.candidate, 1);
  assert.equal(listed.entries[0].term, 'yyds');
  assert.equal(listed.entries[0].example, undefined, 'a verbatim group quote never rides along with the list');
  const id = listed.entries[0].id;

  const detail = await (await fetch(`${base}/api/slang/entry?id=${id}`, { headers: auth })).json();
  assert.equal(detail.entry.example, '这才是 yyds', 'it is served on an explicit click');

  const confirmed = await (await jsonPost(base, '/api/slang/status', { id, status: 'confirmed' })).json();
  assert.equal(confirmed.stats.confirmed, 1);
  assert.match(confirmed.preview, /yyds = 永远的神/, 'the page shows exactly what would be injected');
  assert.equal(store.listSlang({ status: 'confirmed' }).length, 1);

  assert.equal((await jsonPost(base, '/api/slang/status', { id, status: 'nonsense' })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/status', { id: 'missing', status: 'confirmed' })).status, 404);
  assert.equal((await jsonPost(base, '/api/slang/entry', { id })).status, 400);
  assert.equal((await jsonPost(base, '/api/slang/lookup', { id })).status, 409, 'web search is off in this fixture');
  assert.equal((await jsonPost(base, '/api/slang/delete', { id: 'missing' })).status, 404);

  // Backup export is a read; restore refuses a corrupt file instead of emptying the library.
  const exported = await (await fetch(`${base}/api/slang/export`, { headers: auth })).json();
  assert.equal(exported.version, 1);
  assert.equal(exported.entries.length, 1);
  assert.equal((await jsonPost(base, '/api/slang/import', { text: '{ broken' })).status, 400);
  assert.equal(store.countSlang().total, 1, 'a failed restore changes nothing');

  const removed = await (await jsonPost(base, '/api/slang/delete', { id })).json();
  assert.equal(removed.stats.total, 0);
  assert.equal(slang.describe().preview, '');
});

// 控制台前端是经典脚本，没有模块边界，只能按 index.html 的顺序在同一 vm 上下文里跑。
// 这里搭一个最小假 DOM：只实现这些脚本真正碰到的接口，其余返回空值走各自的兜底分支。
const fakeConsole = created => {
  class El {
    constructor(tag = 'div') {
      this.tagName = tag; this.value = ''; this.textContent = ''; this.className = '';
      this.dataset = {}; this.style = {}; this.attrs = {}; this.writes = 0;
      this._html = ''; this._classes = new Set(); this.validity = { badInput: false };
      this.classList = {
        add: name => this._classes.add(name),
        remove: name => this._classes.delete(name),
        contains: name => this._classes.has(name),
      };
    }
    set innerHTML(value) { this._html = String(value); this.writes += 1; }
    get innerHTML() { return this._html; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    before(node) { this.anchor = node; }
    prepend(node) { this.anchor = node; }
    remove() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  const pick = (map, key) => { if (!map.has(key)) map.set(key, new El()); return map.get(key); };
  const ids = new Map(), selectors = new Map();
  const document = {
    hidden: false,
    documentElement: new El('html'),
    getElementById: id => pick(ids, id),
    querySelector: selector => pick(selectors, selector),
    querySelectorAll: () => [],
    createElement: tag => { const node = new El(tag); created.push(node); return node; },
  };
  return { document, main: pick(ids, 'main'), input: selector => pick(selectors, selector) };
};

// 与 index.html 里的 <script src> 顺序一致：core 先定义工具，页面脚本往 pages 上挂，
// app.js 最后启动路由与事件委派。
const CONSOLE_SCRIPTS = ['core.js', 'pages-overview.js', 'pages-model.js', 'pages-personas.js', 'pages-groups.js',
  'pages-activity.js', 'pages-assets.js', 'assets-stickers.js', 'assets-slang.js', 'pages-cost.js',
  'pages-logs.js', 'pages-settings.js', 'app.js'];

// 只把真请求转给测试服务器，其余（主题、图标之类）就地成功即可。
const loadConsoleScripts = base => {
  const created = [], calls = [];
  const { document, main, input } = fakeConsole(created);
  const stored = new Map([['autochat.console.token', TOKEN]]);
  const context = vm.createContext({
    document,
    location: { search: '', pathname: '/' },
    history: { replaceState: () => {} },
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, String(value)),
      removeItem: key => stored.delete(key),
    },
    window: { matchMedia: () => ({ matches: false }), confirm: () => true },
    fetch: (target, init = {}) => {
      const path = String(target);
      calls.push({ path, method: (init.method ?? 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body) : null });
      if (!path.startsWith('/api/')) return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      return fetch(base + path, { ...init, headers: { 'x-console-token': TOKEN, ...(init.headers ?? {}) } });
    },
    setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    console, URLSearchParams, URL, Blob,
  });
  for (const name of CONSOLE_SCRIPTS) {
    const file = new URL(`../src/console/public/${name}`, import.meta.url);
    new vm.Script(readFileSync(file, 'utf8'), { filename: name }).runInContext(context);
  }
  // 顶层 const 在 vm 里可见但不会挂到 context 对象上，取出来才能直接调页面函数。
  vm.runInContext('globalThis.__pages = pages;', context);
  // 改版后页面不再往 window 上挂全局函数：唯一入口是 ACTIONS 表（事件委派用）。
  vm.runInContext('globalThis.__actions = ACTIONS;', context);
  return { calls, created, context, input, main };
};

test('the group page marks an override, clears it by english key, and refuses a blank locally', async t => {
  const { store, server } = socialFixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  store.set(GROUP_KEYS.socialThreshold('20000'), '3');
  store.set(GROUP_KEYS.socialCooldown('20000'), '30');
  store.set(GROUP_KEYS.socialDailyLimit('20000'), '9');
  const dump = () => store.db.prepare('SELECT key, value FROM settings ORDER BY key').all()
    .map(row => `${row.key}=${row.value}`).join('\n');

  const { calls, context, input, main } = loadConsoleScripts(base);
  await new Promise(resolve => setTimeout(resolve, 150)); // 等首次渲染的请求落地，别和下面的快照抢

  const html = await context.__pages.groups();
  const blockOf = (source, name) => {
    const id = source.indexOf(`id="g-${name}-20000"`);
    assert.ok(id > 0, `群设置页缺 ${name} 输入框`);
    // 从 <input 开始切，这样「输入框自己的属性」和它后面的说明都落在同一块里。
    return source.slice(source.lastIndexOf('<input', id), source.indexOf('</label>', id));
  };
  for (const name of ['threshold', 'cooldownSeconds', 'dailyLimit']) {
    const block = blockOf(html, name);
    assert.match(block, /type="number"/, `${name} 要用数字输入框`);
    assert.match(block, /本群自定义/, '有覆盖的行必须说出来，不能一律显示成继承');
    assert.doesNotMatch(block, /继承全局（\d/, '有覆盖时不能再显示继承来的全局值');
    // 改版后没有内联 onclick：清除按钮只带 data-*，由 app.js 的唯一监听器派发。
    assert.match(block, new RegExp(`data-act="groupSocialInherit" data-group="20000" data-key="${name}"`),
      '清除按钮必须把接口认识的英文键传回去');
    assert.doesNotMatch(block, /onclick=/, 'CSP 禁内联处理器，按钮不能带 onclick');
  }

  calls.length = 0;
  await context.__actions.get('groupSocialInherit')({ dataset: { group: '20000', key: 'threshold' } });
  const cleared = calls.filter(call => call.method === 'POST');
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].path, '/api/groups/config');
  assert.deepEqual(cleared[0].body, { group: '20000', subsystem: 'social', threshold: null });
  assert.equal(store.setting(GROUP_KEYS.socialThreshold('20000'), 'absent'), 'absent');
  const refreshed = await context.__pages.groups();
  assert.match(blockOf(refreshed, 'threshold'), /继承全局（6）/, '清掉覆盖后要说清楚继承的是哪个全局值');
  assert.match(blockOf(refreshed, 'cooldownSeconds'), /本群自定义/, '别的字段不能被连带说成继承');
  await new Promise(resolve => setTimeout(resolve, 150)); // 上面那次重绘落地再取快照

  input('#g-threshold-20000').value = '';
  input('#g-cooldownSeconds-20000').value = '30';
  input('#g-dailyLimit-20000').value = '9';
  const before = dump(), renders = main.writes;
  calls.length = 0;
  await context.__actions.get('groupSocialSave')({ dataset: { group: '20000' } });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0,
    '空值必须在客户端就地拦下：整个保存动作一个请求都不发');
  assert.equal(dump(), before, '一次都没写库');
  assert.equal(main.writes, renders, '不重绘，操作者刚填的其它字段要留着');
  // 提示写进 #groups-notice（原地更新），所以断言的是这个节点的内容而不是新建节点。
  const notice = input('#groups-notice').innerHTML;
  assert.match(notice, /需在 0-100 之间/, '必须给出可见提示，不能悄悄不发请求');
  assert.match(notice, /本次没有保存任何改动/);
  assert.equal(input('#g-threshold-20000').value, '', '输入框内容保持，让人接着改');
  assert.equal(input('#g-cooldownSeconds-20000').value, '30', '同一行别的字段不能被清掉');
  assert.ok(input('#g-threshold-20000').classList.contains('is-invalid'), '出错的输入框要标出来');

  // B-3：失败原因要让操作者看懂，但不能把没收录的码也一起吞掉。
  const ui = vm.runInContext('({ explain, reason })', context);
  assert.doesNotMatch(ui.explain('SOCIAL_PARAM_NOT_GROUP_SCOPED'), /^SOCIAL_PARAM_NOT_GROUP_SCOPED$/,
    '页面不该把内部错误码原样丢给操作者');
  assert.match(ui.reason(new Error('SOCIAL_PARAM_NOT_GROUP_SCOPED')), /不能按群单独设置/);
  assert.equal(ui.explain('SOMETHING_NEW'), 'SOMETHING_NEW', '没收录的码照原样显示');

  // 入口 B（全局仿真参数）：POST /api/social/config 不带 group 写的就是全局，
  // 所以活动页得有可编辑控件——但只给运行期真有写入路径的字段，上下文条数/
  // 分段数/打字延迟来自配置文件，仍然只读，避免长出「改了不生效」的控件。
  const activity = await context.__pages.activity();
  for (const key of ['threshold', 'cooldownSeconds', 'dailyLimit', 'idleMinutes', 'idleHours']) {
    assert.match(activity, new RegExp(`id="act-${key}"`), `${key} 可以全局改，必须有输入框`);
  }
  assert.match(activity, /data-act="activityToggle" data-value="idleEnabled"/, '插话开关要能改');
  for (const key of ['contextMessages', 'maxChunks', 'minDelayMs', 'maxDelayMs', 'messageTtlHours']) {
    assert.doesNotMatch(activity, new RegExp(`id="act-${key}"`), `${key} 没有运行期写入路径，不能给输入框`);
  }
  assert.match(activity, /全局参数/);
});

// E-10 / D-19 控制台半：熔断与手动停止翻的是同一个开关，但处理办法相反，
// 所以概览页要按 /api/summary 带来的 enabledReason 分开说，不能一句「已停止」了事。
test('the overview tells an automatic meltdown apart from a manual stop', async t => {
  const { store, server } = fixture(t);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const { context } = loadConsoleScripts(base);
  await new Promise(resolve => setTimeout(resolve, 150));

  store.set('enabled', '0'); store.set('enabled_reason', 'send_failures');
  const melted = await context.__pages.overview();
  assert.match(melted, /连续发送失败，已自动熔断/, '熔断要说明是自动的');
  assert.doesNotMatch(melted, /你手动停止了模型回复/, '熔断不能被说成用户自己停的');

  store.set('enabled_reason', 'admin_stop');
  const stopped = await context.__pages.overview();
  assert.match(stopped, /你手动停止了模型回复/);
  assert.doesNotMatch(stopped, /自动熔断/, '手动停止不能被说成故障');

  store.set('enabled_reason', '');
  assert.match(await context.__pages.overview(), /原因没有记录/, '没有原因就照实说，不能编一个');

  store.set('enabled', '1');
  assert.doesNotMatch(await context.__pages.overview(), /已停止/, '开着的时候不该出现停止文案');
});
