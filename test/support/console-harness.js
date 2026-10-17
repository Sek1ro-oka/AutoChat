// Shared fixtures for the console tests (I-08 split). Both collection globs —
// `npm test` (`test/*.test.js`) and `test/*.js` — deliberately skip this
// subdirectory, so this file is only ever loaded through an explicit import.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { Store } from '../../src/store.js';
import { Personas } from '../../src/personas.js';
import { Social } from '../../src/social/engine.js';
import { Slang } from '../../src/social/slang.js';
import { StickerLib } from '../../src/sticker-lib.js';
import { createConsole } from '../../src/console/server.js';

// Re-exported so a split file never needs its own path to the engine module:
// the reference count across src/ + test/ is what it was before the split.
export { Social };

export const TOKEN = 'test-console-token-1234';

export function fixture(t, overrides = {}) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, apiKey: 'sk-supersecret-key',
    onebotToken: 'onebot-supersecret', consoleToken: TOKEN, consolePort: 0,
    webSearchEnabled: true, visionEnabled: false, antiSpamEnabled: true, groupManagementEnabled: false,
    ...overrides,
  };
  const bot = { queued: 0, sendFailures: 0 };
  const transport = { ready: true, retry: 0 };
  const runtime = { stats: () => [{ name: 'core', failures: 0, lastError: null }] };
  const server = createConsole({ config, store, bot, transport, runtime, log: () => {}, port: 0 });
  return { store, config, server };
}

// A console wired to a real persona directory, for the Phase 2 write paths.
export function personaFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-personas-'));
  const store = new Store();
  const personas = new Personas({ directory: root, store, log: () => {} });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0 };
  const server = createConsole({ config, store, personas, log: () => {}, port: 0 });
  return { store, personas, server };
}

// A console wired to a real Social engine, for the Phase 3 read/write paths.
export function socialFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    socialEnabled: false, socialThreshold: 6, socialCooldownSeconds: 45, socialDailyLimit: 20,
    socialContextMessages: 12, socialMaxChunks: 3, socialMinDelayMs: 0, socialMaxDelayMs: 0,
    socialMessageTtlMs: 24 * 3600000, botName: '', botNicknames: [],
    blockTerms: [], maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = { complete: async () => ({ text: '好', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  const social = new Social({ config, store, model, log: () => {}, now: () => 1800000000000 });
  const server = createConsole({ config, store, social, log: () => {}, port: 0 });
  return { store, social, server };
}

// A console wired to a real Slang library, for the Phase 4 read/write paths.
export function slangFixture(t) {
  const store = new Store();
  t.after(() => store.close());
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    botId: '10000', groupId: '20000', groupIds: ['20000'],
    slangEnabled: true, slangInjectMax: 20, slangExtractMessages: 120,
    slangAutoExtract: false, slangExtractIntervalHours: 12, webSearchEnabled: false,
    maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const model = {
    complete: async () => ({
      text: '[{"term":"yyds","meaning":"永远的神","example":"这才是 yyds"}]',
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
  };
  store.noteMessage({ groupId: '20000', messageId: 'm1', userId: '30001', at: Date.now() - 1000, text: '这才是 yyds' });
  const slang = new Slang({ config, store, model, log: () => {} });
  const server = createConsole({ config, store, slang, log: () => {}, port: 0 });
  return { store, slang, server };
}

// 1×1 transparent PNG: the console only ever builds a URL from the file name, but
// `describe()` counts "a file that still exists" for the sendable card, so the
// rows need real bytes behind them.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// A console wired to a real sticker library, for the read path the assets page
// renders (`/api/stickers`). Three pictures, one per column shape that matters:
//
//   cand01  candidate, desc + tags  → the ordinary row
//   conf02  confirmed, no tags, no desc (a note instead) → the DASH branch, and
//           the row that proves an empty `tags` array is rendered, not iterated
//           unguarded
//   man03   uploaded by hand        → the `manual` source label
//
// The images live in the same throw-away directory as the database — never the
// repo's `data/` — so the whole fixture disappears in `t.after`.
export function stickerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-console-stickers-'));
  const store = new Store();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const config = {
    model: 'deepseek-flash', budgetMicro: 1000000, consoleToken: TOKEN, consolePort: 0,
    databasePath: join(root, 'autochat.db'),
    stickerEnabled: true, stickerAutoCollect: true, stickerAutoThreshold: 2,
    maxOutput: 1024, inputPrice: 2, outputPrice: 8, systemPrompt: '人设',
  };
  const stickers = new StickerLib({ config, store, log: () => {} });
  mkdirSync(stickers.dir, { recursive: true });
  const seeds = [
    { id: 'cand01', file: 'cand01.png', desc: '鼓掌的猫', tags: ['猫', '鼓掌'], source: 'qq', status: 'candidate' },
    { id: 'conf02', file: 'conf02.png', note: '群里最爱的狗头', source: 'auto', status: 'confirmed' },
    { id: 'man03', file: 'man03.png', desc: '手动传的图', tags: ['手动'], source: 'manual', status: 'confirmed' },
  ];
  for (const seed of seeds) {
    writeFileSync(join(stickers.dir, seed.file), Buffer.from(PNG_1PX, 'base64'));
    store.upsertSticker({ ...seed, now: 1800000000000 });
  }
  const server = createConsole({ config, store, stickers, log: () => {}, port: 0 });
  return { store, stickers, server };
}

export const auth = { 'x-console-token': TOKEN };
export const jsonPost = (base, path, body, extra = {}) => fetch(base + path, {
  method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

// 控制台前端是经典脚本，没有模块边界，只能按 index.html 的顺序在同一 vm 上下文里跑。
// 这里搭一个最小假 DOM：只实现这些脚本真正碰到的接口，其余返回空值走各自的兜底分支。
export const fakeConsole = created => {
  class El {
    constructor(tag = 'div') {
      this.tagName = tag; this.value = ''; this.textContent = ''; this.className = '';
      this.dataset = {}; this.style = {}; this.attrs = {}; this.writes = 0;
      this._html = ''; this._classes = new Set(); this.validity = { badInput: false };
      this.classList = { add: n => this._classes.add(n), remove: n => this._classes.delete(n), contains: n => this._classes.has(n) };
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
  return { document, main: pick(ids, 'main'), input: selector => pick(selectors, selector), byId: id => pick(ids, id) };
};

// 与 index.html 里的 <script src> 顺序一致：core 先定义工具，页面脚本往 pages 上挂，app.js 最后启动路由与事件委派。
export const CONSOLE_SCRIPTS = ['core.js', 'pages-overview.js', 'pages-model.js', 'pages-personas.js', 'pages-groups.js',
  'pages-activity.js', 'pages-assets.js', 'assets-stickers.js', 'assets-slang.js', 'pages-cost.js',
  'pages-logs.js', 'pages-settings.js', 'app.js'];

// 只把真请求转给测试服务器，其余（主题、图标之类）就地成功即可。
export const loadConsoleScripts = base => {
  const created = [], calls = [];
  const { document, main, input, byId } = fakeConsole(created);
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
    const file = new URL(`../../src/console/public/${name}`, import.meta.url);
    new vm.Script(readFileSync(file, 'utf8'), { filename: name }).runInContext(context);
  }
  // 顶层 const 在 vm 里可见但不会挂到 context 对象上，取出来才能直接调页面函数。
  vm.runInContext('globalThis.__pages = pages;', context);
  // 改版后页面不再往 window 上挂全局函数：唯一入口是 ACTIONS 表（事件委派用）。
  vm.runInContext('globalThis.__actions = ACTIONS;', context);
  return { calls, created, context, input, main, byId };
};
