// 「一键重置配置」（设置页底部危险区）：库里的重置、写路由、以及按钮本身。
//
// 每个数据库都是 os.tmpdir() 下的一次性文件，仓库自己的 data/ 一次都不打开。
// 前端是经典脚本（不是 module），只能按 index.html 的顺序在同一个 vm 上下文里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

import { Store } from '../src/store.js';
import { resetAll } from '../src/console/reset.js';
import { auth, fixture } from './support/console-harness.js';

const tmpStore = t => {
  const root = mkdtempSync(join(tmpdir(), 'autochat-reset-'));
  const store = new Store(join(root, 'autochat.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
};

// 11 条该被清掉的设置，键名都照抄真实代码里写出来的形状：
// 运行参数（cfg:）、开关与模型档位、黑话抽取进度（slang_*）、按群覆盖（group_social_）、
// 今日计数（social_count:）与空间说说的游标（qzone:）。
const CLEARED_SETTINGS = {
  'cfg:budget_cny': '5',
  enabled: '0',
  enabled_reason: 'admin_stop',
  groupEnabled: '0',
  active_model: 'pro',
  slang_enabled: '1',
  slang_last_extract_at: '1700000000000',
  slang_last_extract: '{"at":1}',
  'group_social_enabled:123': '1',
  'social_count:2024-01-01:123': '3',
  'qzone:cursor': '1',
};

// 2 条不许动的：当前选中的人格与按群指定的人格。
const KEPT_SETTINGS = { active_persona: '小助手', 'group_persona:456': '毒舌' };

const seed = store => {
  for (const [key, value] of Object.entries({ ...CLEARED_SETTINGS, ...KEPT_SETTINGS })) store.set(key, value);
  store.db.prepare('INSERT INTO slang (id, content, created, updated) VALUES (?,?,?,?)')
    .run('s1', 'yyds', 1700000000000, 1700000000000);
  store.db.prepare('INSERT INTO slang_groups (slang_id, group_id) VALUES (?,?)').run('s1', '20000');
  store.db.prepare('INSERT INTO stickers (id, file, created, updated) VALUES (?,?,?,?)')
    .run('k1', 'k1.png', 1700000000000, 1700000000000);
  store.db.prepare('INSERT INTO personas (name, content, updated) VALUES (?,?,?)').run('小助手', '人格正文', 1);
  store.db.prepare('INSERT INTO sessions (key, scope, history, updated, items) VALUES (?,?,?,?,?)')
    .run('private:1', 'private', '[]', 1, 0);
  store.db.prepare('INSERT INTO charges (id, day, reserved, actual, state, created) VALUES (?,?,?,?,?,?)')
    .run('c1', '2024-01-01', 100, 100, 'settled', 1);
};

const rows = (store, table) => Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

const EXPECTED = { settings: Object.keys(CLEARED_SETTINGS).length, slang: 1, slangGroups: 1, stickers: 1 };

test('resetAll 清配置与学习数据，留下人格键与历史表', t => {
  const store = tmpStore(t);
  seed(store);
  const before = { sessions: rows(store, 'sessions'), charges: rows(store, 'charges'), personas: rows(store, 'personas') };

  const result = resetAll({ store });

  for (const key of Object.keys(CLEARED_SETTINGS)) assert.equal(store.setting(key), null, `${key} 必须被清掉`);
  for (const [key, value] of Object.entries(KEPT_SETTINGS)) {
    assert.equal(store.setting(key), value, `${key} 是人格键，重置不许动它`);
  }
  for (const table of ['slang', 'slang_groups', 'stickers']) assert.equal(rows(store, table), 0, `${table} 要清空`);
  for (const [table, count] of Object.entries(before)) {
    assert.equal(count, 1, `夹具里 ${table} 应该有 1 行`);
    assert.equal(rows(store, table), count, `${table} 是历史不是配置，行数不许变`);
  }
  assert.deepEqual(result, EXPECTED);
  for (const value of Object.values(result)) assert.ok(Number.isInteger(value), '计数必须是整数');
});

test('空库上再跑一次返回全 0，不抛错', t => {
  const store = tmpStore(t);
  assert.deepEqual(resetAll({ store }), { settings: 0, slang: 0, slangGroups: 0, stickers: 0 });
  assert.deepEqual(resetAll({ store }), { settings: 0, slang: 0, slangGroups: 0, stickers: 0 });
});

test('POST /api/config/reset 只认请求头令牌，并把四个计数回给页面', async t => {
  const { store, server } = fixture(t);
  seed(store);
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/config/reset`, { method: 'POST' })).status, 401);
  const response = await fetch(`${base}/api/config/reset`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), EXPECTED);
  assert.equal(store.setting('active_persona'), '小助手');
  assert.equal(rows(store, 'slang'), 0);

  // 新脚本必须同时在 ASSETS 与 index.html 里登记，否则页面上只会 404（docs/console.md 的那条坑）。
  const asset = await fetch(`${base}/pages-settings-reset.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /data-act="configReset"/);
});

// 最小 DOM/全局桩：只实现设置页与 core.js 真正碰到的接口，其余走各自的兜底分支。
// 弹窗逻辑用 modals 记一笔 —— 不测浏览器怎么画 <dialog>，只测「先确认、再发请求」。
const renderSettings = async () => {
  const nodes = new Map();
  const calls = [];
  const modals = [];
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.value = '';
      this.textContent = '';
      this.className = '';
      this.dataset = {};
      this.style = {};
      this._html = '';
      this.classList = { add: () => {}, remove: () => {}, contains: () => false };
    }
    set innerHTML(value) { this._html = String(value); }
    get innerHTML() { return this._html; }
    setAttribute() {}
    getAttribute() { return null; }
    before() {}
    remove() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    showModal() { modals.push(this); }
    close() { this.closed = true; }
  }
  const pick = key => { if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key); };
  const answers = {
    '/api/settings': { fields: [], groups: [] },
    '/api/instances': { counts: { total: 1 }, instances: [] },
    '/api/login/status': { state: 'idle' },
  };
  const context = vm.createContext({
    document: {
      hidden: false, getElementById: pick, querySelector: pick,
      querySelectorAll: () => [], createElement: tag => new Node(tag),
    },
    location: { search: '', pathname: '/' },
    history: { replaceState: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    window: { matchMedia: () => ({ matches: false }) },
    fetch: async (path, init = {}) => {
      calls.push({ path: String(path), method: String(init.method || 'GET').toUpperCase() });
      return { ok: true, status: 200, json: async () => answers[String(path)] ?? {} };
    },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    console, URLSearchParams, URL, Blob,
  });
  for (const name of ['core.js', 'pages-settings-reset.js', 'pages-settings.js']) {
    const file = new URL(`../src/console/public/${name}`, import.meta.url);
    new vm.Script(readFileSync(file, 'utf8'), { filename: name }).runInContext(context);
  }
  vm.runInContext('globalThis.__pages = pages; globalThis.__actions = ACTIONS;', context);
  return { html: await context.__pages.settings(), actions: context.__actions, calls, modals, context };
};

