// GIF 读取：纯 JS 解码 + 抽帧拼图，让模型「看得见动图里发生了什么」。
//
// ── 为什么要有这一层（2026-11-05 复盘结论）
//
// 桥接过去把动图整条链路都押在 ffmpeg 上：media-normalize 的 animate 分支用
// `fps=…,scale=…,tile=3x2` 拼图，本机没装 ffmpeg 时直接退化成「只提供首帧」。
// 实测这台机器 `spawnSync ffmpeg ENOENT`，于是每一张 QQ 动图（表情包、梗图、录屏 GIF）
// 模型都只看得到第 1 帧——比「看不懂」更糟的是它不知道自己漏看了什么。
//
// 而 GIF 恰恰是唯一一种「解码器可以小到几百行」的动图格式：LZW + 调色板 + 帧矩形，
// 没有熵编码表、没有运动补偿。Node 自带 zlib，连 PNG 编码都不用外部依赖。
// 所以这里自己实现，不引 sharp / canvas / gifuct-js 之类的依赖（本仓库零框架、零构建）。
//
// 算法出处：LZW 解码与帧合成思路参照 omggif（MIT, Copyright 2011 Dean McNamee）
// 与 gifuct-js（MIT, Copyright 2016 Matt Way），二者均为 MIT 许可；本文件为独立实现，
// 只借用「清空码/结束码/延迟码、frame 矩形按 disposal 合成」这些格式本身的规定。
//
// ── 边界
//
// · 只解 GIF。动图 WebP/APNG 仍走 ffmpeg（它们要 VP8/VP8L/APNG 解码器，不是几百行的事）。
// · 画布/帧数有硬预算（见 LIMITS）：超了就返回 ok:false，由调用方回退到 ffmpeg 或首帧，
//   绝不为了「一定要出图」把事件循环卡住几十秒。
// · 输出一律 RGB PNG（透明像素合成到白底），不再引入 JPEG 编码器。

import zlib from 'node:zlib';

