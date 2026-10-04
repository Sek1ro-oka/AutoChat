import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Personas, validPersonaName, MAX_PERSONA_BYTES, BEHAVIOR_FILE } from '../src/personas.js';
import { DEFAULT_PERSONA } from '../src/persona.js';
import { Bot } from '../src/bot.js';

function sandbox(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autochat-personas-'));
  const store = new Store();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const personas = new Personas({ directory: root, store, log: () => {}, ...options });
  return { root, store, personas, cards: join(root, 'characters'), behaviorPath: join(root, BEHAVIOR_FILE) };
}

test('card names are restricted to safe file names', () => {
  for (const good of ['默认角色', 'Cool-Cat 2', '杂鱼·ver1', '_x', 'a_b-1.2']) {
    assert.equal(validPersonaName(good), true, good);
  }
  // Path separators, traversal, hidden files, reserved device names, trailing
  // dot/space and over-long names are all rejected before touching the disk.
  for (const bad of ['', '..', '.', '../evil', 'a/b', 'a\\b', '/etc/passwd', '.hidden', 'con', 'NUL',
    'com1', 'x.', 'x ', ' x', 'a'.repeat(41), null, undefined, 42]) {
    assert.equal(validPersonaName(bad), false, String(bad));
  }
});

test('a card name can never escape the characters directory', t => {
  const { personas } = sandbox(t);
  for (const bad of ['..', '../evil', 'a/b', 'a\\b', '.hidden', 'con', 'x.', '', 'a'.repeat(41)]) {
    assert.throws(() => personas.save(bad, '内容'), /PERSONA_NAME_INVALID/, bad);
    assert.throws(() => personas.card(bad), /PERSONA_NAME_INVALID/, bad);
    assert.equal(personas.read(bad), null, bad);
  }
});

test('resolution order is SYSTEM_PROMPT > active card > built-in default', t => {
  const plain = sandbox(t);
  assert.equal(plain.personas.resolve(), DEFAULT_PERSONA);
  assert.equal(plain.personas.source(), 'builtin');

  plain.personas.save('甲', '卡片人设');
  plain.personas.setActive('甲');
  assert.equal(plain.personas.resolve(), '卡片人设');
  assert.equal(plain.personas.source(), 'card');

  const forced = sandbox(t, { envPrompt: '  环境人设  ' });
  forced.personas.save('乙', '卡片');
  forced.personas.setActive('乙');
  assert.equal(forced.personas.resolve(), '环境人设');
  assert.equal(forced.personas.source(), 'env');
});

test('a missing or emptied card falls back instead of resurrecting the mirror', t => {
  const { personas, cards } = sandbox(t);
  const file = join(cards, '甲.md');
  personas.save('甲', '镜像内容');
  assert.equal(personas.read('甲'), '镜像内容');

  // Oversized file: unreadable in practice, so the saved mirror is served.
  writeFileSync(file, 'x'.repeat(MAX_PERSONA_BYTES + 16));
  assert.equal(personas.read('甲'), '镜像内容');

  // Emptied file and deleted file both mean "no card" — never the mirror.
  truncateSync(file, 0);
  assert.equal(personas.read('甲'), null);
  rmSync(file);
  assert.equal(personas.read('甲'), null);
});

test('a card edit reaches the very next resolve without a new loader', t => {
  const { personas, cards } = sandbox(t);
  personas.save('甲', '第一版');
  personas.setActive('甲');
  assert.equal(personas.resolve(), '第一版');
  // Same byte count on purpose: only the mtime can invalidate the cache.
  const file = join(cards, '甲.md');
  writeFileSync(file, '第二版\n');
  const ahead = new Date(Date.now() + 60000);
  utimesSync(file, ahead, ahead);
  assert.equal(personas.resolve(), '第二版');
});

const statSafe = path => { try { return statSync(path).isFile(); } catch { return false; } };

