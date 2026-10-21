#!/usr/bin/env node
// 生图 / 发图 / 存表情 / 换头像 MCP 工具（T-017 步骤 4）：注册形状 + 描述红线 +
// 端点契约 + 错误码映射的静态测试。
//
// 为什么不能「import 一下试试」：src/mcp-snowluma-safe.js 在模块顶层就
// new McpServer(...).connect(StdioServerTransport) 并 loadConfig()——import 它会把
// 一个真实 MCP 进程挂到当前进程的 stdio 上。所以这里只做两件事：
//   ① 用 `node --check` 确认被改文件语法可解析（能捕获「注册块少一个括号」这类事故）；
//   ② 读源码文本，钉死工具名、描述关键词、图片 content 形状、取图请求的令牌头、
//      启用判据与 403/429/502 的映射分支。
// 端点的行为断言在 test-image-endpoints.mjs（由桥接侧那一半负责），纯函数在
// test-image-core.mjs。本脚本不联网、不起进程、不读 config.json。
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

const MCP_REL = 'src/mcp-snowluma-safe.js';
const mcp = read(MCP_REL);

// ── 组零：被改文件语法可解析（含本文件自己） ────────────────────────────────
console.log('── 组零：node --check ──────────────────────────────────────');
for (const rel of [MCP_REL, 'scripts/test-image-tools.mjs']) {
  const result = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
  check(`node --check ${rel}`, result.status === 0, (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
}
check('没有为生图引入新依赖（不 import sharp/axios/undici）',
  !/from '(sharp|axios|undici|node-fetch)'/.test(mcp));

// ── 组一：四个工具的注册位置 ────────────────────────────────────────────────
console.log('── 组一：四个工具的注册位置 ────────────────────────────────');
const imageBlock = sliceBetween(mcp, '// ── 生图 / 发图 / 存表情 / 换头像（T-017）', '// ── 合并转发消息查看工具');
check('能切出生图工具注册块', imageBlock.length > 8000, `长度 ${imageBlock.length}`);
const IMAGE_TOOLS = ['qq_draw_image', 'qq_send_image', 'qq_save_sticker', 'qq_set_avatar'];
for (const tool of IMAGE_TOOLS) {
  check(`注册了 ${tool}`, imageBlock.includes(`'${tool}'`), `出现在 ${mcp.split(`'${tool}'`).length - 1} 处`);
}
check('生图块里正好 4 个 server.tool( 注册点',
  (imageBlock.match(/server\.tool\(/g) ?? []).length === 4,
  `实际 ${(imageBlock.match(/server\.tool\(/g) ?? []).length} 个`);
check('生图块在 qq_set_sticker_remark 之后（紧跟表情工具）',
  mcp.indexOf("'qq_set_sticker_remark'") > 0 && mcp.indexOf("'qq_set_sticker_remark'") < mcp.indexOf('// ── 生图 / 发图 / 存表情 / 换头像'));
check('生图块在合并转发工具之前收口',
  mcp.indexOf("server.tool(\n  'qq_draw_image'") > 0
  && mcp.indexOf("server.tool(\n  'qq_draw_image'") < mcp.indexOf('// ── 合并转发消息查看工具'));
check('四个工具都排在 qq_send_sticker 之后（同一片图片/表情区域）',
  mcp.indexOf("'qq_send_sticker'") < mcp.indexOf('// ── 生图 / 发图 / 存表情 / 换头像'));

// 逐工具切出「名字 + 描述 + schema」这一段（到下一个 server.tool 为止）。
function toolSlice(name) {
  const start = imageBlock.indexOf(`'${name}'`);
  if (start < 0) return '';
  const next = imageBlock.indexOf('server.tool(', start);
  return next < 0 ? imageBlock.slice(start) : imageBlock.slice(start, next);
}
const drawTool = toolSlice('qq_draw_image');
const sendTool = toolSlice('qq_send_image');
const saveTool = toolSlice('qq_save_sticker');
const avatarTool = toolSlice('qq_set_avatar');
check('四个工具都能切出各自的注册段', [drawTool, sendTool, saveTool, avatarTool].every((text) => text.length > 300),
  [drawTool.length, sendTool.length, saveTool.length, avatarTool.length].join('/'));

// ── 组二：qq_draw_image 描述里的红线（模型每次调用前都会读到这一层） ──────────
console.log('── 组二：qq_draw_image 描述红线 ────────────────────────────');
check('描述含「画的是你自己的图，不是别人的照片」', drawTool.includes('画的是你自己的图，不是别人的照片'));
check('描述含「不要用它伪造真人照片」', drawTool.includes('不要用它伪造真人照片'));
check('描述含「不要为了刷图反复调用」', drawTool.includes('不要为了刷图反复调用'));
check('描述含「每 45 秒才能出一张，24 小时 20 张」', drawTool.includes('每 45 秒才能出一张，24 小时 20 张'));
check('prompt 的 describe 是「想画什么，中文或英文都行，3~300 字」',
  drawTool.includes("describe('想画什么，中文或英文都行，3~300 字；不要描述真人照片')"));
check('描述提醒「不要描述真人照片」', drawTool.includes('不要描述真人照片'));
check('width / height / seed 都是可选整数',
  drawTool.includes('width: z.number().int().optional()')
  && drawTool.includes('height: z.number().int().optional()')
  && drawTool.includes('seed: z.number().int().optional()'));
check('send / save_sticker 都是可选 boolean 且写明默认 false',
  drawTool.includes('send: z.boolean().optional()') && drawTool.includes('save_sticker: z.boolean().optional()')
  && drawTool.includes('默认 false'));
check('描述告诉模型画完可以发（qq_send_image）', drawTool.includes('qq_send_image'));
check('描述告诉模型画完可以存表情（qq_save_sticker）', drawTool.includes('qq_save_sticker'));
check('描述要求按 reason / retryAfterMs 处理、别换 prompt 硬试',
  drawTool.includes('retryAfterMs') && drawTool.includes('别换个 prompt 硬试'));

// ── 组三：画图 → 取图 → 返回图像内容 ────────────────────────────────────────
console.log('── 组三：生成 / 取图 / 图像 content ───────────────────────');
check('QQ 画图走 POST /api/socialV2/images/generate',
  drawTool.includes("agentApi('/api/socialV2/images/generate', {") && drawTool.includes("method: 'POST'"));
check('生成请求体只放 prompt/width/height/seed',
  drawTool.includes('const payload = { prompt: wantedPrompt };')
  && drawTool.includes("[['width', width], ['height', height], ['seed', seed]]"));
check('取图走 GET /api/images/generated/<id>',
  drawTool.includes('`/api/images/generated/${encodeURIComponent(imageId)}`'));
{
  const at = drawTool.indexOf('`/api/images/generated/${encodeURIComponent(imageId)}`');
  // 取图那一步的窗口要往前带一点：`await agentApi(` 在路径**之前**。
  const around = at < 0 ? '' : drawTool.slice(Math.max(0, at - 200), at + 400);
  // 取图必须自己补 x-agent-token：agentHeaders 只加控制台令牌与 x-agent-call，
  // 漏了它就是「以管理端身份取图」（confused deputy）。
  check('取图请求带自己补的 x-agent-token 头', around.includes("'x-agent-token': token"), around.slice(0, 160));
  check('取图走 agentApi 的 JSON 通道（不是裸 fetch 取二进制）',
    around.includes('agentApi(') && !around.includes('arrayBuffer') && !around.includes('fetch('));
}
check('图片以 {type:image, mimeType, data} 作为 content 返回',
  drawTool.includes("type: 'image'") && drawTool.includes('mimeType: mimeType ||') && drawTool.includes('data: base64'));
check('content 首项是 text、图像追加在后面',
  drawTool.indexOf("const content = [{ type: 'text'") > 0
  && drawTool.indexOf("const content = [{ type: 'text'") < drawTool.indexOf("content.push({ type: 'image'"));
check('文本里给出 imageId', drawTool.includes('imageId=${imageId}'));
check('文本里给出尺寸与字节数', drawTool.includes('${sizeText}') && drawTool.includes('字节'));
check('文本里给出耗时（dev-doc §六 要求的 imageId/尺寸/耗时/来源）',
  drawTool.includes('用时 ${(elapsedMs / 1000).toFixed(1)} 秒'));
check('文本里原样带出桥接给的来源（不写死 pollinations）',
  drawTool.includes('image.source') && drawTool.includes('来源 ${sourceText}'));
check('取图失败时仍保留 imageId（提示不用重画）', drawTool.includes('imageId 仍然能发、能存，不用重画'));
check('字节数缺失时按 base64 长度估算', drawTool.includes('Math.floor((base64.length * 3) / 4)'));

// ── 组四：send / save_sticker 两个附加动作 ─────────────────────────────────
console.log('── 组四：附加动作（发到会话 / 存表情） ─────────────────────');
check('send=true 调 POST /api/send/image',
  drawTool.includes("agentApi('/api/send/image', {") && drawTool.includes('JSON.stringify({ key: sessionKey, imageId })'));
check('没带 key 时说明「图已生成但没发」', drawTool.includes('没带会话 key，图已生成但没发'));
check('发图失败只在文本补一句、不影响图片返回', drawTool.includes('图本身没问题，只是没发出去'));
check('save_sticker=true 调 POST /api/socialV2/images/sticker',
  drawTool.includes("agentApi('/api/socialV2/images/sticker', {"));
check('存表情失败只在文本补一句、不影响图片返回', drawTool.includes('图本身没问题，只是没存成'));
check('存表情成功文案带 emoji_id 并指向 qq_send_sticker',
  drawTool.includes('emoji_id=${emojiId}') && drawTool.includes('以后可以用 qq_send_sticker 发它'));

// ── 组五：qq_send_image ────────────────────────────────────────────────────
console.log('── 组五：qq_send_image ────────────────────────────────────');
check('qq_send_image 描述含「一次一张」', sendTool.includes('一次一张'));
check('qq_send_image 描述要求按 retryAfterMs 等、别连续重试',
  sendTool.includes('retryAfterMs') && sendTool.includes('别连续重试'));
check('qq_send_image POST /api/send/image 带 {key, imageId}',
  sendTool.includes("agentApi('/api/send/image', {")
  && sendTool.includes('JSON.stringify({ key: sessionKey, imageId: id })'));
check('qq_send_image 成功文案是「已发出（message_id=…）」', sendTool.includes('已发出（message_id=${messageId}）'));
check('qq_send_image 缺 key 时给可执行的说明', sendTool.includes('发图需要当前会话 key（如 group:123456），这次没带'));
check('qq_send_image 缺 imageId 时给可执行的说明', sendTool.includes('缺 imageId：把 qq_draw_image 返回的那个 imageId 传过来'));
check('qq_send_image 的 token / key 都是可选透传',
  sendTool.includes('token: z.string().optional()') && sendTool.includes('key: z.string().optional()'));
check('qq_send_image 的 token 进 x-agent-token 头', sendTool.includes("headers: token ? { 'x-agent-token': token } : {}"));

// ── 组六：qq_save_sticker ─────────────────────────────────────────────────
console.log('── 组六：qq_save_sticker ──────────────────────────────────');
check('qq_save_sticker 描述含 emoji_id', saveTool.includes('emoji_id'));
check('qq_save_sticker 描述指向 qq_send_sticker', saveTool.includes('qq_send_sticker'));
check('qq_save_sticker 描述写明备注 ≤12 字', saveTool.includes('≤12 字'));
check('qq_save_sticker 描述写明额度（24 小时 5 个）', saveTool.includes('24 小时最多 5 个'));
check('qq_save_sticker POST /api/socialV2/images/sticker', saveTool.includes("agentApi('/api/socialV2/images/sticker', {"));
check('qq_save_sticker 成功文案带 emoji_id', saveTool.includes('已存成收藏表情（emoji_id=${emojiId}）'));
check('qq_save_sticker 在本地先拦超长备注（>12 字不打端点）',
  saveTool.includes('Array.from(remark).length > 12') && saveTool.includes('备注最多 12 字'));
check('qq_save_sticker 只有 desc 时才把备注发给桥接',
  saveTool.includes("JSON.stringify(remark ? { imageId: id, desc: remark } : { imageId: id })"));

// ── 组七：qq_set_avatar ──────────────────────────────────────────────────
console.log('── 组七：qq_set_avatar ────────────────────────────────────');
check('qq_set_avatar 描述含「24 小时最多 1 次」', avatarTool.includes('24 小时最多 1 次'));
check('qq_set_avatar 描述含「两次之间至少 6 小时」', avatarTool.includes('两次之间至少 6 小时'));
check('qq_set_avatar 描述含白名单域名 q1.qlogo.cn', avatarTool.includes('https://q1.qlogo.cn/'));
check('qq_set_avatar 描述含白名单域名 image.pollinations.ai', avatarTool.includes('https://image.pollinations.ai/'));
check('qq_set_avatar 描述写明二选一', avatarTool.includes('二选一'));
check('qq_set_avatar 描述说明没有读回校验', avatarTool.includes('没有读回校验'));
check('qq_set_avatar POST /api/socialV2/profile/avatar', avatarTool.includes("agentApi('/api/socialV2/profile/avatar', {"));
check('qq_set_avatar 成功文案是「头像已更新」', avatarTool.includes("text: '头像已更新。'"));
check('qq_set_avatar 本地校验 URL 白名单（isAllowedAvatarUrl）', avatarTool.includes('if (!isAllowedAvatarUrl(rawUrl))'));
check('qq_set_avatar 收到 429 时原样转述服务端文案',
  avatarTool.includes('Number(error?.status) === 429') && avatarTool.includes('头像没换成：${message}'));
check('qq_set_avatar 两个参数都没给时早退', avatarTool.includes('要么给 imageId，要么给 url（二选一）'));
check('qq_set_avatar 两个参数都给了时早退', avatarTool.includes('imageId 和 url 只给一个'));

// ── 组八：URL 白名单工具函数 ───────────────────────────────────────────────
console.log('── 组八：URL 白名单校验 ───────────────────────────────────');
check('定义了 AVATAR_URL_PREFIXES 白名单常量', imageBlock.includes('const AVATAR_URL_PREFIXES ='));
check('白名单只有 q1.qlogo.cn 与 image.pollinations.ai 两个前缀',
  imageBlock.includes("['https://q1.qlogo.cn/', 'https://image.pollinations.ai/']"));
check('白名单前缀以 / 收尾（挡住 q1.qlogo.cn.evil.com 这类后缀伪装）',
  imageBlock.includes("'https://q1.qlogo.cn/'") && imageBlock.includes("'https://image.pollinations.ai/'"));
check('isAllowedAvatarUrl 还校验协议是 https',
  imageBlock.includes('function isAllowedAvatarUrl(raw)')
  && imageBlock.includes("new URL(url).protocol === 'https:'"));
check('isAllowedAvatarUrl 对非法 URL 返回 false 而不是抛异常', imageBlock.includes('} catch {\n    return false;\n  }'));

// ── 组九：启用判据与「不登记 TOOL_CONFIG_FLAGS」 ──────────────────────────
console.log('── 组九：启用判据 / 不登记配置开关 ────────────────────────');
check('启用判据是 cfg?.socialV2?.images?.enabled !== false',
  mcp.includes('const imagesEnabled = () => cfg?.socialV2?.images?.enabled !== false;'));
check('判据缺省即启用（!== false，不是 === true）', imageBlock.includes('imagesEnabled = () => cfg?.socialV2?.images?.enabled !== false'));
check('关掉时返回「当前没有开启生图功能，不要重试」', imageBlock.includes('当前没有开启生图功能，不要重试'));
check('四个工具都在回调开头判开关', (imageBlock.match(/if \(!imagesEnabled\(\)\) \{/g) ?? []).length === 4,
  `实际 ${(imageBlock.match(/if \(!imagesEnabled\(\)\) \{/g) ?? []).length} 处`);
// 只停生图（2026-10-21）：draw 的闸门里再叠一层 generateEnabled，其余三个工具不受影响。
check('generateEnabled 判据独立且叠在 imagesEnabled 之上',
  imageBlock.includes('const generateEnabled = () => imagesEnabled() && cfg?.socialV2?.images?.generateEnabled !== false;'));
check('只有 qq_draw_image 回调判 generateEnabled（其余三个工具不被连带关掉）',
  (imageBlock.match(/if \(!generateEnabled\(\)\) \{/g) ?? []).length === 1,
  `实际 ${(imageBlock.match(/if \(!generateEnabled\(\)\) \{/g) ?? []).length} 处`);
check('停生图时明说「别重试、用现成图片」', imageBlock.includes('生图渠道暂时停用了') && imageBlock.includes('别重试'));
{
  const flags = sliceBetween(mcp, 'const TOOL_CONFIG_FLAGS = {', '\n};');
  check('能切出 TOOL_CONFIG_FLAGS 表', flags.length > 500, `长度 ${flags.length}`);
  for (const tool of IMAGE_TOOLS) {
    check(`TOOL_CONFIG_FLAGS 里没有 ${tool}`, !flags.includes(`'${tool}'`));
  }
  // 只认「行首的键」：qq_get_message_images 的值是 'getImages'，直接用 includes('images:')
  // 会被这个已有键名误伤。
  check('TOOL_CONFIG_FLAGS 里没有 images 键（不新增控制台开关）', !/^\s+images:/m.test(flags),
    (flags.match(/^\s+images:.*$/m) ?? [''])[0]);
}
check('注释写清为什么不登记 TOOL_CONFIG_FLAGS', imageBlock.includes('不登记'));
check('注释写清为什么在回调里判开关（而不是整块 if 掉）', imageBlock.includes('enabledTools'));

// ── 组十：错误码映射（403 / 429 / 502） ────────────────────────────────────
console.log('── 组十：错误码映射 ──────────────────────────────────────');
check('定义了 describeImageFailure 错误翻译函数', imageBlock.includes('function describeImageFailure(action, error)'));
check('403 分支存在', imageBlock.includes('if (status === 403)'));
check('403 映射「没启用」', imageBlock.includes("reason === 'disabled'") && imageBlock.includes('当前没有开启生图功能（socialV2.images.enabled=false）'));
check('403 映射「会话不被允许」', imageBlock.includes("reason === 'session_not_allowed'") && imageBlock.includes('当前模式不允许操作这个会话'));
check('403 映射「会话令牌无效」', imageBlock.includes("reason === 'bad_token'"));
check('429 分支存在', imageBlock.includes('if (status === 429)'));
check('429 映射 too_frequent（两次之间要等 N 秒）',
  imageBlock.includes("reason === 'too_frequent'") && imageBlock.includes('两次之间隔得太近'));
check('429 映射 window_cap（24 小时额度用完）',
  imageBlock.includes("reason === 'window_cap'") && imageBlock.includes('24 小时额度用完了'));
check('429 映射 rate_limited（上游 45 秒限制）',
  imageBlock.includes("reason === 'rate_limited'") && imageBlock.includes('上游 45 秒只出一张'));
check('502 映射「上游出图失败，稍后再试」', imageBlock.includes('if (status === 502)') && imageBlock.includes('上游出图失败，稍后再试'));
check('400 分支提示按提示改参数', imageBlock.includes('if (status === 400)') && imageBlock.includes('按提示改参数，别原样重发'));
check('等待时长翻成人话：formatImageWait', imageBlock.includes('function formatImageWait(ms)'));
check('短等待按秒说（45 秒不会被说成「不到 1 分钟」）',
  imageBlock.includes('if (seconds <= 90) return `${Math.max(1, seconds)} 秒`'));
check('长等待复用 formatProfileWait（不另造一套小时/天口径）', imageBlock.includes('return formatProfileWait(total);'));
check('每次都把 retryAfterMs 读出来（body 与 error 两处都认）',
  imageBlock.includes('body.retryAfterMs ?? error?.retryAfterMs'));

console.log(`\n结果：${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const name of failures) console.log(`  - ${name}`);
  process.exitCode = 1;
}
