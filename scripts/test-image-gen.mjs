// 生图 IO 薄层（src/image-gen.js）的单测：假 fetch、临时目录、索引裁剪。
//
// 跑法：`node scripts/test-image-gen.mjs`（全过 exit 0，有失败 exit 1）。
// 不连网络：fetchGeneratedImage 全部注入 fetchImpl；落盘/读回/索引全在
// `fs.mkdtemp(os.tmpdir())` 下，跑完递归删除。
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPollinationsUrl } from '../src/image-core.js';
import {
  fetchGeneratedImage,
  saveGeneratedImage,
  readStoredImage,
  readIndex,
  saveIndexEntry,
} from '../src/image-gen.js';

let passed = 0;
let failed = 0;

function eq(actual, expected, name) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`✅ ${name}`);
  } catch {
    failed += 1;
    console.error(`❌ ${name}`);
    console.error(`   actual:   ${inspect(actual, { depth: 4 })}`);
    console.error(`   expected: ${inspect(expected, { depth: 4 })}`);
  }
}

function truthy(value, name) {
  try {
    assert.ok(value);
    passed += 1;
    console.log(`✅ ${name}`);
  } catch {
    failed += 1;
    console.error(`❌ ${name}`);
  }
}

async function throwsAsync(fn, name) {
  try {
    await fn();
    failed += 1;
    console.error(`❌ ${name}（没有抛错）`);
  } catch (error) {
    assert.ok(error instanceof TypeError, `${name} 的异常应为 TypeError`);
    passed += 1;
    console.log(`✅ ${name}`);
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const GIF = Buffer.from('GIF89a______');
const MAX_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXED = {
  one: '11111111-1111-4111-8111-111111111111',
  two: '22222222-2222-4222-8222-222222222222',
  three: '33333333-3333-4333-8333-333333333333',
};

// ── ① fetchGeneratedImage：成功路径 ────────────────────────────────────────
console.log('\n① fetchGeneratedImage 成功');

let captured = null;
const okFetch = async (url, maxBytes) => {
  captured = { url, maxBytes };
  return { statusCode: 200, buffer: JPEG, headers: { 'content-type': 'image/jpeg' } };
};
const okResult = await fetchGeneratedImage({ prompt: '一只猫', width: 512, height: 384, seed: 7, fetchImpl: okFetch });
eq(okResult.ok, true, '200 + JPEG → ok');
eq(okResult.mime, 'image/jpeg', '返回 mime image/jpeg');
eq(okResult.buffer, JPEG, 'buffer 原样返回（不复制）');
eq(captured.maxBytes, MAX_BYTES, '传入的读取上限是 8MB');
eq(captured.url, buildPollinationsUrl({ prompt: '一只猫', width: 512, height: 384, seed: 7 }),
  'URL 由 buildPollinationsUrl 拼出（宽度/高度/seed 都带上）');
truthy(!('status' in okResult), '成功结果不带 status');

let captured2 = null;
await fetchGeneratedImage({
  prompt: '  a\n b  ',
  seed: '0',
  safe: false,
  fetchImpl: async (url) => {
    captured2 = url;
    return { status: 200, body: PNG };
  },
});
eq(captured2, buildPollinationsUrl({ prompt: 'a b', seed: '0', safe: false }),
  '提示词先清洗；fetchImpl 返回 status/body 别名也认');
eq(new URL(captured2).searchParams.get('seed'), '0', 'seed 0 透传到 URL');
eq(new URL(captured2).searchParams.get('safe'), 'false', 'safe:false 透传到 URL');

const pngResult = await fetchGeneratedImage({
  prompt: '图',
  fetchImpl: async () => ({ statusCode: 200, buffer: PNG }),
});
eq(pngResult.mime, 'image/png', 'PNG 魔数嗅探成 image/png');

// ── ② fetchGeneratedImage：402 / 5xx / 非图片 / 网络失败 ────────────────────
console.log('\n② fetchGeneratedImage 失败路径');

const limitedHeader = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => ({ statusCode: 402, headers: { 'retry-after': '12' } }),
});
eq(limitedHeader.reason, 'rate_limited', '402 + Retry-After → rate_limited');
eq(limitedHeader.retryAfterMs, 12000, 'Retry-After 秒数字符串换成毫秒');
eq(limitedHeader.status, 402, 'rate_limited 带 status');

const limitedBare = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => ({ statusCode: 402 }),
});
eq(limitedBare.retryAfterMs, 45000, '402 缺 Retry-After → 45000 兜底');

