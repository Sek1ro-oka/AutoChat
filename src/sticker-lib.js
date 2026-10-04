// The sticker library's runtime half (V2 · Phase 6): what a collected picture
// means, when to keep one, and how to send one.
//
// Division of labour mirrors the slang library:
//   * src/stickers.js        — pure functions (identity, sanitising, markers, the
//                              injected block), no SQLite and no network;
//   * src/store-stickers.js  — the `stickers` table, mixed into `Store`;
//   * src/sticker-download.js — download + persist, reusing the vision whitelist;
//   * this file              — the object the bot and the console talk to.
//
// The model has no tool loop (single-turn chat completions), so "decide whether
// to use a sticker" rides the reply that is already being made: `【表情:编号】`
// asks to send one, `【偷图:备注】` asks to keep the picture in the current
// message. Rule-based auto-collect is the other, free path.

import { dirname, join } from 'node:path';
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_BYTES } from './vision.js';
import {
  MAX_STICKERS, STICKER_BLOCK_MAX, STICKER_PER_TURN,
  buildStickerBlock, STICKER_HINT, normalizeSticker, parseStickerMarkers,
  selectStickers, stickerId, stickerLabel, shouldAutoCollect,
} from './stickers.js';
import { downloadSticker } from './sticker-download.js';

export class StickerLib {
  constructor({
    config, store, log = () => {}, now = Date.now,
    download = downloadSticker,
  } = {}) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.now = now;
    this.download = download;
    // Pictures live beside the database, not in the runtime cache, so a restart
    // never orphans them.
    this.dir = join(dirname(config.databasePath), 'stickers');
  }

  // --- parameters (runtime-overridable from the console) --------------------
  params() {
    const c = this.config;
    const num = (key, fallback) => {
      const raw = this.store.setting(key, null);
      const value = Number(raw);
      return raw !== null && Number.isFinite(value) ? value : fallback;
    };
    return {
      enabled: this.store.setting('sticker_enabled', c.stickerEnabled ? '1' : '0') === '1',
      autoCollect: this.store.setting('sticker_auto_collect', c.stickerAutoCollect ? '1' : '0') === '1',
      autoThreshold: Math.max(1, Math.min(20, num('sticker_auto_threshold', c.stickerAutoThreshold))),
    };
  }

  setParams(patch = {}) {
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw new Error('STICKER_PARAM_INVALID');
      this.store.set('sticker_enabled', patch.enabled ? '1' : '0');
    }
    if ('autoCollect' in patch) {
      if (typeof patch.autoCollect !== 'boolean') throw new Error('STICKER_PARAM_INVALID');
      this.store.set('sticker_auto_collect', patch.autoCollect ? '1' : '0');
    }
    if ('autoThreshold' in patch) {
      const value = Number(patch.autoThreshold);
      if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error('STICKER_PARAM_INVALID');
      this.store.set('sticker_auto_threshold', String(value));
    }
    this.log('sticker_params_changed');
    return this.describe();
  }

  enabled() { return this.params().enabled; }

  // Absolute path of a sticker's on-disk copy; the table stores the bare name.
  pathOf(entry) { return join(this.dir, entry?.file || ''); }

  // --- collection -----------------------------------------------------------
  // Observe one image segment from a group message: identify it, download and
  // persist it, land it as a candidate, and — when rule auto-collect is on and
  // the threshold is met — confirm it. `force` is the model's `【偷图】` marker,
  // which confirms regardless of threshold and writes the note it chose.
  // Best-effort by contract: a failed download or an unidentifiable picture is
  // skipped, never thrown, because collecting must not abort a reply.
  async observe(segment, { call = null, note = '', force = false } = {}) {
    if (!segment) return null;
    const id = stickerId({ md5: segment.data?.md5, url: segment.data?.url });
    if (!id) return null;
    let file = '';
    try {
      file = await this.download(segment, id, this.dir, { call }) ?? '';
    } catch { this.log('sticker_download_failed'); }
    this.store.upsertSticker({
      id, md5: segment.data?.md5 ?? '', url: segment.data?.url ?? '', file,
      source: 'qq', now: this.now(),
    });
    const entry = this.store.getSticker(id);
    const params = this.params();
    if (force || (params.autoCollect && shouldAutoCollect(entry, { threshold: params.autoThreshold }))) {
      this.store.setStickerStatus(id, 'confirmed', this.now());
      if (note) this.store.updateSticker(id, { note }, this.now());
      this.log('sticker_collected');
      return this.store.getSticker(id);
    }
    return entry;
  }

  // --- injection ------------------------------------------------------------
  // What the model is allowed to pick from, framed as reference data. Empty when
  // the feature is off or nothing is confirmed, so a stock install pays nothing.
  block() {
    if (!this.enabled()) return '';
    return buildStickerBlock(this.store.listStickers({ status: 'confirmed', limit: 5000 }), {
      max: STICKER_BLOCK_MAX,
    });
  }

  hint() { return STICKER_HINT; }

  // --- sending --------------------------------------------------------------
  // Honour the model's `【表情:编号】` asks: must be confirmed and have a file on
  // disk. Each sent picture counts as a use. Returns how many were actually sent.
  async sendByIds(ids, { action, target }, send) {
    const entries = this.store.listStickers({ status: 'confirmed', limit: 5000 });
    const picked = selectStickers(entries, ids, { limit: STICKER_PER_TURN });
    let sent = 0;
    for (const sticker of picked) {
      const file = this.pathOf(sticker);
      if (!file || !existsSync(file)) continue;
      try {
        await send(action, { ...target, message: [{ type: 'image', data: { file } }] });
        this.store.recordStickerUse(sticker.id, this.now());
        sent += 1;
      } catch { this.log('sticker_send_failed'); }
    }
    return sent;
  }

  // --- console view ---------------------------------------------------------
  // The list exposes notes/descriptions and counts, never the verbatim picture
  // bytes; the file path is served only for the thumbnail/action, as a name.
  describe() {
    const params = this.params();
    const counts = this.store.countStickers();
    const confirmed = this.store.listStickers({ status: 'confirmed', limit: 5000 });
    const sendable = confirmed.filter(entry => entry.file && existsSync(this.pathOf(entry))).length;
    return {
      enabled: params.enabled,
      params,
      defaults: {
        enabled: Boolean(this.config.stickerEnabled),
        autoCollect: Boolean(this.config.stickerAutoCollect),
        autoThreshold: this.config.stickerAutoThreshold,
      },
      limits: { entries: MAX_STICKERS, blockMax: STICKER_BLOCK_MAX, perTurn: STICKER_PER_TURN },
      stats: { ...counts, sendable },
      preview: this.block(),
      entries: this.store.listStickers({ limit: 1000 }).map(entry => ({
        id: entry.id, md5: entry.md5, file: entry.file, desc: entry.desc, note: entry.note,
        tags: entry.tags, source: entry.source, status: entry.status,
        seen: entry.seen, useCount: entry.use_count, lastUsed: entry.last_used,
        created: entry.created, updated: entry.updated, label: stickerLabel(entry),
      })),
    };
  }

  entry(id) {
    const row = this.store.getSticker(String(id));
    if (!row) throw new Error('STICKER_NOT_FOUND');
    return { entry: { ...row, label: stickerLabel(row) } };
  }

  setStatus(id, status) {
    if (!['candidate', 'confirmed', 'rejected'].includes(status)) throw new Error('STICKER_PARAM_INVALID');
    this.store.setStickerStatus(String(id), status, this.now());
    this.log('sticker_status_changed');
    return this.describe();
  }

  edit(id, fields = {}) {
    const clean = {};
    if (typeof fields.desc === 'string') clean.desc = String(fields.desc).slice(0, 200);
    if (typeof fields.note === 'string') clean.note = String(fields.note).slice(0, 120);
    if (Array.isArray(fields.tags)) clean.tags = fields.tags;
    const row = this.store.updateSticker(String(id), clean, this.now());
    if (!row) throw new Error('STICKER_NOT_FOUND');
    return { entry: { ...row, label: stickerLabel(row) } };
  }

  remove(id) {
    const row = this.store.getSticker(String(id));
    if (!row) throw new Error('STICKER_NOT_FOUND');
    const changes = this.store.deleteSticker(String(id));
    if (row.file) {
      const file = this.pathOf(row);
      try { if (existsSync(file)) unlinkSync(file); } catch { this.log('sticker_unlink_failed'); }
    }
    return { deleted: changes, ...this.describe() };
  }

  // Parse a model reply for `【表情】`/`【偷图】` markers, returning the cleaned
  // text plus what it asked for. Wrapped here so the answering and simulation
  // paths both strip markers in exactly the same place.
  parseMarkers(text) { return parseStickerMarkers(text, { sendLimit: STICKER_PER_TURN, collectLimit: 1 }); }

  // Identity of one image segment, so a caller can confirm "the picture in this
  // message" without re-observing (and double-counting) it.
  idOf(segment) { return stickerId({ md5: segment?.data?.md5, url: segment?.data?.url }); }

  // The model asked to keep a picture it already saw (`【偷图】` marker). Confirm
  // it and write the note it chose, without bumping `seen` — the ingest already
  // counted this sighting.
  confirm(id, note = '') {
    const entry = this.store.getSticker(String(id));
    if (!entry) return null;
    this.store.setStickerStatus(String(id), 'confirmed', this.now());
    if (note) this.store.updateSticker(String(id), { note }, this.now());
    this.log('sticker_collected');
    return this.store.getSticker(String(id));
  }

  // Manual upload from the console: the operator wants the bot to be able to
  // send a picture of their own. Base64 data URL in, a confirmed sticker out.
  upload({ dataUrl = '', note = '' }) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
    if (!match) throw new Error('STICKER_UPLOAD_INVALID');
    const ext = match[1] === 'image/jpeg' ? 'jpg' : match[1].slice(6);
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('STICKER_UPLOAD_INVALID');
    const id = createHash('sha1').update(match[2]).digest('hex').slice(0, 24);
    const file = `${id}.${ext}`;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, file), bytes);
    this.store.upsertSticker({ id, file, note, source: 'manual', status: 'confirmed', now: this.now() });
    this.log('sticker_uploaded');
    return this.entry(id);
  }

  // Bytes of one sticker for the console's thumbnail route. Returns null when
  // the picture is missing, so the page just skips the preview.
  image(id) {
    const entry = this.store.getSticker(String(id));
    if (!entry?.file) return null;
    const file = this.pathOf(entry);
    try {
      if (!existsSync(file)) return null;
      const bytes = readFileSync(file);
      const ext = file.split('.').pop()?.toLowerCase();
      const type = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] ?? 'application/octet-stream';
      return { bytes, type };
    } catch { return null; }
  }
}

// Re-export the pure helpers the callers and tests share, so `sticker-lib.js`
// is a single entry point for the whole feature.
export {
  MAX_STICKERS, STICKER_BLOCK_MAX, STICKER_PER_TURN, buildStickerBlock, STICKER_HINT,
  normalizeSticker, selectStickers, stickerId, stickerLabel, shouldAutoCollect,
};
