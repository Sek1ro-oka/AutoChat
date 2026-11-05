// GIF 读取（纯 JS 解码 + 抽帧拼图）的离线回归。
//
// 背景：本机没有 ffmpeg（/api/status 的 media.ffmpeg.ok=false），旧实现里动图一律
// 退化成「只提供首帧」——模型看见了一张图，却不知道自己漏掉了整段动画。
// src/gif-read.js 用 LZW + 帧合成自己解 GIF，这条测试保证：
//   · LZW 编解码与真实编码器的位序/字典增长一致（用独立写的编码器反向验证）
//   · 帧矩形、disposal（保留 / 清背景 / 还原上一帧）、透明索引、隔行扫描都合成正确
//   · 抽样点按时间轴取，而不是按下标等分
//   · 出的是单帧 PNG（模型能吃），且不超过体积上限
//
// 不访问网络、不依赖 ffmpeg：夹具全部由本文件的 buildGif() 现做。
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  GIF_LIMITS,
  decodeLzw,
  encodePng,
  parseGifStructure,
  pickSampleFrames,
  renderGifSheet,
  renderGifStill
} from '../src/gif-read.js';
import { MEDIA_DEFAULTS, normalizeImageForModel, sniffImage } from '../src/media-normalize.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// ── 夹具：一个最小但完整的 GIF 编码器（与解码器互相独立） ────────────────────

/** GIF 的 LZW 编码（变长码，LSB 先出）。字典增长规则必须与解码器逐位对齐。 */
function encodeLzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;
  const emit = (code) => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next);
      next += 1;
      // 码长增长点必须比解码器晚「一个码」：解码器只有读到下一个码，才知道这一串的首字符，
      // 所以它的字典永远落后编码器一条；两边同刻增长就会从这一码开始整体错位。
      if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize += 1;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) bytes.push(bitBuf & 0xff);
  return bytes;
}

const interlaceOrder = (height) => {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
};

/**
 * 拼一份 GIF89a。
 *
 * @param {object} spec
 *   width/height  逻辑画布
 *   palette       [[r,g,b], …]（会补到 2 的幂）
 *   background    背景色在调色板里的下标
 *   frames        [{ indices, left, top, width, height, delayMs, disposal, transparentIndex, interlaced }]
 */
function buildGif({ width, height, palette, background = 0, frames, loop = 0 }) {
  let size = 2;
  while (size < palette.length) size *= 2;
  const bits = Math.log2(size);
  const out = [];
  const u8 = (n) => out.push(n & 0xff);
  const u16 = (n) => { out.push(n & 0xff, (n >> 8) & 0xff); };
  const ascii = (s) => { for (const ch of s) out.push(ch.charCodeAt(0)); };

  ascii('GIF89a');
  u16(width); u16(height);
  u8(0x80 | ((bits - 1) << 4) | (bits - 1)); // 有 GCT + 颜色深度 + GCT 大小
  u8(background);
  u8(0);
  for (let i = 0; i < size; i += 1) {
    const c = palette[i] || [0, 0, 0];
    u8(c[0]); u8(c[1]); u8(c[2]);
  }
  if (loop != null) {
    u8(0x21); u8(0xff); u8(11);
    ascii('NETSCAPE2.0');
    u8(3); u8(1); u16(loop); u8(0);
  }
  for (const frame of frames) {
    const fw = frame.width ?? width;
    const fh = frame.height ?? height;
    const left = frame.left ?? 0;
    const top = frame.top ?? 0;
    const delayCs = Math.round((frame.delayMs ?? 100) / 10);
    const transparent = frame.transparentIndex ?? null;
    u8(0x21); u8(0xf9); u8(4);
    u8(((frame.disposal ?? 1) << 2) | (transparent == null ? 0 : 1));
    u16(delayCs);
    u8(transparent ?? 0);
    u8(0);
    u8(0x2c);
    u16(left); u16(top); u16(fw); u16(fh);
    u8(frame.interlaced ? 0x40 : 0);
    const natural = frame.indices;
    let stored = natural;
    if (frame.interlaced) {
      stored = [];
      for (const y of interlaceOrder(fh)) {
        for (let x = 0; x < fw; x += 1) stored.push(natural[y * fw + x]);
      }
    }
    const minCodeSize = Math.max(2, bits);
    u8(minCodeSize);
    const data = encodeLzw(stored, minCodeSize);
    for (let p = 0; p < data.length; p += 255) {
      const chunk = data.slice(p, p + 255);
      u8(chunk.length);
      for (const b of chunk) u8(b);
    }
    u8(0);
  }
  u8(0x3b);
  return Buffer.from(out);
}

