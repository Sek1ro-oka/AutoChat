import { deflateSync } from 'node:zlib';
import { loadConfig } from '../src/config.js';
import { Model, prepareMessages, estimateInput, costMicro, usageCost } from '../src/model.js';
import { Store, budgetDay } from '../src/store.js';
import { imageData, IMAGE_TOKEN_RESERVE } from '../src/vision.js';

// Synthetic public test image: a red square on the left and blue circle on the right.
// No user pictures, chat history, QQ account details, or local files are read.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}
const width = 256, height = 128, pixels = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const red = x >= 24 && x < 104 && y >= 24 && y < 104;
  const blue = (x - 192) ** 2 + (y - 64) ** 2 <= 40 ** 2;
  const offset = y * (width * 3 + 1) + 1 + x * 3;
  pixels[offset] = blue ? 0 : 255;
  pixels[offset + 1] = red || blue ? 0 : 255;
  pixels[offset + 2] = red ? 0 : 255;
}
const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const config = loadConfig(), store = new Store(config.databasePath);
try {
  const messages = prepareMessages([], '请客观描述图片中左右两侧的颜色和形状，用中文回答。', config);
  const reservation = store.reserve(budgetDay(), costMicro(estimateInput(messages) + IMAGE_TOKEN_RESERVE,
    config.maxOutput, config), config.budgetMicro, Date.now());
  if (!reservation) throw new Error('BUDGET_EXHAUSTED');
  try {
    const result = await new Model(config).complete(messages, { images: [imageData(png)] });
    const actual = usageCost(result.usage, config);
    if (actual === null) store.uncertain(reservation); else store.settle(reservation, actual);
    const verified = /红/.test(result.text) && /蓝/.test(result.text) && /方/.test(result.text) && /圆/.test(result.text);
    console.log(JSON.stringify({ verified, usage: result.usage, conservativeCostCny: actual === null ? null : actual / 1e6 }));
    if (!verified) process.exitCode = 1;
  } catch { store.uncertain(reservation); throw new Error('VISION_DIAGNOSTIC_FAILED'); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
