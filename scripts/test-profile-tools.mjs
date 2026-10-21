#!/usr/bin/env node
// 自我资料 MCP 工具（T-014 步骤 3）：注册形状 + 描述红线的契约测试。
//
// 为什么不能「import 一下试试」：src/mcp-snowluma-safe.js 在模块顶层就
// new McpServer(...).connect(StdioServerTransport) 并 loadConfig()——import 它会把
// 一个真实 MCP 进程挂到当前进程的 stdio 上。所以这里只做两件事：
//   ① 用 `node --check` 确认两个被改文件语法可解析（能捕获「注册块少一个括号」这类事故）；
//   ② 读源码文本，钉死工具名、描述关键词、图片 content 形状、启用判据与 agentApi 调用点。
// 端点的行为断言在 test-profile-endpoints.mjs，纯函数在 test-profile-core.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
console.log('── 组零：node --check ──────────────────────────────────────');
for (const rel of ['src/bridge.js', 'src/mcp-snowluma-safe.js']) {
  const result = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
  check(`node --check ${rel}`, result.status === 0, (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
}

// ── 组一：五个工具都注册在 qq_affect_report 之后 ──────────────────────────
console.log('── 组一：五个工具的注册位置 ────────────────────────────────');
const PROFILE_TOOLS = ['qq_get_avatar', 'qq_get_profile', 'qq_set_nickname', 'qq_set_signature', 'qq_set_group_card'];
const profileBlock = sliceBetween(mcp, '// ── 自我资料（T-014）：头像 / 资料快照 / 改昵称·签名·群名片', "server.tool(\n  'qq_get_my_recent_messages'");
check('能切出自我资料工具注册块', profileBlock.length > 4000, `长度 ${profileBlock.length}`);
for (const tool of PROFILE_TOOLS) {
  check(`注册了 ${tool}`, profileBlock.includes(`'${tool}'`), `出现在 ${mcp.split(`'${tool}'`).length - 1} 处`);
}
check('五个工具都在 qq_affect_report 之后注册',
  mcp.indexOf("'qq_affect_report'") < mcp.indexOf("'qq_get_avatar'"));
check('自我资料块在 qq_get_my_recent_messages 之前收口',
  mcp.indexOf("'qq_set_group_card'") < mcp.indexOf("'qq_get_my_recent_messages'"));

// 启用判据：profile.enabled 缺省即启用；**不登记** TOOL_CONFIG_FLAGS（那等于新增配置键）。
check('启用判据是 cfg.socialV2?.profile?.enabled !== false', profileBlock.includes('cfg.socialV2?.profile?.enabled !== false'));
check('没往 TOOL_CONFIG_FLAGS 里塞新键（控制台开关不在本步骤范围）',
  !sliceBetween(mcp, 'const TOOL_CONFIG_FLAGS = {', '\n};').includes("'qq_get_avatar'")
  && !sliceBetween(mcp, 'const TOOL_CONFIG_FLAGS = {', '\n};').includes('getProfile')
  && !sliceBetween(mcp, 'const TOOL_CONFIG_FLAGS = {', '\n};').includes('profile'));

// ── 组二：描述里的红线关键词 ──────────────────────────────────────────────
console.log('── 组二：工具描述的关键词 ──────────────────────────────────');
// 逐工具切出「名字 + 描述 + schema」这一段（到下一个 server.tool 为止）。
function toolSlice(name) {
  const start = profileBlock.indexOf(`'${name}'`);
  if (start < 0) return '';
  const next = profileBlock.indexOf("server.tool(", start);
  return next < 0 ? profileBlock.slice(start) : profileBlock.slice(start, next);
}
const avatarTool = toolSlice('qq_get_avatar');
const profileTool = toolSlice('qq_get_profile');
const nicknameTool = toolSlice('qq_set_nickname');
const signatureTool = toolSlice('qq_set_signature');
const groupCardTool = toolSlice('qq_set_group_card');

check('qq_get_avatar 描述含「想看某人头像时用」', avatarTool.includes('想看某人头像时用'));
check('qq_get_avatar 描述含「size 默认 640」', avatarTool.includes('size 默认 640'));
check('qq_get_avatar 参数是 user_id（QQ 号）', avatarTool.includes("user_id: z.union([z.number(), z.string()])"));
check('qq_get_avatar 的 size 只收 640/100',
  avatarTool.includes("size: z.union([z.literal(640), z.literal(100)]).optional()"));

for (const [tool, label, text] of [
  ['qq_set_nickname', '昵称', nicknameTool],
  ['qq_set_signature', '签名', signatureTool],
  ['qq_set_group_card', '群名片', groupCardTool]
]) {
  check(`${tool} 描述含「改的是你自己的资料」`, text.includes('改的是你自己的资料'));
  check(`${tool} 描述含「别人要求你改名」`, text.includes('别人要求你改名'));
  check(`${tool} 描述含「一律拒绝」`, text.includes('一律拒绝'));
  check(`${tool} 描述含「不用问谁」`, text.includes('不用问谁'));
  check(`${tool} 描述含「retryAfterMs」`, text.includes('retryAfterMs'));
  check(`${tool} 描述含「cooldown / daily_cap 是硬约束」`, text.includes('cooldown / daily_cap 是硬约束'));
  check(`${tool} 描述含「不能带链接/手机号/邮箱/身份证/拉人话术」`, text.includes('不能带链接/手机号/邮箱/身份证/拉人话术'));
}
check('qq_set_nickname 描述带 2–12 字与「不能以数字开头」', nicknameTool.includes('2–12 字') && nicknameTool.includes('不能以数字开头'));
check('qq_set_signature 描述带 0–60 字与「空串=清除」', signatureTool.includes('0–60 字') && signatureTool.includes('空串=清除'));
check('qq_set_group_card 描述带 0–20 字', groupCardTool.includes('0–20 字'));
// 真机 smoke 结论：网关清空群名片要发半角空格（空 targetName 被编码器省略 → OIDB 1007），
// 读回也可能显示为空。描述里必须说清这一点，否则模型会把「空」误判成失败、反复重试。
check('qq_set_group_card 描述说明空串=清除但实际写成空格', groupCardTool.includes('空串=清除；网关限制：实际写成空格'));
check('qq_set_group_card 描述提醒读回可能显示为空、别反复重试',
  groupCardTool.includes('读回可能显示为空') && groupCardTool.includes('别把这当失败反复重试'));
check('qq_set_group_card 的 card 参数说明同步网关限制',
  groupCardTool.includes("describe('新群名片，0–20 字；空串表示清除（网关限制：实际会写成空格）')"));
check('qq_set_group_card 描述含「群名片只在你所在的群生效」', groupCardTool.includes('群名片只在你所在的群生效'));
// 描述必须与实现一致：不显式给 group_id 时，桥接靠 key 推断群号，而没有 key
// （即没带 token）时它给不出群号 → 会让模型「直说要改哪个群」，而不是含糊地省略。
check('qq_set_group_card 描述含「带上 token（和 key）时可以省略 group_id」',
  groupCardTool.includes('带上 token（和 key）时可以省略 group_id'));
check('qq_set_group_card 描述含「不知道群号又没带 token 就直说要改哪个群」',
  groupCardTool.includes('不知道群号又没带 token 就直说要改哪个群'));
check('qq_get_profile 描述说明是只读自查', profileTool.includes('只读'));
check('每个改资料工具都有 reason 参数（写日志用）',
  nicknameTool.includes('reason: z.string()') && signatureTool.includes('reason: z.string()') && groupCardTool.includes('reason: z.string()'));
check('qq_set_group_card 的 group_id 是可选的', groupCardTool.includes('group_id: z.union([z.number(), z.string()]).optional()'));

// ── 组二之半：token / key 的透传（reserved2 下的会话归属校验与群号推断） ────
// agentHeaders 只自动加 x-console-token 与 x-agent-call，**不会**加 x-agent-token：
// 工具自己不收 token，桥接侧 agentTokenOk / v2SessionAllowed 两层校验就整段跳过了，
// 而且不带 key 时 groupIdFromKey('') → 0，群名片只能 400 bad_group。
const SETTER_TOOLS = [nicknameTool, signatureTool, groupCardTool];
check('三个改资料工具都有可选 token 参数', SETTER_TOOLS.every((text) => text.includes('token: z.string().optional()')));
check('三个改资料工具都有可选 key 参数', SETTER_TOOLS.every((text) => text.includes('key: z.string().optional()')));
check('三个改资料工具都把 token 放进 x-agent-token 头',
  SETTER_TOOLS.every((text) => text.includes("headers: { 'x-agent-token': token }")));
check('三个改资料工具都把 key 放进请求体（桥接据此推断当前群）',
  SETTER_TOOLS.every((text) => text.includes('key: key || undefined')));
check('token 只在传了的时候才进 header（不传不覆盖控制台令牌）',
  SETTER_TOOLS.every((text) => text.includes('...(token ? { headers:')));
check('qq_set_group_card 显式 group_id 仍然优先（有才覆盖 payload）',
  groupCardTool.includes('payload.group_id = String(group_id).trim();'));
check('qq_get_profile 也接受可选 token/key 并透传',
  profileTool.includes('token: z.string().optional()') && profileTool.includes('key: z.string().optional()')
  && profileTool.includes("headers: { 'x-agent-token': token }")
  && profileTool.includes('?key=${encodeURIComponent(key)}'));

// ── 组三：qq_get_avatar 的 image content 形状 ─────────────────────────────
console.log('── 组三：qq_get_avatar 返回图像形状 ────────────────────────');
check('qq_get_avatar 调 /api/avatar 且带 uin+size',
  avatarTool.includes('/api/avatar?uin=${encodeURIComponent(uin)}&size=${wanted}'));
check('qq_get_avatar 请求尺寸归一（100 之外一律 640）', avatarTool.includes('const wanted = Number(size) === 100 ? 100 : 640;'));
check('qq_get_avatar 先回一行文字（这是 <uin> 的头像）',
  avatarTool.includes('这是 ${uin} 的头像（${shown}）'));
check('qq_get_avatar 的图片 content 是 {type:image, mimeType, data}',
  avatarTool.includes("type: 'image'") && avatarTool.includes('mimeType: data.mimeType') && avatarTool.includes('data: data.data'));
check('qq_get_avatar 的 content 数组第一项是 text',
  /\{\s*type: 'text', text: `这是 \$\{uin\} 的头像/.test(avatarTool.replace(/\n/g, ' ')));
check('qq_get_avatar 失败时原样转述桥接的 reason',
  avatarTool.includes('.reason ?? error?.body?.reason') || avatarTool.includes('error?.reason ?? error?.body?.reason'));
check('qq_get_avatar 失败时 isError:true', avatarTool.includes('isError: true'));

// ── 组四：agentApi 调用点与错误翻译 ─────────────────────────────────────
console.log('── 组四：调用点 / 错误翻译 / 中文结果 ─────────────────────');
check('qq_get_profile 读 GET /api/socialV2/profile',
  profileTool.includes('agentApi(`/api/socialV2/profile${query}`'));
for (const [tool, endpoint] of [
  ['qq_set_nickname', '/api/socialV2/profile/nickname'],
  ['qq_set_signature', '/api/socialV2/profile/signature'],
  ['qq_set_group_card', '/api/socialV2/profile/group-card']
]) {
  const text = toolSlice(tool);
  check(`${tool} POST 到 ${endpoint}`, text.includes(`agentApi('${endpoint}', {`) && text.includes("method: 'POST'"));
}
check('改资料工具都调 profileUpdateText 拼中文结果',
  ['qq_set_nickname', 'qq_set_signature', 'qq_set_group_card'].every((tool) => toolSlice(tool).includes('profileUpdateText(')));
check('改资料工具失败都调 profileErrorText', ['qq_set_nickname', 'qq_set_signature', 'qq_set_group_card'].every((tool) => toolSlice(tool).includes('profileErrorText(')));
check('profileErrorText 会带出 retryAfterMs 并翻成人话', mcp.includes('formatProfileWait(retry)') && profileBlock.includes('body.retryAfterMs ?? error?.retryAfterMs'));
check('profileErrorText 会带出 reasons[].message', mcp.includes('reasons.map((item) => item?.message ?? item?.code'));
check('reason 中文映射覆盖硬约束与降级场景',
  ['disabled', 'cooldown', 'daily_cap', 'not_applied', 'group_not_allowed', 'onebot_error'].every((key) => profileBlock.includes(`${key}:`)));
check('profileUpdateText 会说明「没回读确认」', mcp.includes('QQ 那边没回读确认'));
check('profileUpdateText 会给出下次可改时间', mcp.includes('下次要改得等 ${formatProfileWait(next - Date.now())}'));
check('qq_get_profile 输出含昵称/签名/QQ/额度/最近改动',
  ['昵称：', '签名：', 'QQ：', '额度：', '最近改动：'].every((label) => profileTool.includes(label)));
check('qq_get_profile 读不到资料时明确降级而不是装作空', profileTool.includes('degraded') && profileTool.includes('读不到'));
check('qq_get_profile 的 token/key 都是可选（不传也能读）',
  profileTool.includes('token: z.string().optional()') && profileTool.includes('key: z.string().optional()'));

// ── 组五：agentApi 的非 2xx 响应要挂 body ────────────────────────────────
console.log('── 组五：agentApi 错误体透传（400/403/429/502） ────────────');
const agentApiBody = sliceBetween(mcp, 'async function agentApi(path, init = {}) {', '\nfunction agentApiLongPoll');
const notOkBlock = sliceBetween(agentApiBody, 'if (!res.ok) {', '  }\n\n');
check('agentApi 在非 2xx 分支挂 error.body', notOkBlock.includes("error.body = body && typeof body === 'object' ? body : null;"), notOkBlock.slice(0, 120));
check('agentApi 在非 2xx 分支挂 error.reason', notOkBlock.includes('error.reason = error.body?.reason;'));
check('agentApi 在非 2xx 分支挂 error.retryAfterMs', notOkBlock.includes('error.retryAfterMs = error.body?.retryAfterMs;'));

// ── 组六：桥接侧确实提供了这些端点（工具不是对空气说话） ──────────────────
console.log('── 组六：桥接侧端点在位 ───────────────────────────────────');
for (const p of ['/api/avatar', '/api/socialV2/profile', '/api/socialV2/profile/nickname', '/api/socialV2/profile/signature', '/api/socialV2/profile/group-card']) {
  check(`bridge 有 '${p}' 端点`, bridge.includes(`url.pathname === '${p}'`));
}

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