/** 只认本模块产出的 PNG（8bit RGB / filter 0 / 连续 IDAT），够测试用。 */
function readPng(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[9], 2, 'RGB'); }
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  for (let y = 0; y < height; y += 1) assert.equal(raw[y * (stride + 1)], 0, '只写 filter 0');
  return {
    width,
    height,
    px: (x, y) => {
      const o = y * (stride + 1) + 1 + x * 3;
      return [raw[o], raw[o + 1], raw[o + 2]];
    }
  };
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const GREEN = [0, 128, 0];
const fill = (n, v) => new Array(n).fill(v);

// ── 1. 结构解析 ────────────────────────────────────────────────────────────
await test('parseGifStructure：画布/帧数/延迟/处置方式都读对', async () => {
  const gif = buildGif({
    width: 4,
    height: 3,
    palette: [WHITE, RED, BLUE],
    frames: [
      { indices: fill(12, 1), delayMs: 100, disposal: 1 },
      { indices: fill(4, 2), left: 1, top: 1, width: 2, height: 2, delayMs: 200, disposal: 2, transparentIndex: 0 },
      { indices: fill(12, 2), delayMs: 100, disposal: 1 }
    ]
  });
  const parsed = parseGifStructure(gif);
  assert.ok(parsed, '应当解析成功');
  assert.equal(parsed.width, 4);
  assert.equal(parsed.height, 3);
  assert.equal(parsed.frames.length, 3);
  assert.deepEqual(parsed.frames.map((f) => f.delayMs), [100, 200, 100]);
  assert.deepEqual(parsed.frames.map((f) => f.disposal), [1, 2, 1]);
  assert.equal(parsed.frames[1].transparentIndex, 0);
  assert.equal(parsed.frames[0].transparentIndex, -1);
  assert.deepEqual(parsed.background, WHITE, '背景色取 GCT 里的 background 下标');
});

await test('parseGifStructure：非 GIF / 截断字节返回 null（不抛异常）', async () => {
  assert.equal(parseGifStructure(Buffer.from('hello world, not a gif')), null);
  const good = buildGif({ width: 2, height: 2, palette: [RED], frames: [{ indices: fill(4, 0) }] });
  assert.equal(parseGifStructure(good.subarray(0, 20)), null, '截断在块中间应当放弃');
});

// ── 2. LZW ────────────────────────────────────────────────────────────────
await test('decodeLzw：与独立编码器逐字节一致（含字典增长与重复串）', async () => {
  const w = 37;
  const h = 23;
  const indices = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      // 造一点有重复、有长游程的图案，逼字典真的增长到 9/10 位
      indices[y * w + x] = ((x >> 2) + (y >> 1)) % 4;
    }
  }
  const data = Buffer.from(encodeLzw(Array.from(indices), 2));
  const decoded = decodeLzw(2, data, indices.length);
  assert.deepEqual(Array.from(decoded), Array.from(indices));
});

await test('decodeLzw：空数据 / 立即结束码 ⇒ 全 0，不死循环', async () => {
  const clearAndEoi = Buffer.from(encodeLzw([0], 2));
  const out = decodeLzw(2, clearAndEoi, 16);
  assert.equal(out.length, 16);
  assert.deepEqual(Array.from(out), fill(16, 0));
  assert.deepEqual(Array.from(decodeLzw(2, Buffer.alloc(0), 8)), fill(8, 0));
});

