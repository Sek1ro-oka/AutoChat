// Download and persist a QQ picture for the sticker library (V2 · Phase 6).
//
// Reuses the same host whitelist, redirect and size/format guards as the vision
// path (see src/vision.js) — a sticker is just a picture we decide to keep, so
// it must pass the same gate before it is written to disk. The difference is the
// output: vision returns base64 for a single read; a sticker is kept as a file.
//
// A QQ-native `face` (the little yellow round ones) has no downloadable bytes —
// `fetchStickerBytes` returns null for it, and the caller simply skips it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageUrl, MAX_IMAGE_BYTES } from './vision.js';

// Magic-byte detection, kept in one place so the file extension on disk always
// matches what vision.js would accept. Returns the extension (no dot) or null.
export function imageExt(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

// Fetch the raw bytes of one image segment. `call` resolves a `file` reference
// to a URL the way vision.js does; without it only a segment that already has a
// URL is downloadable. Returns null when the segment has no usable source or the
// download is refused, so a failure here can never abort the surrounding turn.
export async function fetchStickerBytes(segment, { call = null, fetchImage = fetch } = {}) {
  let raw = segment?.data?.url;
  if (!raw && typeof segment?.data?.file === 'string' && /^[\w.-]{1,256}$/.test(segment.data.file) && call) {
    try { raw = (await call('get_image', { file: segment.data.file }))?.url; } catch { raw = ''; }
  }
  let url;
  try { url = imageUrl(raw); } catch { return null; }
  const signal = AbortSignal.timeout(15000);
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetchImage(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects === 3) return null;
    url = imageUrl(new URL(response.headers.get('location'), url).href);
  }
  if (!response.ok) { await response.body?.cancel(); return null; }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel(); return null;
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Download and persist one image segment under `dir` as `<id>.<ext>`. Returns the
// bare file name (no directory) on success, null if it is not downloadable or
// not a picture the vision gate would accept.
export async function downloadSticker(segment, id, dir, { call = null, fetchImage = fetch } = {}) {
  const bytes = await fetchStickerBytes(segment, { call, fetchImage });
  if (!bytes) return null;
  const ext = imageExt(bytes);
  if (!ext) return null;
  const file = `${id}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), bytes);
  return file;
}
