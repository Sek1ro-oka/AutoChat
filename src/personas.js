// Two-layer prompt management (V2 · Phase 2).
//
// Layer 1 — behaviour protocol (`personas/behavior.md`): what the bot is allowed
// to do as a group member. Read once at startup on purpose: a protocol change is
// the kind most likely to surprise, so it needs a restart to take effect.
// Layer 2 — character cards (`personas/characters/<name>.md`): voice, catchphrases,
// preferences. Re-read on every turn through a cheap mtime check, so a console
// edit reaches the very next message without a restart.
//
// Resolution order, highest first: `SYSTEM_PROMPT` (.env) > active card >
// built-in default. An explicit `SYSTEM_PROMPT` wins outright — that is what
// keeps every pre-V2 `.env` behaving exactly as before.
//
// Cards live on disk and files are the source of truth. The `personas` table in
// SQLite mirrors the last content the console saved and is consulted only when a
// card file exists but cannot be read (I/O error or over the size cap). A missing
// or emptied file is treated as "no card", never as a mirror hit, so deleting a
// card in the console actually deletes it.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PERSONA } from './persona.js';

export const MAX_PERSONA_BYTES = 64 * 1024;
export const MAX_PERSONAS = 50;
export const BEHAVIOR_FILE = 'behavior.md';

// Names become file names, so the character set is deliberately narrow: no path
// separators, no leading dot or space (blocks `.`, `..` and hidden files), no
// trailing dot or space (Windows silently strips those).
const NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N} _.\-·]{0,38}$/u;
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function validPersonaName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (!NAME_RE.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  if (RESERVED_RE.test(name)) return false;
  return true;
}

const normalize = text => String(text ?? '').replace(/\r\n/g, '\n').trim();