// ── 3. 帧合成：透明 / disposal / 隔行 ──────────────────────────────────────
await test('帧合成：透明索引不覆盖底图，disposal=2 把矩形清回背景色', async () => {
  // 4×4，4 帧：红底 → 全透明（不动） → 2×2 蓝块(disposal 2) → 1×1 透明
  const gif = buildGif({
    width: 4,
    height: 4,
    palette: [WHITE, RED, BLUE],
    frames: [
      { indices: fill(16, 1), delayMs: 100, disposal: 1 },
      { indices: fill(16, 0), delayMs: 100, disposal: 1, transparentIndex: 0 },
      { indices: fill(4, 2), left: 1, top: 1, width: 2, height: 2, delayMs: 100, disposal: 2 },
      { indices: fill(1, 0), left: 0, top: 0, width: 1, height: 1, delayMs: 100, disposal: 1, transparentIndex: 0 }
    ]
  });
  const sheet = renderGifSheet(gif, { sample: 4, cols: 2, rows: 2, tileWidth: 64, padding: 4 });
  assert.equal(sheet.ok, true, sheet.reason);
  assert.equal(sheet.sampled, 4);
  const png = readPng(sheet.buffer);
  // 每格 64×64、间隔 4、外边距 4：第 k 格左上角 = 4 + (k%2)*68, 4 + floor(k/2)*68
  const cell = (k, sx = 32, sy = 32) => {
    const ox = 4 + (k % 2) * 68;
    const oy = 4 + Math.floor(k / 2) * 68;
    return png.px(ox + sx, oy + sy);
  };
  assert.deepEqual(cell(0), RED, '第 1 帧：整张红');
  assert.deepEqual(cell(1), RED, '第 2 帧全透明 ⇒ 底图仍是红');
  assert.deepEqual(cell(2, 16, 16), BLUE, '第 3 帧：蓝块画在 (1,1)');
  assert.deepEqual(cell(3, 16, 16), WHITE, 'disposal=2 之后该矩形回到背景色（白）');
  assert.deepEqual(cell(3, 48, 48), RED, '矩形之外仍是红');
});

await test('帧合成：隔行扫描的 9 行按 0,8/4/2/1 顺序还原', async () => {
  const palette = [WHITE, RED, BLUE, GREEN, [255, 255, 0], [0, 255, 255], [255, 0, 255], [10, 20, 30], [200, 100, 50]];
  const indices = [];
  for (let y = 0; y < 9; y += 1) for (let x = 0; x < 3; x += 1) indices.push(y % 9);
  const gif = buildGif({
    width: 3,
    height: 9,
    palette,
    frames: [{ indices, delayMs: 100, disposal: 1, interlaced: true }]
  });
  const sheet = renderGifSheet(gif, { sample: 1, cols: 1, rows: 1, tileWidth: 64, padding: 0 });
  assert.equal(sheet.ok, true, sheet.reason);
  const png = readPng(sheet.buffer);
  for (let y = 0; y < 9; y += 1) {
    const dy = Math.floor((y + 0.5) * png.height / 9);
    assert.deepEqual(png.px(32, dy), palette[y % 9], `第 ${y} 行颜色`);
  }
});

// ── 4. 抽样点 ─────────────────────────────────────────────────────────────
await test('pickSampleFrames：按时间轴取样（长定格占权重，不按下标等分）', async () => {
  const frames = [1000, 10, 10, 10, 1000].map((d) => ({ delayMs: d }));
  assert.deepEqual(pickSampleFrames(frames, 2), [0, 4]);
  assert.deepEqual(pickSampleFrames(frames, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(pickSampleFrames([{ delayMs: 100 }], 6), [0], '不足帧数时全用，不重复填格');
});

// ── 5. 拼图输出 ───────────────────────────────────────────────────────────
await test('renderGifSheet：9 帧 ⇒ 3×2 网格 + 单帧 PNG + 说明文字', async () => {
  const frames = [];
  for (let i = 0; i < 9; i += 1) frames.push({ indices: fill(64, i % 3 ? 1 : 2), delayMs: 100, disposal: 1 });
  const gif = buildGif({ width: 8, height: 8, palette: [WHITE, RED, BLUE], frames });
  const sheet = renderGifSheet(gif, { sample: 6, cols: 3, rows: 2, tileWidth: 64 });
  assert.equal(sheet.ok, true, sheet.reason);
  assert.equal(sheet.cols, 3);
  assert.equal(sheet.rows, 2);
  assert.equal(sheet.sampled, 6);
  assert.equal(sheet.mimeType, 'image/png');
  assert.match(sheet.note, /动图 9 帧/);
  assert.match(sheet.note, /纯 JS 解码抽 6 帧/);
  assert.match(sheet.note, /3×2 网格/);
  const info = sniffImage(sheet.buffer);
  assert.equal(info.format, 'png');
  assert.equal(info.frames, 1);
  assert.equal(info.width, 3 * 64 + 4 * 2 + 4 * 2);
  assert.ok(sheet.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
});

await test('renderGifSheet：超出解码预算时明确拒绝（不硬解）', async () => {
  const gif = buildGif({ width: 5000, height: 5000, palette: [RED], frames: [{ indices: fill(4, 0) }] });
  const sheet = renderGifSheet(gif, { sample: 6 });
  assert.equal(sheet.ok, false);
  assert.match(sheet.reason, /预算/);
});

await test('renderGifSheet：坏字节 ⇒ ok:false 且给出原因', async () => {
  const junk = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 0x07)]);
  const sheet = renderGifSheet(junk, { sample: 6 });
  assert.equal(sheet.ok, false);
  assert.ok(sheet.reason.length > 0);
});

