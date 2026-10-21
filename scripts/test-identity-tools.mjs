#!/usr/bin/env node
// T-018 静态契约测试：qq_lookup —— 按名字/群名/QQ 号/群号查这台机器认识的人与会话。
//
// 为什么不直接 import 被测文件：src/mcp-snowluma-safe.js 在模块顶层 loadConfig()
// 并 await server.connect(stdio)，import 它等于真的拉起一个 MCP server。运行期的
// 握手/工具列表由 scripts/test-mcp-servers-stdio.mjs 兜；这里只读源码文本，钉死
// 工具契约：注册一次、参数形状、GET 路径与 header、启用判据、三类失败文案。
//
// 最后一段例外：formatIdentityRows 是零依赖零 IO 的纯函数，真跑一遍能证明 MCP 拿到的
// 行格式就是我们以为的那一种，比再抄一遍正则更可靠。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 仓库源码在 Windows 上是 CRLF；跨行断言不该被行尾符绑架。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const source = read('src/mcp-snowluma-safe.js');
const coreSource = read('src/identity-core.js');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}`);
    return;
  }
  failures.push(name);
  console.log(`❌ ${name}${extra === undefined ? '' : ` —— ${extra}`}`);
}
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  return text.slice(0, index).split('\n').length;
}
function allLinesOf(text, needle) {
  const lines = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    lines.push(text.slice(0, index).split('\n').length);
    from = index + needle.length;
  }
  return lines;
}
/**
 * 工具注册起始偏移/行号：缩进无关。
 * 不能直接 indexOf("'qq_memory_remove'")——文件上方 L347 还有一张工具分类映射表，
 * 同样引号包着这些名字，先撞上的是表项而不是注册块。
 */
function regIndex(name) {
  const match = new RegExp(`server\\.tool\\(\\s*'${name}',`).exec(source);
  return match ? match.index : -1;
}
function regLine(name) {
  const index = regIndex(name);
  return index < 0 ? -1 : source.slice(0, index).split('\n').length;
}
/** 从注册名往前找最近的 server.tool(，截到本工具的 `  );` 收尾。 */
function toolBlock(name) {
  const nameAt = source.indexOf(`'${name}'`);
  if (nameAt < 0) return '';
  const open = source.lastIndexOf('server.tool(', nameAt);
  const close = source.indexOf('\n  );', nameAt);
  if (open < 0) return '';
  return source.slice(open, close < 0 ? source.length : close);
}

const NAME = 'qq_lookup';
const DESC = '按名字、群名、QQ 号或群号查这台机器认识的会话与人，返回可以直接发消息的 key。只读。查不到就直说不知道，不要猜号码。跨会话发言要求两个会话的互通编号相同。';
const EMPTY_TEXT = '没有找到匹配的会话或人（不要猜号码）。';
const block = toolBlock(NAME);

// ── 一、注册与描述 ──────────────────────────────────────────────────────────
console.log('── 一、注册与描述 ─────────────────────────────────────');
const nameLines = allLinesOf(source, `'${NAME}'`);
check(`工具名 '${NAME}' 在源码里只出现一次（就是注册处）`, nameLines.length === 1, `出现在行 ${nameLines.join(',')}`);
check(`注册形式是 server.tool('${NAME}', …)`, source.includes(`server.tool(\n    '${NAME}',`));
check('工具名符合 DSH 的 mcp__<server>__<tool> 命名契约', /^[A-Za-z0-9_-]{1,64}$/.test(NAME));
check('描述逐字使用契约文案', source.includes(`'${DESC}'`));
check('描述覆盖四个查询维度（名字/群名/QQ 号/群号）', ['名字', '群名', 'QQ 号', '群号'].every((word) => DESC.includes(word)));
check('描述声明只读', DESC.includes('只读'));
check('描述禁止猜号码', DESC.includes('查不到就直说不知道，不要猜号码'));
check('描述写明跨会话的互通编号条件', DESC.includes('跨会话发言要求两个会话的互通编号相同'));

// ── 二、参数 ────────────────────────────────────────────────────────────────
console.log('── 二、参数 ───────────────────────────────────────────');
check('query 是必填 z.string()', block.includes('query: z.string().describe(') && !block.includes('query: z.string().optional()'));
check('limit 接受 number|string 且可选', block.includes('limit: z.union([z.number(), z.string()]).optional().describe('));
check('limit 文案写明默认 20、范围 1–50', block.includes('默认 20，范围 1–50'));
check('token 是可选字符串', block.includes('token: z.string().optional().describe('));

// ── 三、请求与结果 ──────────────────────────────────────────────────────────
console.log('── 三、请求与结果 ─────────────────────────────────────');
check('走 GET /api/socialV2/identity', block.includes('/api/socialV2/identity?q='));
check('query 进 URL 前做了 encodeURIComponent', block.includes('encodeURIComponent('));
check('limit 作为查询参数传给桥接', block.includes('&limit='));
check('通过 agentApi 调桥接（复用控制台令牌与超时）', block.includes('await agentApi('));
check('仅在有 token 时带 x-agent-token', block.includes("token ? { headers: { 'x-agent-token': token } } : {}"));
const importLine = source.split('\n').find((line) => line.startsWith('import ') && line.includes('formatIdentityRows'));
check('从 identity-core 引入纯函数 formatIdentityRows', Boolean(importLine), importLine);
const importSpec = importLine?.match(/from '([^']+)'/)?.[1] ?? '';
const importResolved = importSpec ? path.resolve(ROOT, 'src', importSpec) : '';
check('该 import 解析到 src/identity-core.js', importResolved === path.join(ROOT, 'src', 'identity-core.js'), importResolved);
check('identity-core 导出了 formatIdentityRows', coreSource.includes('export function formatIdentityRows('));
check('rows 来自桥接返回的 data.rows', block.includes('Array.isArray(data?.rows)'));
check('结果用 formatIdentityRows(rows) 拼多行文本', block.includes('formatIdentityRows(rows)'));
check('结果首行是「找到 N 条（用 key 发消息）：」', block.includes('找到 ${rows.length} 条（用 key 发消息）：'));
check('空 rows 回契约文案', block.includes(`'${EMPTY_TEXT}'`));
check('空结果不伪装成错误（直接返回文本）', /if \(rows\.length === 0\) \{\s*return \{ content: \[\{ type: 'text', text: '[^']+' \}\] \};/.test(block));
check('结果没有退化成 serializeModelData(JSON)', !block.includes('serializeModelData('));

// ── 四、启用判据 ────────────────────────────────────────────────────────────
console.log('── 四、启用判据 ───────────────────────────────────────');
check('identityEnabled 判据是 cfg.socialV2?.identity?.enabled !== false',
  source.includes('const identityEnabled = () => cfg?.socialV2?.identity?.enabled !== false;'));
check('与 imagesEnabled 同风格的单行箭头辅助',
  /const identityEnabled = \(\) => cfg\?\.socialV2\?\.identity\?\.enabled !== false;/.test(source));
const guardLine = lineOf(source, 'if (identityEnabled()) {');
const registerLine = regLine(NAME);
check('工具注册被 if (identityEnabled()) 包住', guardLine > 0 && guardLine < registerLine, `guard=${guardLine} register=${registerLine}`);
check('注册块在 qq_recall 之后（开关语义与 cross 同源）', regLine('qq_recall') > 0 && registerLine > regLine('qq_recall'));
check('关闭时回调再查一次热更后的配置', block.includes('getConfig().socialV2?.identity?.enabled === false'));
check('关闭分支给出明确文案且 isError',
  block.includes('IDENTITY_DISABLED_TEXT') && source.includes("const IDENTITY_DISABLED_TEXT = '名字映射没有开启，查不到人；不要重试。';"));
check('空 query 先挡一道，不白跑一次 HTTP', block.includes('query 不能为空'));

// ── 五、失败文案 ────────────────────────────────────────────────────────────
console.log('── 五、失败文案 ───────────────────────────────────────');
check('429 按 status 分派', block.includes('Number(error?.status) === 429'));
check('429 读 error.retryAfterMs', block.includes('error?.retryAfterMs'));
check('429 文案是「查太频繁了，约 X 秒后再试」', block.includes('查太频繁了，约 ${seconds} 秒后再试'));
check('403 按 status 分派', block.includes('Number(error?.status) === 403'));
check('403 原样展示 error.message（不自己编原因）', block.includes('text: String(error?.message ?? error)'));
check('其它失败统一「查询失败：…」', block.includes('查询失败：${error?.message ?? error}'));
const errorFlags = (block.match(/isError: true/g) ?? []).length;
check('失败分支都带 isError: true（≥4 处）', errorFlags >= 4, `实际 ${errorFlags} 处`);

// ── 六、位置与唯一性 ────────────────────────────────────────────────────────
console.log('── 六、位置与唯一性 ───────────────────────────────────');
const recallLine = regLine('qq_recall');
const lookupLine = regLine(NAME);
const memoryLine = regLine('qq_memory_remove');
check('插在 qq_recall 块之后', recallLine > 0 && lookupLine > recallLine, `recall=${recallLine} lookup=${lookupLine}`);
check('插在 qq_memory_remove 之前', memoryLine > 0 && lookupLine < memoryLine, `lookup=${lookupLine} memory=${memoryLine}`);
const between = regIndex('qq_recall') >= 0 && regIndex('qq_memory_remove') > regIndex('qq_recall')
  ? source.slice(regIndex('qq_recall'), regIndex('qq_memory_remove'))
  : '';
const betweenNames = [...between.matchAll(/server\.tool\(\s+'([^']+)',/g)].map((match) => match[1]);
check('recall 与 memory_remove 之间只夹着这一个新注册', betweenNames.join(',') === 'qq_recall,qq_lookup', betweenNames.join(','));
const names = [...source.matchAll(/server\.tool\(\s+'([^']+)',/g)].map((match) => match[1]);
const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
check('全文件没有重复的工具名', duplicates.length === 0, duplicates.join(','));
check(`${NAME} 只注册了一次（工具名列表里只出现一次）`, names.filter((name) => name === NAME).length === 1);
check('工具总数仍 ≥ 50（没有误删别的注册块）', names.length >= 50, `实际 ${names.length}`);

// ── 七、formatIdentityRows 真跑一遍（纯函数） ───────────────────────────────
console.log('── 七、formatIdentityRows 真跑一遍 ────────────────────');
const { formatIdentityRows } = await import(pathToFileURL(path.join(ROOT, 'src', 'identity-core.js')).href);
check('空数组 → 空串（空结果的文案由 MCP 兜底）', formatIdentityRows([]) === '');
const privateRow = { kind: 'private', key: 'private:2432829808', label: '阿芙乐尔（QQ 2432829808）', qq: '2432829808' };
check('私聊行输出「私聊 名字（QQ 号）→ key」',
  formatIdentityRows([privateRow]) === '私聊 阿芙乐尔（QQ 2432829808）→ private:2432829808',
  formatIdentityRows([privateRow]));

// ── 收尾 ────────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log('');
if (failures.length === 0) {
  console.log(`结果：${passed}/${total} passed`);
  process.exit(0);
}
console.log(`结果：${passed}/${total} passed，${failures.length} 项失败：`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
