#!/usr/bin/env node
// 跨渠道回忆 MCP 工具（T-016 步骤 4）：qq_recall 的注册形状 + 描述红线 + 调用点契约测试。
//
// 为什么是「静态」断言：src/mcp-snowluma-safe.js 在模块顶层就 new McpServer(...) 并把
// StdioServerTransport 接到当前进程的 stdio 上——import 它等于把真的 MCP 服务挂进测试进程。
// 所以这里只读源码文本 + 正则/切片，钉死这一层：
//   ① 工具注册在 qq_memory_query 之后（记忆类工具放一起），且整块在 qq_memory_remove 之前收口；
//   ② 描述写清「只读 / 同组 / 不要每轮都查 / 查不到就直说没找到」，且不带敏感词；
//   ③ 六个入参的名字与类型（token 可选、key 必填、hours/limit 是 number）；
//   ④ 调用点：POST /api/socialV2/cross/recall，body 字段与桥接一致，token 进 x-agent-token 头；
//   ⑤ 三条错误/空结果文案分支（429 / 403 disabled / 没找到）+ 通用失败带 reason；
//   ⑥ 启用判据是 cross.enabled，且**不**登记 TOOL_CONFIG_FLAGS（用户明确说这个功能不进控制台）。
// 端点的真实行为在 test-cross-endpoints.mjs，纯函数在 test-cross-core.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 统一把 CRLF 折成 LF：仓库源码在 Windows 下是 CRLF，跨行断言不该被行尾符绊倒。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

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
function sliceBetween(text, a, b) {
  const start = text.indexOf(a);
  if (start < 0) return '';
  const end = text.indexOf(b, start + a.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const mcp = read('src/mcp-snowluma-safe.js');
const bridge = read('src/bridge.js');

// ── 组零：两个被改文件语法可解析 ──────────────────────────────────────────
console.log('\n── 组零：node --check ──────────────────────────────────────');
for (const rel of ['src/mcp-snowluma-safe.js', 'scripts/test-cross-tools.mjs']) {
  const result = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
  check(`node --check ${rel}`, result.status === 0, (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
}

// ── 组一：注册位置与启用判据 ─────────────────────────────────────────────
console.log('\n── 组一：注册位置与启用判据 ───────────────────────────────');
const recallStart = mcp.indexOf("'qq_recall'");
check('源码里注册了 qq_recall 工具', recallStart > 0);
const recallBlock = sliceBetween(mcp, "// ── 跨渠道回忆（T-016）", "\nserver.tool(\n  'qq_memory_remove'");
check('能切出 qq_recall 注册块', recallBlock.length > 1500, `长度 ${recallBlock.length}`);
check('qq_recall 在 qq_memory_query 之后注册（记忆类工具放一起）',
  mcp.indexOf("'qq_memory_query'") < recallStart);
check('qq_recall 在 qq_memory_remove 之前收口',
  recallStart < mcp.indexOf("'qq_memory_remove'"));
check('启用判据是 cfg.socialV2?.cross?.enabled !== false',
  recallBlock.includes('cfg.socialV2?.cross?.enabled !== false'));
check('回调里运行时再读一次配置（桥接热更新，进程常驻）',
  recallBlock.includes('getConfig().socialV2?.cross?.enabled === false'));
check('禁用时直接回「跨渠道回忆没有开启。」', recallBlock.includes('跨渠道回忆没有开启。'));

// 用户明确说过：这个功能不进控制台 ⇒ 不能登记 TOOL_CONFIG_FLAGS（那等于新增一个控制台开关）。
const flagsBlock = sliceBetween(mcp, 'const TOOL_CONFIG_FLAGS = {', '\n};');
check('qq_recall 没有被写进 TOOL_CONFIG_FLAGS',
  !flagsBlock.includes('qq_recall') && !flagsBlock.includes('recall'),
  flagsBlock.includes('qq_recall') ? 'TOOL_CONFIG_FLAGS 里出现了 qq_recall' : '');

// ── 组二：描述红线 ────────────────────────────────────────────────────────
console.log('\n── 组二：工具描述（2–4 句，写清只读/同组/别每轮查） ──────');
// 从工具名切到 schema 的 `{`，只留描述字面量，避免把块内注释当成描述来断言。
const recallDesc = sliceBetween(mcp, "'qq_recall',", '\n    {').trim().replace(/^'qq_recall',\s*/, '');
check('能切出 qq_recall 的描述字面量', recallDesc.startsWith("'只读回忆"), recallDesc.slice(0, 60));
check('描述含「同组」', recallDesc.includes('同组'));
check('描述含「不要每轮」', recallDesc.includes('不要每轮'));
check('描述含「只读」', recallDesc.includes('只读'));
check('描述说明返回逐条消息与出处', recallDesc.includes('逐条') && recallDesc.includes('出处'));
check('描述写「查不到就直说没找到」', recallDesc.includes('查不到就直说没找到'));
check('描述写「没给记录就别猜」', recallDesc.includes('别猜'));
const descSentences = recallDesc.split('。').map((s) => s.trim()).filter(Boolean).length;
check('描述是 2–4 句', descSentences >= 2 && descSentences <= 4, `实际 ${descSentences} 句`);
// 描述每轮都进 system prompt，除「私聊/群聊」外的敏感词一律不该出现。
const BANNED = ['密码', '密钥', '身份证', '手机号', '管理员', '绕过', 'token 明文'];
check('描述不含敏感词', BANNED.every((word) => !recallDesc.includes(word)),
  BANNED.filter((word) => recallDesc.includes(word)).join(' / '));

// ── 组三：入参名字与类型 ──────────────────────────────────────────────────
console.log('\n── 组三：六个入参的名字与类型 ─────────────────────────────');
const recallSchema = sliceBetween(mcp, "'qq_recall',", '\n    },\n    async (');
check('token 是可选 string（桥接要求会话令牌）', recallSchema.includes('token: z.string().optional()'));
check('key 是必填 string（group:群号 / private:QQ号）',
  recallSchema.includes('key: z.string().describe(') && !recallSchema.includes('key: z.string().optional()'));
check('query 是可选 string（关键词）', recallSchema.includes('query: z.string().optional()'));
check('person 是可选 string（QQ 号或名字）', recallSchema.includes('person: z.string().optional()'));
check('hours 是可选 number（默认 24 / 1–168）',
  recallSchema.includes('hours: z.number().optional()') && recallSchema.includes('默认 24')
  && recallSchema.includes('1–168'));
check('limit 是可选 number（默认 20 / 1–50）',
  recallSchema.includes('limit: z.number().optional()') && recallSchema.includes('默认 20')
  && recallSchema.includes('1–50'));
check('回调解构了全部六个参数',
  recallBlock.includes('async ({ token, key, query, person, hours, limit }) => {'));

// ── 组四：调用点（路径 / 方法 / body 字段 / 令牌头） ──────────────────────
console.log('\n── 组四：调用点 ───────────────────────────────────────────');
check('请求路径是 /api/socialV2/cross/recall',
  recallBlock.includes("agentApi('/api/socialV2/cross/recall', {"));
check('方法是 POST', recallBlock.includes("method: 'POST'"));
// 字段名必须与桥接 readBody 的口径一致：key/query/person/hours/limit（+ 可选 sinceMs/excludeSelf）。
check('body 以 key 为底（const payload = { key }）', recallBlock.includes('const payload = { key };'));
for (const field of ['query', 'person', 'hours', 'limit']) {
  check(`body 带 ${field} 字段`, recallBlock.includes(`payload.${field} =`));
}
check('body 用 JSON.stringify(payload)', recallBlock.includes('body: JSON.stringify(payload)'));
check('带 token 时头里有 x-agent-token',
  recallBlock.includes("headers: { 'x-agent-token': token }"));
check('token 只在真有时才进 header（不传不覆盖控制台令牌）',
  recallBlock.includes('...(token ? { headers:'));
// agentApi 的非 2xx 分支必须挂 status：429 分支靠它（或 reason=rate_limited）判定。
const agentApiBody = sliceBetween(mcp, 'async function agentApi(path, init = {}) {', '\nfunction agentApiLongPoll');
check('agentApi 非 2xx 分支挂 error.status（429 判定用）',
  agentApiBody.includes('error.status = res.status;'));

// ── 组五：三条文案分支 + 通用失败 ─────────────────────────────────────────
console.log('\n── 组五：返回文案 ─────────────────────────────────────────');
check('0 结果：原样输出桥接 hint「没有找到匹配记录，请不要推测。」',
  recallBlock.includes('没有找到匹配记录，请不要推测。'));
check('0 结果：补一句「没有和别的会话互通，或时间范围内没有相关记录」',
  recallBlock.includes('（当前会话没有和别的会话互通，或时间范围内没有相关记录。）'));
check('gid<=0 与 total===0 走同一条空结果分支（判据只看 gid/total）',
  recallBlock.includes('if (!(gid > 0) || !(total > 0))'));
check('有结果：先输出「已找到 N 条（来自互通组 <gid>）：」',
  recallBlock.includes('`已找到 ${total} 条（来自互通组 ${gid}）：`'));
check('有结果：逐行输出 lines（bridge 已格式化）',
  recallBlock.includes('Array.isArray(data?.lines)') && recallBlock.includes('...lines'));
check('有结果：最后附 bridge 的 hint', recallBlock.includes(', ...lines, hint].join'));
check('429 文案「查得太频繁了，约 N 秒后再试。」',
  recallBlock.includes('查得太频繁了，约 ${seconds} 秒后再试。'));
check('429 用 retryAfterMs 换算秒数', recallBlock.includes('Math.ceil(retry / 1000)'));
check('403 disabled 文案「跨渠道回忆没有开启。」',
  recallBlock.includes("if (reason === 'disabled')") && recallBlock.includes("text: '跨渠道回忆没有开启。'"));
check('其它错误文案「回忆失败：<message>」',
  recallBlock.includes('`回忆失败：${error?.message ?? error}${detail}`'));
check('其它错误一并带上 error.body.reason',
  recallBlock.includes('reason=${error.body.reason}'));

// ── 组六：桥接侧端点必须存在（工具不能对空气说话） ────────────────────────
console.log('\n── 组六：桥接端点与返回形状 ───────────────────────────────');
check("bridge 有 POST '/api/socialV2/cross/recall' 端点",
  bridge.includes("url.pathname === '/api/socialV2/cross/recall'"));
const recallEndpoint = sliceBetween(bridge, "url.pathname === '/api/socialV2/cross/recall'", '      return;\n        }\n');
check('端点返回 {ok,gid,total,rows,lines,hint}（工具依赖这些字段）',
  recallEndpoint.includes('gid,') && recallEndpoint.includes('total,')
  && recallEndpoint.includes('lines: formatRecallLines(rows)') && recallEndpoint.includes('hint:'));
check('端点 gid<=0 时 200 + total:0 + 「没有找到匹配记录，请不要推测。」',
  recallEndpoint.includes('total: 0') && recallEndpoint.includes('没有找到匹配记录，请不要推测。'));
check('端点 429 用 reason=rate_limited + retryAfterMs（工具据此算秒数）',
  recallEndpoint.includes("reason: 'rate_limited'") && recallEndpoint.includes('retryAfterMs'));
check('端点 disabled 时 403 + reason=disabled（工具据此回「没有开启」）',
  recallEndpoint.includes("reason: 'disabled'"));

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