await test('encodePng：空图/1×1 也能产出合法 PNG（IHDR/IEND 齐全）', async () => {
  const png = encodePng(1, 1, Buffer.from([1, 2, 3]), 3);
  const read = readPng(png);
  assert.equal(read.width, 1);
  assert.deepEqual(read.px(0, 0), [1, 2, 3]);
});

// ── 6. 静态 GIF 兜底 ──────────────────────────────────────────────────────
await test('renderGifStill：大 GIF 解第 1 帧并按长边上限缩', async () => {
  const palette = [];
  for (let i = 0; i < 16; i += 1) palette.push([i * 16, 255 - i * 16, 128]);
  const indices = new Uint8Array(300 * 200);
  for (let y = 0; y < 200; y += 1) for (let x = 0; x < 300; x += 1) indices[y * 300 + x] = (x >> 3) % 16;
  const gif = buildGif({ width: 300, height: 200, palette, frames: [{ indices: Array.from(indices), delayMs: 100, disposal: 1 }] });
  const still = renderGifStill(gif, { maxLongEdge: 120, maxBytes: 200 * 1024 });
  assert.equal(still.ok, true, still.reason);
  assert.equal(still.mimeType, 'image/png');
  assert.equal(Math.max(still.width, still.height), 120);
  assert.match(still.note, /纯 JS 解码/);
});

// ── 7. 接进媒体归一化主链路 ───────────────────────────────────────────────
await test('normalizeImageForModel：动图走自带解码器 ⇒ 单帧 PNG + 网格说明', async () => {
  const frames = [];
  for (let i = 0; i < 8; i += 1) frames.push({ indices: fill(64, i % 2 ? 1 : 2), delayMs: 120, disposal: 1 });
  const gif = buildGif({ width: 8, height: 8, palette: [WHITE, RED, BLUE], frames });
  const out = await normalizeImageForModel(gif, 'image/gif', MEDIA_DEFAULTS);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'image/png');
  assert.equal(sniffImage(out.buffer)?.frames, 1);
  assert.match(out.note, /纯 JS 解码/);
  assert.ok(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
});

await test('normalizeImageForModel：静态大 GIF 在无 ffmpeg 时也能缩（不再整张拒绝）', async () => {
  const palette = [];
  for (let i = 0; i < 8; i += 1) palette.push([i * 30, 200 - i * 20, 80]);
  const indices = new Uint8Array(400 * 300);
  for (let y = 0; y < 300; y += 1) for (let x = 0; x < 400; x += 1) indices[y * 400 + x] = (x + y) % 8;
  const gif = buildGif({ width: 400, height: 300, palette, frames: [{ indices: Array.from(indices), delayMs: 100, disposal: 1 }] });
  const out = await normalizeImageForModel(gif, 'image/gif', {
    ...MEDIA_DEFAULTS,
    maxModelBytes: 120 * 1024,
    // planNormalization 会把 maxLongEdge 夹在 [256, 2048]，这里给 256 就是最小可能值。
    maxLongEdge: 256
  });
  assert.equal(out.ok, true, out.error);
  const info = sniffImage(out.buffer);
  assert.ok(Math.max(info.width, info.height) <= 256, `长边应 ≤256，实际 ${info.width}×${info.height}`);
  assert.ok(Math.max(info.width, info.height) < 400, '应该真的缩小了，而不是原样返回');
  assert.ok(out.buffer.length <= 120 * 1024);
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}: gif-read — failures=${failures}`);
process.exitCode = failures ? 1 : 0;