/** 解码预算：超过就放弃（交给调用方的回退路径），不让一张怪图拖住消息循环。 */
export const GIF_LIMITS = Object.freeze({
  // 逻辑画布像素上限（4000×4000）：超过说明这不是聊天里会出现的表情包。
  maxCanvasPixels: 16 * 1024 * 1024,
  // 最多解多少帧：120 帧 × 500×500 的 LZW 解码约 1–2 s，再多就交给 ffmpeg。
  maxFrames: 400,
  // 一帧的像素 × 帧数总预算：防止「1000 帧 2000×2000」这种把 CPU 吃满的输入。
  maxPixelWork: 160 * 1024 * 1024,
  // 拼图长边上限（px）：再宽模型侧也是先缩到 1280，没必要。
  maxSheetEdge: 1600
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

// ── 块解析 ──────────────────────────────────────────────────────────────

/** 跳过 GIF 子块链（每块首字节是长度，0 结束）。返回 { chunks, end }，end=-1 表示越界。 */
function readSubBlocks(buf, pos) {
  const chunks = [];
  let p = pos;
  while (p < buf.length) {
    const size = buf[p];
    p += 1;
    if (size === 0) return { chunks, end: p };
    if (p + size > buf.length) return { chunks, end: -1 };
    chunks.push(buf.subarray(p, p + size));
    p += size;
  }
  return { chunks, end: -1 };
}

/**
 * 把 GIF 拆成「逻辑画布 + 逐帧矩形」。
 *
 * 只做结构解析，不解 LZW——帧数据以子块数组留着，真正解码时再拼，
 * 这样「只要前 6 帧」的场景不用为后面几百帧付内存。
 *
 * @returns null（不是合法 GIF）或
 *   { version, width, height, background, globalTable, frames:[…], loop }
 */
export function parseGifStructure(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 13) return null;
  const header = buf.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) return null;
  const packed = buf[10];
  let pos = 13;
  let globalTable = null;
  if (packed & 0x80) {
    const entries = 2 << (packed & 0x07);
    if (pos + entries * 3 > buf.length) return null;
    globalTable = buf.subarray(pos, pos + entries * 3);
    pos += entries * 3;
  }
  const frames = [];
  let loop = null;
  let pendingDelay = 0;
  let pendingDisposal = 0;
  let pendingTransparent = -1;
  let guard = 0;
  while (pos >= 0 && pos < buf.length) {
    if (++guard > 2_000_000) return null;
    const marker = buf[pos];
    pos += 1;
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      if (pos >= buf.length) return null;
      const label = buf[pos];
      pos += 1;
      if (label === 0xf9) {
        // 图形控制扩展：块长(1)=4 打包位(1) delay(2) 透明索引(1)
        if (pos + 5 > buf.length || buf[pos] !== 4) return null;
        const gcePacked = buf[pos + 1];
        pendingDelay = buf.readUInt16LE(pos + 2);
        pendingDisposal = (gcePacked >> 2) & 0x07;
        pendingTransparent = gcePacked & 0x01 ? buf[pos + 4] : -1;
        pos += 5;
        // GCE 后紧跟终结符 0
        if (buf[pos] === 0) pos += 1;
        continue;
      }
      if (label === 0xff && pos + 11 <= buf.length) {
        // 应用扩展里找 NETSCAPE2.0 的循环次数（只用于说明，不参与解码）
        const appId = buf.toString('ascii', pos + 1, pos + 11);
        const { chunks, end } = readSubBlocks(buf, pos);
        if (appId.startsWith('NETSCAPE') && chunks.length && chunks[0].length >= 3 && chunks[0][0] === 1) {
          loop = chunks[0].readUInt16LE(1);
        }
        pos = end;
        continue;
      }
      pos = readSubBlocks(buf, pos).end;
      continue;
    }
    if (marker === 0x2c) {
      if (pos + 9 > buf.length) return null;
      const left = buf.readUInt16LE(pos);
      const top = buf.readUInt16LE(pos + 2);
      const fw = buf.readUInt16LE(pos + 4);
      const fh = buf.readUInt16LE(pos + 6);
      const descPacked = buf[pos + 8];
      pos += 9;
      let localTable = null;
      if (descPacked & 0x80) {
        const entries = 2 << (descPacked & 0x07);
        if (pos + entries * 3 > buf.length) return null;
        localTable = buf.subarray(pos, pos + entries * 3);
        pos += entries * 3;
      }
      if (pos >= buf.length) return null;
      const minCodeSize = buf[pos];
      pos += 1;
      const { chunks, end } = readSubBlocks(buf, pos);
      if (end < 0) return null;
      frames.push({
        left,
        top,
        width: fw,
        height: fh,
        interlaced: (descPacked & 0x40) !== 0,
        table: localTable || globalTable,
        minCodeSize,
        data: chunks,
        delayMs: pendingDelay * 10,
        disposal: pendingDisposal,
        transparentIndex: pendingTransparent
      });
      pendingDelay = 0;
      pendingDisposal = 0;
      pendingTransparent = -1;
      pos = end;
      continue;
    }
    return null; // 认不出的块：整份放弃，别猜
  }
  if (!frames.length) return null;
  const background = globalTable && globalTable.length >= 3 && buf[11] < globalTable.length / 3
    ? [globalTable[buf[11] * 3], globalTable[buf[11] * 3 + 1], globalTable[buf[11] * 3 + 2]]
    : null;
  return { version: header, width, height, background, globalTable, frames, loop };
}

// ── LZW ────────────────────────────────────────────────────────────────

/**
 * GIF 的 LZW 解码（变长码，LSB 先出）。
 *
 * 字典用 prefix/suffix 两张表表达「码 → 串」：不解出整串再查，而是从末字符
 * 顺着 prefix 回溯，边回溯边压栈，最后反着吐出去——这是 GIF 解码的经典写法，
 * 好处是每个字节只碰一次。
 *
 * @param minCodeSize 每帧头部的「最小码长」（2–11）
 * @param data        该帧的 LZW 数据（子块已拼接）
 * @param pixelCount  该帧矩形的像素数（用来兜住坏流导致的无限输出）
 * @returns Uint8Array 调色板索引；坏流/截断时返回已解出的前缀（不足部分为 0）
 */