test('设置页底部画出危险区按钮，点了先弹确认框再 POST', async () => {
  const { html, actions, calls, modals } = await renderSettings();

  assert.match(html, /一键重置配置/);
  assert.match(html, /配置、运行状态与学习数据恢复初始状态；人格卡与 API Key 不受影响/);
  assert.match(html, /class="btn btn-danger" data-act="configReset"/);
  assert.match(html, /会保留/);
  assert.match(html, /会被清空/);
  assert.match(html, /人格卡与当前选中的人格/);
  assert.match(html, /表情包图片文件留在磁盘上，只清库里的行/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(html, /style="/);

  const open = actions.get('configReset');
  assert.equal(typeof open, 'function', '按钮必须走 ACTIONS 表');
  open({ dataset: {} });
  assert.equal(modals.length, 1, '点了按钮先弹确认框');
  assert.ok(!calls.some(call => call.path === '/api/config/reset'), '确认之前不许发请求');

  const go = actions.get('configResetGo');
  const button = { textContent: '确认重置', disabled: false };
  await go(button);
  assert.ok(calls.some(call => call.path === '/api/config/reset' && call.method === 'POST'), '确认后 POST 到写接口');
  assert.equal(button.disabled, false, '无论成败按钮都要恢复可点');
  assert.equal(button.textContent, '确认重置');
});