const limitedThrown = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => {
    throw new Error('图片抓取失败：HTTP 402');
  },
});
eq(limitedThrown.reason, 'rate_limited', 'safeFetchBuffer 抛 402 也归 rate_limited');
eq(limitedThrown.retryAfterMs, 45000, '抛错路径拿不到 Retry-After，按 45 秒兜底');
eq(limitedThrown.status, 402, '抛错路径仍带 status 402');

const serverErr = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => ({ statusCode: 500, buffer: Buffer.from('boom') }),
});
eq(serverErr.reason, 'upstream_error', '500 → upstream_error');
eq(serverErr.status, 500, '500 带 status');

const serverThrown = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => {
    throw new Error('图片抓取失败：HTTP 503');
  },
});
eq(serverThrown.reason, 'upstream_error', '抛 503 也归 upstream_error');
eq(serverThrown.status, 503, '抛错路径保留 503');

const notImage = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => ({ statusCode: 200, buffer: Buffer.from('<html>error</html>') }),
});
eq(notImage.reason, 'bad_content', '200 但正文不是图片 → bad_content');

const netFail = await fetchGeneratedImage({
  prompt: '猫',
  fetchImpl: async () => {
    throw new Error('getaddrinfo ENOTFOUND image.pollinations.ai');
  },
});
eq(netFail.reason, 'fetch_failed', '无状态码的网络错误 → fetch_failed');
truthy(!('status' in netFail), 'fetch_failed 不带 status');

const badReturn = await fetchGeneratedImage({ prompt: '猫', fetchImpl: async () => undefined });
eq(badReturn.reason, 'fetch_failed', 'fetchImpl 返回 undefined → fetch_failed');

const nullReturn = await fetchGeneratedImage({ prompt: '猫', fetchImpl: async () => null });
eq(nullReturn.reason, 'fetch_failed', 'fetchImpl 返回 null → fetch_failed');

// ── ③ saveGeneratedImage：落盘 ─────────────────────────────────────────────
console.log('\n③ saveGeneratedImage');

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'image-gen-test-'));
const imageDir = path.join(tmpRoot, 'images');

const meta = { width: 512, height: 384 };
const saved = await saveGeneratedImage({
  dir: imageDir,
  buffer: JPEG,
  mime: 'image/jpeg',
  prompt: '  一只\n猫  ',
  meta,
  now: 1_700_000_000_000,
});
truthy(UUID_RE.test(saved.id), 'id 是 crypto.randomUUID() 的形状');
eq(saved.file, path.join(imageDir, `${saved.id}.jpg`), 'jpeg → .jpg，文件名 <id>.<ext>');
eq(saved.bytes, JPEG.length, 'bytes = buffer 长度');
eq(saved.mime, 'image/jpeg', 'mime 归一成 image/jpeg');
eq(saved.prompt, '一只 猫', '落盘记录里的 prompt 已清洗');
eq(saved.ts, 1_700_000_000_000, 'now 可注入，ts 精确');
eq(saved.meta, meta, 'meta 原样带回');
truthy(saved.meta !== meta, 'meta 是浅拷贝，不是同一引用');
eq(await fs.promises.readFile(saved.file), JPEG, '文件内容与 buffer 一致');
truthy(fs.existsSync(imageDir), '目录不存在时递归创建');

const aliasSaved = await saveGeneratedImage({ dir: imageDir, buffer: JPEG, mime: 'JPEG', prompt: '猫' });
eq(path.extname(aliasSaved.file), '.jpg', 'mime 大小写/简写 jpeg 都落到 .jpg');
const jpgAliasSaved = await saveGeneratedImage({ dir: imageDir, buffer: JPEG, mime: 'jpg', prompt: '猫' });
eq(path.extname(jpgAliasSaved.file), '.jpg', 'mime "jpg" 落到 .jpg');

const sniffedSaved = await saveGeneratedImage({ dir: imageDir, buffer: PNG, mime: 'application/octet-stream', prompt: '猫' });
eq(path.extname(sniffedSaved.file), '.png', 'mime 认不出时用魔数嗅探成 .png');
eq(sniffedSaved.mime, 'image/png', '嗅探后的 mime 写回记录');

const nestedSaved = await saveGeneratedImage({ dir: path.join(imageDir, 'a', 'b'), buffer: GIF, mime: 'image/gif', prompt: '猫' });
truthy(fs.existsSync(nestedSaved.file), '多级目录也能创建并写入');
eq(nestedSaved.mime, 'image/gif', 'gif mime 正确');