test('the behaviour layer is a startup snapshot: edits need a restart', t => {
  const { root, store, behaviorPath } = sandbox(t);
  writeFileSync(behaviorPath, '群聊行为协议\n');
  const first = new Personas({ directory: root, store, log: () => {} });
  assert.equal(first.behaviorFile().exists, true);
  assert.equal(first.resolve(), `群聊行为协议\n\n${DEFAULT_PERSONA}`);
  assert.equal(first.behaviorPending(), false);

  first.saveBehavior('新协议');
  assert.equal(first.resolve(), `群聊行为协议\n\n${DEFAULT_PERSONA}`, 'still the loaded snapshot');
  assert.equal(first.behaviorFile().content, '新协议', 'the editor shows what is on disk');
  assert.equal(first.behaviorPending(), true);

  const restarted = new Personas({ directory: root, store, log: () => {} });
  assert.equal(restarted.resolve(), `新协议\n\n${DEFAULT_PERSONA}`);
  assert.equal(restarted.behaviorPending(), false);

  restarted.saveBehavior('   ');
  assert.equal(statSafe(behaviorPath), false, 'an empty body deletes the file');
  assert.equal(restarted.behaviorPending(), true);
});

test('saving rejects empty, oversized and non-string content, and leaves no temp files', t => {
  const { personas, cards } = sandbox(t);
  assert.throws(() => personas.save('甲', '   '), /PERSONA_CONTENT_EMPTY/);
  assert.throws(() => personas.save('甲', 'x'.repeat(MAX_PERSONA_BYTES + 1)), /PERSONA_CONTENT_TOO_LARGE/);
  assert.throws(() => personas.save('甲', 123), /PERSONA_CONTENT_INVALID/);
  personas.save('甲', '正常内容');
  assert.deepEqual(readdirSync(cards), ['甲.md']);
  assert.equal(personas.card('甲').exists, true);
  assert.equal(personas.card('乙').exists, false);
});

test('the card count is capped', t => {
  const { personas } = sandbox(t);
  for (let index = 0; index < 50; index += 1) personas.save(`卡${index}`, '内容');
  assert.throws(() => personas.save('卡50', '内容'), /PERSONA_LIMIT/);
  personas.save('卡0', '改写已有卡不受上限影响');
  assert.equal(personas.list().length, 50);
});

test('deleting the active card clears the selection instead of dangling', t => {
  const { personas } = sandbox(t);
  personas.save('甲', '内容');
  personas.setActive('甲');
  assert.equal(personas.active(), '甲');
  personas.remove('甲');
  assert.equal(personas.active(), '');
  assert.equal(personas.resolve(), DEFAULT_PERSONA);
  assert.throws(() => personas.remove('甲'), /PERSONA_NOT_FOUND/);
  assert.throws(() => personas.setActive('不存在'), /PERSONA_NOT_FOUND/);
});

test('describe lists cards without embedding their content', t => {
  const { personas } = sandbox(t);
  personas.save('甲', '秘密人设');
  const info = personas.describe();
  assert.equal(info.source, 'builtin');
  assert.equal(info.override, false);
  assert.deepEqual(info.characters.map(c => c.name), ['甲']);
  assert.equal(info.characters[0].active, false);
  assert.equal(info.behavior.loaded, false);
  assert.equal(info.behavior.onDisk, false);
  assert.equal(info.behavior.pending, false);
  assert.equal(info.behavior.path.endsWith('behavior.md'), true);
  assert.equal(info.limits.maxCharacters, 50);
  assert.equal(info.limits.maxBytes, MAX_PERSONA_BYTES);
  assert.equal(info.resolved.preview.startsWith(DEFAULT_PERSONA.slice(0, 40)), true);
  assert.ok(!JSON.stringify(info).includes('秘密人设'), 'list output must not carry card content');
});

test('the bot resolves the active card into its system prompt each turn', t => {
  const { store, personas } = sandbox(t);
  const config = { botId: '10000001', privateUser: '10000002', adminId: '10000002', groupId: '10000003',
    budgetMicro: 1000000, inputPrice: 2, outputPrice: 8, maxOutput: 128, contextTokens: 16000,
    clearMs: 72 * 3600000, systemPrompt: '内置', blockTerms: [], model: 'deepseek-flash' };
  const silent = { complete: async () => ({ text: 'x', usage: null }) };
  const bot = new Bot(config, store, silent, { personas });
  assert.equal(bot.systemPrompt(), DEFAULT_PERSONA);
  personas.save('甲', '卡片人设');
  personas.setActive('甲');
  assert.equal(bot.systemPrompt(), '卡片人设');
  personas.setActive('');
  assert.equal(bot.systemPrompt(), DEFAULT_PERSONA);
  // Without a loader the pre-Phase-2 path is untouched.
  assert.equal(new Bot(config, store, silent, {}).systemPrompt(), '内置');
});