export function decodeLzw(minCodeSize, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let datum = 0;
  let bits = 0;
  let pos = 0;
  let old = -1;
  let outPos = 0;
  const readCode = () => {
    while (bits < codeSize) {
      if (pos >= data.length) return -1;
      datum |= data[pos] << bits;
      bits += 8;
      pos += 1;
    }
    const code = datum & ((1 << codeSize) - 1);
    datum >>>= codeSize;
    bits -= codeSize;
    return code;
  };
  while (outPos < pixelCount) {
    const code = readCode();
    if (code < 0 || code === eoi) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      old = -1;
      continue;
    }
    if (code > next || (code === next && old < 0)) break; // 坏流
    let sp = 0;
    let chase = code === next ? old : code; // KwKwK：先吐旧串，再补它的首字符
    while (chase >= clear) {
      if (sp >= 4096) break;
      stack[sp++] = suffix[chase];
      chase = prefix[chase];
    }
    stack[sp++] = chase; // 串首（字面量）
    const first = chase;
    for (let i = sp - 1; i >= 0 && outPos < pixelCount; i -= 1) out[outPos++] = stack[i];
    if (code === next && outPos < pixelCount) out[outPos++] = first;
    if (old >= 0 && next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next += 1;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    old = code;
  }
  return out;
}

/** GIF 隔行扫描的行顺序：0,8,16,… 4,12,… 2,6,… 1,3,5,… */
function interlacedRow(row, height) {
  if (row < 0) return row;
  let y = row;
  const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
  for (const [start, step] of passes) {
    const count = Math.max(0, Math.ceil((height - start) / step));
    if (y < count) return start + y * step;
    y -= count;
  }
  return height - 1;
}

// ── 帧合成 ──────────────────────────────────────────────────────────────

/**
 * 依次解码并合成帧，只把「采样点」的合成结果缩放后留下来。
 *
 * 为什么不能跳帧：GIF 的每一帧可能只覆盖画布的一小块，且带 disposal（保留/清背景/还原上一帧），
 * 少解一帧，后面的帧就可能贴错位置。
 *
 * @param parsed parseGifStructure 的结果
 * @param samples 要留存的帧下标（升序）
 * @param capture 每个留存帧的回调：(rgba 画布) => void
 */
function compositeFrames(parsed, samples, capture) {
  const { width, height } = parsed;
  const canvas = new Uint8Array(width * height * 4);
  const bg = parsed.background;
  if (bg) {
    for (let i = 0; i < canvas.length; i += 4) {
      canvas[i] = bg[0]; canvas[i + 1] = bg[1]; canvas[i + 2] = bg[2]; canvas[i + 3] = 255;
    }
  }
  const wanted = new Set(samples);
  let saved = null;
  let savedRect = null;
  for (let index = 0; index < parsed.frames.length; index += 1) {
    const frame = parsed.frames[index];
    const data = frame.data.length === 1
      ? frame.data[0]
      : Buffer.concat(frame.data);
    const indices = decodeLzw(frame.minCodeSize, data, frame.width * frame.height);
    if (frame.disposal === 3) {
      savedRect = { left: frame.left, top: frame.top, width: frame.width, height: frame.height };
      saved = new Uint8Array(savedRect.width * savedRect.height * 4);
      for (let y = 0; y < savedRect.height; y += 1) {
        const srcStart = ((savedRect.top + y) * width + savedRect.left) * 4;
        saved.set(canvas.subarray(srcStart, srcStart + savedRect.width * 4), y * savedRect.width * 4);
      }
    }
    // 贴图
    for (let row = 0; row < frame.height; row += 1) {
      const y = frame.interlaced ? interlacedRow(row, frame.height) : row;
      const cy = frame.top + y;
      if (cy < 0 || cy >= height) continue;
      const rowStart = row * frame.width;
      for (let x = 0; x < frame.width; x += 1) {
        const cx = frame.left + x;
        if (cx < 0 || cx >= width) continue;
        const pi = indices[rowStart + x];
        if (pi === frame.transparentIndex) continue;
        const table = frame.table;
        if (!table || pi * 3 + 2 >= table.length) continue;
        const o = (cy * width + cx) * 4;
        canvas[o] = table[pi * 3];
        canvas[o + 1] = table[pi * 3 + 1];
        canvas[o + 2] = table[pi * 3 + 2];
        canvas[o + 3] = 255;
      }
    }
    if (wanted.has(index)) capture(canvas, width, height, index);
    // 处理 disposal（影响下一帧的底图）
    if (frame.disposal === 2) {
      const bgFill = bg || [0, 0, 0];
      for (let y = 0; y < frame.height; y += 1) {
        const cy = frame.top + y;
        if (cy < 0 || cy >= height) continue;
        for (let x = 0; x < frame.width; x += 1) {
          const cx = frame.left + x;
          if (cx < 0 || cx >= width) continue;
          const o = (cy * width + cx) * 4;
          canvas[o] = bgFill[0];
          canvas[o + 1] = bgFill[1];
          canvas[o + 2] = bgFill[2];
          canvas[o + 3] = bg ? 255 : 0;
        }
      }
    } else if (frame.disposal === 3 && saved && savedRect) {
      for (let y = 0; y < savedRect.height; y += 1) {
        const dstStart = ((savedRect.top + y) * width + savedRect.left) * 4;
        canvas.set(saved.subarray(y * savedRect.width * 4, (y + 1) * savedRect.width * 4), dstStart);
      }
      saved = null;
      savedRect = null;
    }
  }
}