await throwsAsync(() => saveGeneratedImage({ dir: imageDir, buffer: Buffer.alloc(0), mime: 'image/png', prompt: '猫' }),
  '空 buffer 抛 TypeError（编程错误不静默）');
await throwsAsync(() => saveGeneratedImage({ dir: imageDir, buffer: 'not buffer', mime: 'image/png', prompt: '猫' }),
  '非 Buffer 抛 TypeError');
await throwsAsync(() => saveGeneratedImage({ dir: '', buffer: PNG, mime: 'image/png', prompt: '猫' }),
  '空 dir 抛 TypeError');
await throwsAsync(() => saveGeneratedImage({ dir: imageDir, buffer: Buffer.from('plain'), mime: 'text/plain', prompt: '猫' }),
  '认不出的 mime + 非图片 buffer 抛 TypeError');

if (process.platform !== 'win32') {
  const stat = await fs.promises.stat(saved.file);
  eq(stat.mode & 0o777, 0o600, 'POSIX 下文件权限是 0600');
}

// ── ④ readStoredImage ─────────────────────────────────────────────────────
console.log('\n④ readStoredImage');

const readJpg = await readStoredImage({ dir: imageDir, id: saved.id });
eq(readJpg.mime, 'image/jpeg', '按 id 读回 jpg，mime 正确');
eq(readJpg.buffer, JPEG, '按 id 读回 jpg，字节一致');

const pngId = sniffedSaved.id;
await fs.promises.writeFile(path.join(imageDir, `${pngId}.jpg`), Buffer.alloc(0)); // 空的同名 jpg 应被跳过
const readPng = await readStoredImage({ dir: imageDir, id: pngId });
eq(readPng.mime, 'image/png', '空 jpg 文件跳过后继续找 png（扩展名顺序 jpg→png→webp→gif）');

const readMissing = await readStoredImage({ dir: imageDir, id: FIXED.one });
eq(readMissing, null, '不存在的 id → null');
eq(await readStoredImage({ dir: imageDir, id: '../../config.json' }), null, '路径穿越 id → null');
eq(await readStoredImage({ dir: imageDir, id: `${saved.id}/x` }), null, '带斜杠的 id → null');
eq(await readStoredImage({ dir: imageDir, id: saved.id.toUpperCase() }), null, '大写 id 不匹配允许集 → null');
eq(await readStoredImage({ dir: imageDir, id: saved.id.slice(0, 35) }), null, '35 位 id → null');
eq(await readStoredImage({ dir: imageDir, id: null }), null, 'null id → null');
eq(await readStoredImage({ dir: '', id: saved.id }), null, '空 dir → null');
eq(await readStoredImage({ dir: imageDir }), null, '缺 id → null');
eq(await readStoredImage(null), null, 'null 选项 → null');

