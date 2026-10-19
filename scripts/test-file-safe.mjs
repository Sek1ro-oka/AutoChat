// 文件读写 MCP server（src/mcp-file-safe.js）自测：
//   1) 以 stdio 拉起 server，列出工具（应有 5 个）
//   2) 非管理员写操作被拒绝
//   3) 管理员写入 / 读取 / 覆盖保护 / 删除
//   4) 路径穿越、非白名单扩展名被拒绝
//   5) SnowLuma 在线时，管理员发文件到自己的私聊并删除（端到端）
// 不依赖 DSH；SnowLuma 不在线时跳过第 5 步。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// 生成一个结构合法的最小 PDF（含正确 xref），用来验证 .pdf 文本层抽取
function buildMinimalPdf(lines) {
  const objs = [];
  const content = 'BT /F1 18 Tf 40 700 Td '
    + lines.map((line, i) => `${i ? '0 -24 Td ' : ''}(${line.replace(/[()\\]/g, '\\$&')}) Tj `).join('')
    + 'ET';
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = Buffer.byteLength(out);
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const cfg = loadConfig();
const ADMIN = Number(cfg.file?.adminQQ?.[0] ?? cfg.ownerQQ ?? 0);
const OUTSIDER = ADMIN === 1234567 ? 7654321 : 1234567;
const TEST_NAME = 'file-safe-自测.md';
const TEST_TEXT = `# 文件功能自测\n\n时间：${new Date().toISOString()}\n`;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `：${detail}` : ''}`);
  if (!ok) failures += 1;
}

function parse(result) {
  const text = result?.content?.map((part) => part.text ?? '').join('') ?? '';
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ...parse(result), isError: result?.isError === true };
}

const transport = new StdioClientTransport({ command: NODE, args: [path.join(ROOT, 'src', 'mcp-file-safe.js')], cwd: ROOT, stderr: 'pipe' });
const client = new Client({ name: 'file-safe-selftest', version: '0.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('工具列表', names.join(',') === 'file_delete,file_list,file_read,file_save,file_send', names.join(','));

  const list0 = await call(client, 'file_list', {});
  check('file_list 可用', list0.isError !== true && Array.isArray(list0.json?.files), `count=${list0.json?.count}`);

  const outsiderWrite = await call(client, 'file_save', { name: TEST_NAME, content: TEST_TEXT, operator_qq: OUTSIDER });
  check('非管理员写入被拒绝', outsiderWrite.isError === true, outsiderWrite.text.slice(0, 60));

  const saved = await call(client, 'file_save', { name: TEST_NAME, content: TEST_TEXT, operator_qq: ADMIN });
  check('管理员写入成功', saved.isError !== true && saved.json?.name === TEST_NAME, saved.text.slice(0, 80));

  const dup = await call(client, 'file_save', { name: TEST_NAME, content: TEST_TEXT, operator_qq: ADMIN });
  check('同名未加 overwrite 被拒绝', dup.isError === true, dup.text.slice(0, 60));

  const read = await call(client, 'file_read', { name: TEST_NAME });
  check('读取内容一致', String(read.json?.text ?? '').replace(/\s+$/, '') === TEST_TEXT.trim(), `chars=${read.json?.chars}`);

  // 分页：写一个长文件，用 offset + max_chars 翻两页
  const longName = 'file-safe-分页自测.txt';
  const longText = Array.from({ length: 200 }, (_, i) => `第${i + 1}行-ABCDEFGHIJ`).join('\n');
  const savedLong = await call(client, 'file_save', { name: longName, content: longText, overwrite: true, operator_qq: ADMIN });
  const page1 = await call(client, 'file_read', { name: longName, max_chars: 500 });
  const nextOffset = page1.json?.nextOffset;
  const page2 = await call(client, 'file_read', { name: longName, offset: nextOffset, max_chars: 500 });
  const joined = `${page1.json?.text ?? ''}${page2.json?.text ?? ''}`.replace(/\n\n…（已截断.*$/s, '');
  check('分页读取 offset/nextOffset', savedLong.isError !== true && Number.isInteger(nextOffset) && page2.json?.offset === nextOffset && joined.startsWith('第1行-ABCDEFGHIJ'), `nextOffset=${nextOffset}`);
  await call(client, 'file_delete', { name: longName, operator_qq: ADMIN });

  const traversal = await call(client, 'file_read', { name: '../config.json' });
  check('路径穿越被拒绝', traversal.isError === true, traversal.text.slice(0, 60));

  const badExt = await call(client, 'file_save', { name: '../evil.exe', content: 'x', operator_qq: ADMIN });
  check('非白名单扩展名被拒绝', badExt.isError === true, badExt.text.slice(0, 60));

  const list1 = await call(client, 'file_list', {});
  check('列表里能看到刚写入的文件', Array.isArray(list1.json?.files) && list1.json.files.some((f) => f.name === TEST_NAME));

  // PDF：直接写进托管目录（file_save 不允许生成 PDF），再用 file_read 抽文本层
  const pdfName = 'file-safe-自测.pdf';
  const pdfPath = path.join(ROOT, cfg.file?.dir ?? 'files', pdfName);
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, buildMinimalPdf(['Hello AutoChat PDF', 'file-safe test']));
  const pdfRead = await call(client, 'file_read', { name: pdfName });
  check('PDF 文本层抽取', pdfRead.isError !== true && String(pdfRead.json?.text ?? '').includes('Hello AutoChat PDF'), `pages=${pdfRead.json?.pages}`);
  fs.unlinkSync(pdfPath);

  // 端到端：SnowLuma 在线时发到管理员私聊（带 delete_after，发送即删）
  let online = false;
  try {
    const res = await fetch(`${String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')}/get_login_info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.snowluma?.accessToken ? { Authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(5000)
    });
    const body = await res.json().catch(() => ({}));
    online = body?.status === 'ok' && body?.data?.user_id != null;
  } catch { online = false; }

  if (online && Number.isSafeInteger(ADMIN) && ADMIN > 0) {
    const sent = await call(client, 'file_send', { kind: 'private', target_id: ADMIN, name: TEST_NAME, delete_after: true, operator_qq: ADMIN });
    check('发送到 QQ 私聊并删除本地文件', sent.isError !== true && sent.json?.deletedAfterSend === true, sent.text.slice(0, 100));
    check('发送后文件已从目录消失', !fs.existsSync(path.join(ROOT, cfg.file?.dir ?? 'files', TEST_NAME)));
  } else {
    console.log('· SnowLuma 不在线，跳过 file_send 端到端');
    const removed = await call(client, 'file_delete', { name: TEST_NAME, operator_qq: ADMIN });
    check('管理员删除成功', removed.isError !== true && removed.json?.deleted === true, removed.text.slice(0, 60));
  }
} catch (error) {
  console.log(`❌ 自测异常：${error?.message ?? error}`);
  failures += 1;
} finally {
  try { await client.close(); } catch {}
}

console.log(failures === 0 ? '\n文件功能自测全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