// ── 缩放 / PNG ──────────────────────────────────────────────────────────

/** 把 RGBA 画布按面积平均缩到 dstW×dstH，透明像素先合成到白底，输出 RGB。 */
function resizeOverWhite(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 3);
  for (let dy = 0; dy < dh; dy += 1) {
    const y0 = Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx += 1) {
      const x0 = Math.floor((dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        const row = y * sw;
        for (let x = x0; x < x1; x += 1) {
          const i = (row + x) * 4;
          const a = src[i + 3] / 255;
          const inv = 255 * (1 - a);
          r += src[i] * a + inv;
          g += src[i + 1] * a + inv;
          b += src[i + 2] * a + inv;
          n += 1;
        }
      }
      const o = (dy * dw + dx) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 手写 PNG 编码（RGB / RGBA，8 bit）。
 *
 * 为什么不用现成库：只为拼一张图引 sharp 不值得（本机连 ffmpeg 都没有，更不会有原生模块）。
 * PNG 的「压缩」只是 zlib + 逐行 filter，这里统一用 filter 0（None），照片类内容
 * deflate 9 级大约能到原字节的 30–50%，够用。
 */
export function encodePng(width, height, pixels, channels = 3) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.isBuffer(pixels) ? pixels : Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── 采样点 ──────────────────────────────────────────────────────────────

/**
 * 按时间轴挑采样帧：把总时长等分成 n 段，每段取中点落在的那一帧。
 *
 * 为什么不均匀取帧下标：GIF 里「停 2 秒的定格」和「10ms 的过场」权重完全不同，
 * 按下标等分会把 6 格里 4 格浪费在同一段静止画面上。
 */
export function pickSampleFrames(frames, wanted) {
  const total = frames.length;
  if (!total) return [];
  const n = Math.max(1, Math.min(wanted, total));
  if (total <= n) return frames.map((_, i) => i);
  const durations = frames.map((f) => (f.delayMs > 0 ? f.delayMs : 100));
  const sum = durations.reduce((a, b) => a + b, 0);
  const picked = [];
  for (let k = 0; k < n; k += 1) {
    const target = ((k + 0.5) * sum) / n;
    let acc = 0;
    let index = total - 1;
    for (let i = 0; i < total; i += 1) {
      acc += durations[i];
      if (target < acc) { index = i; break; }
    }
    if (!picked.includes(index)) picked.push(index);
  }
  // 去重后如果格子变少，用「隔着取」补齐，保证拼图格子数 = n（每格都真是一帧）。
  // 从前这里是「从头按顺序补」，补出来的是第 0、1、2 帧，全挤在动画开头；
  // 隔着取至少让补进来的帧铺满整段时间轴。
  let step = Math.max(1, Math.floor(total / n));
  while (picked.length < n && step > 0) {
    for (let i = 0; i < total && picked.length < n; i += step) {
      if (!picked.includes(i)) picked.push(i);
    }
    step -= 1;
  }
  return picked.sort((a, b) => a - b).slice(0, n);
}

// ── 主入口 ──────────────────────────────────────────────────────────────

function budgetCheck(parsed) {
  const pixels = parsed.width * parsed.height;
  if (pixels > GIF_LIMITS.maxCanvasPixels) {
    return `画布 ${parsed.width}×${parsed.height} 超出解码预算`;
  }
  if (parsed.frames.length > GIF_LIMITS.maxFrames) {
    return `帧数 ${parsed.frames.length} 超出解码预算`;
  }
  let work = 0;
  for (const frame of parsed.frames) work += frame.width * frame.height;
  if (work > GIF_LIMITS.maxPixelWork) return `总像素 ${work} 超出解码预算`;
  return null;
}

/**
 * 动图 → 一张「抽样网格」PNG。
 *
 * @param buf GIF 字节
 * @param opts { sample, cols, rows, tileWidth, maxBytes, padding }
 * @returns {ok:true, buffer, mimeType, width, height, tileWidth, tileHeight, cols, rows,
 *           sampled, totalFrames, durationMs, note} 或 {ok:false, reason}
 */
export function renderGifSheet(buf, opts = {}) {
  const parsed = parseGifStructure(buf);
  if (!parsed) return { ok: false, reason: 'GIF 结构解析失败' };
  const over = budgetCheck(parsed);
  if (over) return { ok: false, reason: over };

  const totalFrames = parsed.frames.length;
  const wanted = clampInt(opts.sample, 1, 12, Math.min(6, totalFrames));
  const samples = pickSampleFrames(parsed.frames, wanted);
  const cols = clampInt(opts.cols, 1, 6, Math.ceil(Math.sqrt(samples.length)));
  const rows = clampInt(opts.rows, 1, 6, Math.ceil(samples.length / cols));
  const nativeLong = Math.max(parsed.width, parsed.height);
  // 目标格子宽度：默认 240，但不把小图放大到 2 倍以上（1×1 的贴纸放大到 240 只是浪费字节）。
  let tileWidth = clampInt(opts.tileWidth, 64, 400, 240);
  tileWidth = Math.min(tileWidth, Math.max(96, nativeLong * 2));

  // 先把留存的帧按「2 倍格子」抓下来（之后缩到目标尺寸，避免反复解码）。
  const captureWidth = Math.min(parsed.width, tileWidth * 2);
  const captureHeight = Math.max(1, Math.round(captureWidth * (parsed.height / parsed.width)));
  const tiles = [];
  compositeFrames(parsed, samples, (canvas, w, h, index) => {
    tiles.push({ index, rgb: resizeOverWhite(canvas, w, h, captureWidth, captureHeight) });
  });
  if (!tiles.length) return { ok: false, reason: '没有可用的帧' };

  const padding = clampInt(opts.padding, 0, 16, 4);
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || 1024 * 1024);
  const sheetCols = Math.min(cols, tiles.length);
  const sheetRows = Math.ceil(tiles.length / sheetCols);
  let attempt = tileWidth;
  let encoded = null;
  for (let i = 0; i < 4; i += 1) {
    // 格子太宽会把拼图撑过 maxSheetEdge：先按列数算一个上限，宁可格子小一点也不要越界。
    const maxTileW = Math.max(64, Math.floor((GIF_LIMITS.maxSheetEdge - padding * (sheetCols + 1)) / sheetCols));
    const tw = Math.max(64, Math.min(maxTileW, Math.round(attempt)));
    const th = Math.max(1, Math.round(tw * (parsed.height / parsed.width)));
    const sheetW = sheetCols * tw + padding * (sheetCols - 1) + padding * 2;
    const sheetH = sheetRows * th + padding * (sheetRows - 1) + padding * 2;
    const sheet = Buffer.alloc(sheetW * sheetH * 3, 255);
    tiles.forEach((tile, index) => {
      const cellCol = index % sheetCols;
      const cellRow = Math.floor(index / sheetCols);
      const ox = padding + cellCol * (tw + padding);
      const oy = padding + cellRow * (th + padding);
      blitRgb(tile.rgb, captureWidth, captureHeight, sheet, sheetW, ox, oy, tw, th);
    });
    const png = encodePng(sheetW, sheetH, sheet, 3);
    if (png.length <= maxBytes) {
      encoded = { png, width: sheetW, height: sheetH, tileWidth: tw, tileHeight: th };
      break;
    }
    attempt = tw * 0.75;
  }
  if (!encoded) return { ok: false, reason: `拼图压不到 ${(maxBytes / 1024).toFixed(0)}KB 以内` };

  const seconds = (parsed.frames.reduce((a, f) => a + (f.delayMs > 0 ? f.delayMs : 100), 0) / 1000).toFixed(1);
  return {
    ok: true,
    buffer: encoded.png,
    mimeType: 'image/png',
    width: encoded.width,
    height: encoded.height,
    tileWidth: encoded.tileWidth,
    tileHeight: encoded.tileHeight,
    cols: sheetCols,
    rows: sheetRows,
    sampled: tiles.length,
    totalFrames,
    durationMs: Number(seconds) * 1000,
    note: `动图 ${totalFrames} 帧/${seconds}s，纯 JS 解码抽 ${tiles.length} 帧拼成 ${sheetCols}×${sheetRows} 网格，行优先 左上→右下；原图 ${(buf.length / 1024 / 1024).toFixed(2)}MB`
  };
}

/** 把 RGB 源按面积平均缩放到目标网格的 (ox,oy,tw,th) 上（背景已由 sheet 初始化成白色）。 */
function blitRgb(src, sw, sh, sheet, sheetW, ox, oy, tw, th) {
  for (let dy = 0; dy < th; dy += 1) {
    const y0 = Math.floor((dy * sh) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / th));
    const rowOut = ((oy + dy) * sheetW + ox) * 3;
    for (let dx = 0; dx < tw; dx += 1) {
      const x0 = Math.floor((dx * sw) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        const row = y * sw;
        for (let x = x0; x < x1; x += 1) {
          const i = (row + x) * 3;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          n += 1;
        }
      }
      const o = rowOut + dx * 3;
      sheet[o] = Math.round(r / n);
      sheet[o + 1] = Math.round(g / n);
      sheet[o + 2] = Math.round(b / n);
    }
  }
}