const upperFile = path.join(imageDir, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png`);
await fs.promises.writeFile(upperFile, PNG);
const readLower = await readStoredImage({ dir: imageDir, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
eq(readLower.mime, 'image/png', '小写 UUID 正常命中');
eq(await readStoredImage({ dir: imageDir, id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }), null,
  '大写 UUID 不会命中（正则只放小写）');

// ── ⑤ 索引：读写 / 排序 / 去重 / 裁剪 ───────────────────────────────────────
console.log('\n⑤ 索引');

const indexPath = path.join(imageDir, 'image-index.json');
eq(await readIndex(indexPath), [], '索引不存在 → []');
eq(await readIndex(''), [], '空 indexPath → []');

await fs.promises.writeFile(indexPath, '{not json');
eq(await readIndex(indexPath), [], '坏 JSON → []');
await fs.promises.writeFile(indexPath, JSON.stringify([{ id: 'bad' }, { id: FIXED.one, file: path.join(imageDir, 'x.jpg'), ts: 10 }]));
eq((await readIndex(indexPath)).map((item) => item.id), [FIXED.one], '坏条目被丢弃，合法条目保留');

await fs.promises.writeFile(indexPath, JSON.stringify({
  version: 1,
  entries: [
    { id: FIXED.one, file: path.join(imageDir, '1.jpg'), ts: 100 },
    { id: FIXED.two, file: path.join(imageDir, '2.jpg'), ts: 300 },
    { id: FIXED.three, file: path.join(imageDir, '3.jpg'), ts: 200 },
  ],
}));
eq((await readIndex(indexPath)).map((item) => item.id), [FIXED.two, FIXED.three, FIXED.one],
  'readIndex 按 ts 倒序（最新在前）');

const fileA = path.join(imageDir, 'a.jpg');
const fileB = path.join(imageDir, 'b.jpg');
const fileC = path.join(imageDir, 'c.jpg');
await fs.promises.writeFile(fileA, JPEG);
await fs.promises.writeFile(fileB, JPEG);
await fs.promises.writeFile(fileC, JPEG);
const index2 = path.join(tmpRoot, 'idx2.json');

await saveIndexEntry(index2, { id: FIXED.one, file: fileA, ts: 1000, bytes: JPEG.length, mime: 'image/jpeg', prompt: 'a' }, 2);
await saveIndexEntry(index2, { id: FIXED.two, file: fileB, ts: 2000, bytes: JPEG.length, mime: 'image/jpeg', prompt: 'b' }, 2);
const afterTwo = await saveIndexEntry(index2, { id: FIXED.three, file: fileC, ts: 3000, mime: 'image/jpeg', prompt: 'c' }, 2);
eq(afterTwo.map((item) => item.id), [FIXED.three, FIXED.two], '保留 ts 最新的两条（max=2）');
eq(afterTwo.length, 2, '索引长度 = max');
eq(fs.existsSync(fileA), false, '被裁掉的最旧文件已删除');
eq(fs.existsSync(fileB), true, '未裁掉的文件还在');
truthy(fs.existsSync(index2), '索引文件已落盘');
const indexDoc = JSON.parse(await fs.promises.readFile(index2, 'utf8'));
eq(indexDoc.version, 1, '索引文件带 version 1');
eq(indexDoc.entries.length, 2, '索引文件里也是 2 条');

const beforeDup = await readIndex(index2);
const dupSaved = await saveIndexEntry(index2, { id: FIXED.two, file: fileB, ts: 4000, prompt: 'b2' }, 2);
eq(dupSaved.map((item) => item.id), [FIXED.two, FIXED.three], '同 id 重复保存是替换并置顶');
eq(dupSaved.length, beforeDup.length, '替换不增加条数');
eq(dupSaved[0].prompt, 'b2', '替换后字段更新');

const invalidSaved = await saveIndexEntry(path.join(tmpRoot, 'idx-invalid.json'), { id: 'not-a-uuid', file: fileA, ts: 1 });
eq(invalidSaved, [], '非法 id 的条目被忽略，返回现有索引');
truthy(!fs.existsSync(path.join(tmpRoot, 'idx-invalid.json')), '非法条目不会创建索引文件');

await throwsAsync(() => saveIndexEntry('', { id: FIXED.one, file: fileA, ts: 1 }), '空 indexPath 抛 TypeError');

// max 钳制 [1,1000]：max=0 当 1 用
const index3 = path.join(tmpRoot, 'idx3.json');
await saveIndexEntry(index3, { id: FIXED.one, file: fileA, ts: 1000 }, 0);
const clamped = await saveIndexEntry(index3, { id: FIXED.two, file: fileB, ts: 2000 }, 0);
eq(clamped.length, 1, 'max=0 被钳到 1');
eq(clamped[0].id, FIXED.two, 'max=0 时保留最新一条');

// 裁剪时不能顺着被篡改的 file 字段删到索引目录之外
const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'image-gen-outside-'));
const outsideFile = path.join(outsideDir, 'keep-me.txt');
await fs.promises.writeFile(outsideFile, 'outside');
const index4 = path.join(tmpRoot, 'idx4.json');
await saveIndexEntry(index4, { id: FIXED.one, file: outsideFile, ts: 1000 }, 1);
await saveIndexEntry(index4, { id: FIXED.two, file: fileB, ts: 2000 }, 1);
truthy(fs.existsSync(outsideFile), '裁剪只删索引目录内的文件，站外文件不动');
eq((await readIndex(index4)).map((item) => item.id), [FIXED.two], '站外条目被移出索引');

// prompt 在索引里截到 300 码点
const index5 = path.join(tmpRoot, 'idx5.json');
await saveIndexEntry(index5, { id: FIXED.three, file: fileC, ts: 5000, prompt: '猫'.repeat(320) }, 10);
eq(Array.from((await readIndex(index5))[0].prompt).length, 300, '索引里的 prompt 截到 300 码点');

// ── 收尾 ───────────────────────────────────────────────────────────────────
await fs.promises.rm(tmpRoot, { recursive: true, force: true });
await fs.promises.rm(outsideDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '全部通过' : '存在失败'}：${passed} 通过 / ${failed} 失败（共 ${passed + failed} 条断言）`);
process.exitCode = failed === 0 ? 0 : 1;
