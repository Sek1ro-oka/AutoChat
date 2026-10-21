// 日记本自检（纯本地、不动真实 data）：
// 1) key / 日期 / 路径穿越的拦截
// 2) 一天多则、按日期分文件、列表与读回
// 3) 净化（本机路径、凭据）、长度上限、每日则数上限
// 4) 每个会话一个独立文件夹
// 用法：node scripts/test-diary.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  diaryKeyOk,
  diaryFolderName,
  diaryDirOf,
  diaryFilePath,
  normalizeDiaryDate,
  sanitizeDiaryText,
  writeDiaryEntry,
  listDiaryEntries,
  readDiaryEntry,
  diaryStatsOf,
  MAX_ENTRIES_PER_DAY,
  MAX_ENTRY_CHARS
} from '../src/diary-store.js';

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function throws(fn, name) {
  try { fn(); ok(false, name, '预期抛错但没有'); } catch { ok(true, name); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
const groupKey = 'group:123456789';
const privateKey = 'private:987654321';

try {
  console.log('## key 与路径');
  ok(diaryKeyOk(groupKey) && diaryKeyOk(privateKey), '合法 key 通过');
  ok(!diaryKeyOk('group:abc') && !diaryKeyOk('group:1x2') && !diaryKeyOk('../x') && !diaryKeyOk('') && !diaryKeyOk('group:'), '非法 key 被拒');
  ok(diaryFolderName(groupKey) === 'group_123456789', '文件夹名由 key 派生');
  ok(diaryDirOf(root, groupKey).startsWith(path.resolve(root)), '目录落在根内');
  throws(() => diaryDirOf(root, 'group:../../etc'), '穿越 key 抛错');
  throws(() => diaryFilePath(root, groupKey, '2026-13-01'), '非法月份抛错');
  throws(() => diaryFilePath(root, groupKey, '2026-02-30'), '不存在的日期抛错');

  console.log('## 互通组共用一本（cross:<gid>）');
  ok(diaryKeyOk('cross:3'), 'cross:3 是合法 key（同组共用一本）');
  ok(diaryFolderName('cross:3') === 'cross_3', '互通组文件夹名是 cross_3');
  ok(diaryDirOf(root, 'cross:3') === path.join(path.resolve(root), 'cross_3'), '互通组目录落在 diaries/cross_3');
  ok(!diaryKeyOk('cross:') && !diaryKeyOk('cross:abc') && !diaryKeyOk('cross:1x2') && !diaryKeyOk('cross:3/../x'), 'cross 缺编号 / 非数字 / 带路径被拒');
  let crossErr = '';
  try { diaryFolderName('cross:abc'); } catch (error) { crossErr = String(error?.message ?? error); }
  ok(crossErr.includes('cross:<互通组编号>'), '错误文案提到 cross:<互通组编号>', crossErr);
  const crossNow = new Date(2026, 9, 20, 22, 31, 5).getTime();
  const wc = writeDiaryEntry({ root, key: 'cross:3', content: '群里和私聊共用的一页。', now: crossNow });
  ok(wc.ok && fs.existsSync(path.join(path.resolve(root), 'cross_3', '2026-10-20.md')), '互通组日记写进 cross_3/<日期>.md');
  ok(diaryDirOf(root, 'cross:3') !== diaryDirOf(root, groupKey), '互通组本子与本群自己的本子分开');

  console.log('## 日期');
  const now = new Date(2026, 9, 20, 22, 31, 5).getTime(); // 本地 2026-10-20 22:31
  ok(normalizeDiaryDate('', now) === '2026-10-20', '空日期 = 今天（本地时区）');
  ok(normalizeDiaryDate('2026-10-19', now) === '2026-10-19', '过去的日期可用');
  throws(() => normalizeDiaryDate('2026-10-21', now), '未来日期被拒');

  console.log('## 写入与读回');
  const w1 = writeDiaryEntry({ root, key: groupKey, content: '今天有人说我像客服，我不服。', title: '不服', mood: '不爽', tags: ['群聊', '被说AI味'], now });
  ok(w1.ok && w1.date === '2026-10-20' && w1.entries === 1 && w1.created === true, '首次写入建当天文件');
  const file1 = diaryFilePath(root, groupKey, '2026-10-20');
  ok(fs.existsSync(file1), '文件落在 <folder>/<date>.md');
  const text1 = fs.readFileSync(file1, 'utf8');
  ok(text1.startsWith('# 2026-10-20'), '文件头是日期');
  ok(text1.includes('## 22:31 · 不服'), '分节标题含时间与标题');
  ok(text1.includes('（心情：不爽 ｜ 标签：群聊、被说AI味）'), 'meta 行含心情与标签');

  const w2 = writeDiaryEntry({ root, key: groupKey, content: '第二则。', now: now + 60_000 });
  ok(w2.entries === 2, '同一天可追加第二则');
  const list = listDiaryEntries({ root, key: groupKey, now });
  ok(list.total === 1 && list.items.length === 1, '只列出一天（一个文件）');
  ok(list.items[0].date === '2026-10-20' && list.items[0].entries === 2, '列表带则数');
  ok(list.items[0].preview.length > 0 && list.items[0].preview.length <= 61, '列表带有界摘要');
  ok(list.folder === 'group_123456789', '列表回带文件夹名');

  const readAll = readDiaryEntry({ root, key: groupKey, date: '2026-10-20', now });
  ok(readAll.ok && readAll.entries === 2 && readAll.text.includes('第二则'), '读回全文');
  writeDiaryEntry({ root, key: groupKey, content: '很长的一则。'.repeat(120), date: '2026-10-18', now });
  const readCut = readDiaryEntry({ root, key: groupKey, date: '2026-10-18', maxChars: 500, now });
  ok(readCut.ok && readCut.truncated === true && readCut.text.length === 500, '超长按 maxChars 截断并标记');
  const readMissing = readDiaryEntry({ root, key: groupKey, date: '2026-10-01', now });
  ok(readMissing.ok === false && readMissing.missing === true, '没有那天的日记如实说缺失');

  console.log('## 会话隔离');
  const wp = writeDiaryEntry({ root, key: privateKey, content: '私聊的一则。', now });
  ok(wp.ok, '私聊可独立写入');
  ok(diaryDirOf(root, groupKey) !== diaryDirOf(root, privateKey), '两个聊天不同文件夹');
  ok(fs.existsSync(path.join(diaryDirOf(root, privateKey), '2026-10-20.md')), '私聊文件在自己的文件夹');
  const listGroup = listDiaryEntries({ root, key: groupKey, now });
  const groupFiles = fs.readdirSync(diaryDirOf(root, groupKey)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).length;
  ok(listGroup.total === groupFiles, '群聊列表只数自己的文件（看不到私聊的）');
  ok(!fs.readdirSync(diaryDirOf(root, groupKey)).includes('private_987654321'), '群聊目录下没有私聊子目录');

  console.log('## 净化');
  const dirty = writeDiaryEntry({
    root,
    key: groupKey,
    content: '他在 C:\\Users\\MR\\secret.txt 里翻东西，还说 token=abcd1234 给我看。',
    now
  });
  const dirtyText = fs.readFileSync(diaryFilePath(root, groupKey, '2026-10-20'), 'utf8');
  ok(dirty.ok && !/C:\\\\Users/.test(dirtyText) && !dirtyText.includes('C:\\Users'), '本机路径被隐去');
  ok(!dirtyText.includes('abcd1234'), '凭据形态被隐去');
  ok(sanitizeDiaryText('a\r\nb\u0000c') === 'a\nbc', '统一换行并去控制字符');
  ok(sanitizeDiaryText('x'.repeat(MAX_ENTRY_CHARS + 50), MAX_ENTRY_CHARS).length === MAX_ENTRY_CHARS, '正文按上限截断');
  throws(() => writeDiaryEntry({ root, key: groupKey, content: '   ', now }), '空正文被拒');

  console.log('## 上限与并发安全');
  let last = null;
  for (let i = 0; i < MAX_ENTRIES_PER_DAY; i += 1) {
    last = writeDiaryEntry({ root, key: groupKey, content: `第 ${i} 则`, date: '2026-10-19', now });
  }
  ok(last && last.entries === MAX_ENTRIES_PER_DAY, `同一天可写到 ${MAX_ENTRIES_PER_DAY} 则`);
  throws(() => writeDiaryEntry({ root, key: groupKey, content: '超了', date: '2026-10-19', now }), '超过每日则数被拒');
  ok(!fs.existsSync(`${diaryFilePath(root, groupKey, '2026-10-19')}.tmp`), '写入后不留 .tmp');

  console.log('## 汇总');
  const stats = diaryStatsOf({ root, key: groupKey, now });
  ok(stats.days >= 3 && stats.entries > 0 && stats.bytes > 0, '汇总读数（天数/则数/字节）');

  console.log('## 提示词与工具接线（仓库内）');
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..');
  const preset = fs.readFileSync(path.join(repoRoot, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  ok(preset.includes('qq_diary_write') && preset.includes('qq_diary_list') && preset.includes('qq_diary_read'), '二代提示词提到三个日记工具');
  const mcp = fs.readFileSync(path.join(repoRoot, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  ok(mcp.includes("'qq_diary_write'") && mcp.includes("'qq_diary_list'") && mcp.includes("'qq_diary_read'"), 'MCP 侧注册了三个日记工具');
  const bridge = fs.readFileSync(path.join(repoRoot, 'src', 'bridge.js'), 'utf8');
  ok(bridge.includes('/api/socialV2/diary-write') && bridge.includes('/api/socialV2/diary-list') && bridge.includes('/api/socialV2/diary-read'), '桥接侧有三个日记端点');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n日记自检：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