/** 静态 GIF → 单帧 PNG（本机没 ffmpeg 时给大 GIF 兜底）。 */
export function renderGifStill(buf, opts = {}) {
  const parsed = parseGifStructure(buf);
  if (!parsed) return { ok: false, reason: 'GIF 结构解析失败' };
  const over = budgetCheck(parsed);
  if (over) return { ok: false, reason: over };
  const maxLongEdge = clampInt(opts.maxLongEdge, 64, 2048, 1280);
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || 1024 * 1024);
  let png = null;
  let width = 0;
  let height = 0;
  compositeFrames(parsed, [0], (canvas, w, h) => {
    const scale = Math.min(1, maxLongEdge / Math.max(w, h));
    width = Math.max(1, Math.round(w * scale));
    height = Math.max(1, Math.round(h * scale));
    const rgb = resizeOverWhite(canvas, w, h, width, height);
    png = encodePng(width, height, rgb, 3);
  });
  if (!png) return { ok: false, reason: '没有可用的帧' };
  if (png.length > maxBytes) {
    const scale = Math.sqrt(maxBytes / png.length) * 0.95;
    const w2 = Math.max(16, Math.round(width * scale));
    const h2 = Math.max(16, Math.round(height * scale));
    const restored = renderGifStill(buf, { ...opts, maxLongEdge: Math.max(w2, h2) });
    return restored.ok ? restored : { ok: false, reason: '单帧仍超出上限' };
  }
  return {
    ok: true,
    buffer: png,
    mimeType: 'image/png',
    width,
    height,
    note: `GIF ${parsed.width}×${parsed.height} ${(buf.length / 1024).toFixed(0)}KB → ${width}×${height} ${(png.length / 1024).toFixed(0)}KB（纯 JS 解码）`
  };
}