// Write through a sibling temp file so a crash mid-write can never leave a
// half-written card behind: readers see either the old file or the new one.
function atomicWrite(path, text) {
  const temp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temp, `${text}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export class Personas {
  constructor({
    directory = 'personas', store = null, log = () => {},
    envPrompt = null, fallback = DEFAULT_PERSONA, defaultName = null,
  } = {}) {
    this.root = resolve(directory);
    this.cardsDir = join(this.root, 'characters');
    this.behaviorPath = join(this.root, BEHAVIOR_FILE);
    this.store = store;
    this.log = log;
    this.override = typeof envPrompt === 'string' && envPrompt.trim() ? envPrompt.trim() : null;
    this.fallback = normalize(fallback) || DEFAULT_PERSONA;
    this.defaultName = typeof defaultName === 'string' && defaultName.trim() ? defaultName.trim() : '';
    this.cache = new Map();       // name -> { mtimeMs, size, content }
    this.mirrorNoted = new Map(); // name -> mtimeMs already logged
    // Behaviour layer snapshot: frozen for the lifetime of the process.
    this.behavior = this.loadBehavior();
  }

  loadBehavior() {
    const empty = { present: false, bytes: 0, updated: null, content: null };
    let stat;
    try { stat = statSync(this.behaviorPath); } catch { return empty; }
    if (!stat.isFile() || stat.size === 0) return empty;
    if (stat.size > MAX_PERSONA_BYTES) { this.log('persona_behavior_too_large'); return empty; }
    let content;
    try { content = normalize(readFileSync(this.behaviorPath, 'utf8')); }
    catch { this.log('persona_behavior_unreadable'); return empty; }
    if (!content) return empty;
    return { present: true, bytes: Buffer.byteLength(content), updated: stat.mtimeMs, content };
  }

  // Console-friendly path. A directory outside the project (custom PERSONA_DIR,
  // or a different Windows drive) has no useful relative form, so fall back to
  // the last two segments instead of printing an absolute path.
  displayPath(path) {
    const rel = relative(process.cwd(), path).split(sep).join('/');
    return rel.startsWith('..') || /^[a-zA-Z]:/.test(rel) ? path.split(sep).slice(-2).join('/') : rel;
  }

  assertName(name) {
    if (!validPersonaName(name)) throw new Error('PERSONA_NAME_INVALID');
    return name;
  }

  // Resolve a card name to its path and prove the result stays inside the card
  // directory — the second check covers separator and encoding tricks the
  // character-set regex alone should already reject.
  pathFor(name) {
    this.assertName(name);
    const full = resolve(this.cardsDir, `${name}.md`);
    if (full !== join(this.cardsDir, `${name}.md`) || !full.startsWith(this.cardsDir + sep)) {
      throw new Error('PERSONA_NAME_INVALID');
    }
    return full;
  }

  // --- active selection ------------------------------------------------------
  // A stored empty string means "explicitly use the built-in default" and wins
  // over the environment default, so the console can always switch back.
  active() {
    const stored = this.store?.setting?.('active_persona', null);
    if (typeof stored === 'string') return stored;
    return this.defaultName;
  }

  setActive(name) {
    const value = name ? this.assertName(name) : '';
    if (value && !this.exists(value)) throw new Error('PERSONA_NOT_FOUND');
    if (!this.store?.set) throw new Error('PERSONA_UNAVAILABLE');
    this.store.set('active_persona', value);
    this.log('persona_activated');
    return value;
  }

  exists(name) {
    if (!validPersonaName(name)) return false;
    try { return statSync(this.pathFor(name)).isFile(); } catch { return false; }
  }

  // Last-known-good mirror, used only when the file itself is unreadable.
  mirror(name, stamp) {
    const row = this.store?.getPersona?.(name);
    if (!row?.content) return null;
    if (this.mirrorNoted.get(name) !== stamp) {
      this.mirrorNoted.set(name, stamp);
      this.log('persona_mirror_used');
    }
    return row.content;
  }

  // --- read ------------------------------------------------------------------
  read(name) {
    if (!validPersonaName(name)) return null;
    const file = this.pathFor(name);
    let stat;
    try { stat = statSync(file); }
    catch { this.cache.delete(name); return null; }   // absent file = no card
    if (!stat.isFile() || stat.size === 0) { this.cache.delete(name); return null; }
    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.content;
    if (stat.size > MAX_PERSONA_BYTES) { this.log('persona_card_too_large'); return this.mirror(name, stat.mtimeMs); }
    let content;
    try { content = normalize(readFileSync(file, 'utf8')); }
    catch { this.log('persona_card_unreadable'); return this.mirror(name, stat.mtimeMs); }
    if (!content) { this.cache.delete(name); return null; }
    this.cache.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  }

  list() {
    let entries;
    try { entries = readdirSync(this.cardsDir, { withFileTypes: true }); }
    catch { return []; }
    const cards = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue;
      const name = entry.name.slice(0, -3);
      if (!validPersonaName(name)) continue;
      try {
        const stat = statSync(join(this.cardsDir, entry.name));
        cards.push({ name, bytes: stat.size, updated: stat.mtimeMs });
      } catch { /* raced with a delete */ }
    }
    return cards.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  // Full card payload for the console editor.
  card(name) {
    const value = this.assertName(name);
    let stat = null;
    try { stat = statSync(this.pathFor(value)); } catch { /* new card */ }
    return {
      kind: 'card', name: value, content: this.read(value) ?? '',
      bytes: stat?.size ?? 0, updated: stat?.mtimeMs ?? null, exists: Boolean(stat?.isFile()),
    };
  }

  // --- write -----------------------------------------------------------------
  save(rawName, content) {
    const name = this.assertName(rawName);
    if (typeof content !== 'string') throw new Error('PERSONA_CONTENT_INVALID');
    const text = normalize(content);
    if (!text) throw new Error('PERSONA_CONTENT_EMPTY');
    if (Buffer.byteLength(text) > MAX_PERSONA_BYTES) throw new Error('PERSONA_CONTENT_TOO_LARGE');
    if (!this.exists(name) && this.list().length >= MAX_PERSONAS) throw new Error('PERSONA_LIMIT');
    mkdirSync(this.cardsDir, { recursive: true });
    atomicWrite(this.pathFor(name), text);
    this.cache.delete(name);
    this.store?.savePersona?.(name, text, Date.now());
    this.log('persona_saved');
    return { name, bytes: Buffer.byteLength(text) };
  }

  remove(name) {
    const value = this.assertName(name);
    if (!this.exists(value)) throw new Error('PERSONA_NOT_FOUND');
    rmSync(this.pathFor(value), { force: true });
    this.cache.delete(value);
    this.store?.deletePersona?.(value);
    // Never leave a card selected that no longer exists.
    if (this.active() === value) this.store?.set?.('active_persona', '');
    this.log('persona_deleted');
    return value;
  }

  // Behaviour edits intentionally do NOT touch `this.behavior`: the running
  // process keeps its loaded protocol until the next restart.
  saveBehavior(content) {
    const text = normalize(content);
    if (Buffer.byteLength(text) > MAX_PERSONA_BYTES) throw new Error('PERSONA_CONTENT_TOO_LARGE');
    mkdirSync(this.root, { recursive: true });
    if (!text) { rmSync(this.behaviorPath, { force: true }); this.log('persona_behavior_cleared'); return { bytes: 0 }; }
    atomicWrite(this.behaviorPath, text);
    this.log('persona_behavior_saved');
    return { bytes: Buffer.byteLength(text) };
  }

  // Reads the file on disk (not the startup snapshot) so the console editor
  // always shows what a restart would load.
  behaviorFile() {
    let stat = null;
    try { stat = statSync(this.behaviorPath); } catch { /* absent */ }
    let content = '';
    if (stat?.isFile() && stat.size > 0) {
      if (stat.size > MAX_PERSONA_BYTES) this.log('persona_behavior_too_large');
      else { try { content = normalize(readFileSync(this.behaviorPath, 'utf8')); } catch { /* unreadable */ } }
    }
    return {
      kind: 'behavior', name: BEHAVIOR_FILE, content,
      bytes: Buffer.byteLength(content), updated: stat?.isFile() ? stat.mtimeMs : null,
      exists: Boolean(content), restart: true,
    };
  }

  // True when what is on disk differs from the protocol this process loaded.
  behaviorPending() {
    return this.behaviorFile().content !== (this.behavior.content ?? '');
  }

  // --- composition (hot path, once per handled turn) -------------------------
  resolve() {
    if (this.override) return this.override;
    const name = this.active();
    const card = name ? this.read(name) : null;
    const parts = [];
    if (this.behavior.content) parts.push(this.behavior.content);
    parts.push(card ?? this.fallback);
    return parts.join('\n\n');
  }

  source() {
    if (this.override) return 'env';
    const name = this.active();
    return name && this.read(name) ? 'card' : 'builtin';
  }

  describe() {
    const active = this.active();
    const resolved = this.resolve();
    const behavior = this.behaviorFile();
    return {
      override: Boolean(this.override),
      source: this.source(),
      active,
      activeExists: Boolean(active && this.exists(active)),
      behavior: {
        loaded: this.behavior.present, onDisk: behavior.exists,
        path: this.displayPath(this.behaviorPath), bytes: behavior.bytes, updated: behavior.updated,
        pending: behavior.content !== (this.behavior.content ?? ''),
      },
      characters: this.list().map(item => ({ ...item, active: item.name === active })),
      limits: { maxBytes: MAX_PERSONA_BYTES, maxCharacters: MAX_PERSONAS },
      resolved: { bytes: Buffer.byteLength(resolved), preview: resolved.slice(0, 800) },
    };
  }
}
