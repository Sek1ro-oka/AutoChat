// B站只读 MCP server（src/mcp-bili-safe.js）自测：
//   1) stdio 拉起，列工具（应为 3 个只读工具）
//   2) 搜索真的有结果、BV 号格式正确
//   3) 视频详情能拿到标题 + 字幕字段
//   4) 非 B站 链接被拒绝
//   5) 乱七八糟的 target 被拒绝
//   6) 热门列表可用
// 需要本机装了 bili-cli；没装时第 2~6 项会失败，属于环境问题。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

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

const transport = new StdioClientTransport({ command: NODE, args: [path.join(ROOT, 'src', 'mcp-bili-safe.js')], cwd: ROOT, stderr: 'pipe' });
const client = new Client({ name: 'bili-safe-selftest', version: '0.0.0' });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ...parse(result), isError: result?.isError === true };
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('工具列表', names.join(',') === 'bili_hot,bili_search,bili_video', names.join(','));

  const search = await call('bili_search', { keyword: '暗区突围', limit: 3 });
  const videos = Array.isArray(search.json?.videos) ? search.json.videos : [];
  check('搜索有结果且 BV 号合法', !search.isError && videos.length > 0 && videos.every((v) => /^BV[0-9A-Za-z]{10}$/.test(v.bvid || '')), `count=${videos.length}`);

  const bvid = videos[0]?.bvid;
  if (bvid) {
    const detail = await call('bili_video', { target: bvid, with_subtitle: true });
    check('视频详情可读', !detail.isError && typeof detail.json?.title === 'string' && detail.json.title.length > 0, detail.json?.title ?? detail.text.slice(0, 80));
    check('字幕字段结构正确', detail.json?.subtitle && typeof detail.json.subtitle.available === 'boolean' && typeof detail.json.subtitle.text === 'string', `available=${detail.json?.subtitle?.available} chars=${detail.json?.subtitle?.chars}`);
  } else {
    check('视频详情可读', false, '搜索没拿到 BV 号');
    check('字幕字段结构正确', false, '跳过');
  }

  const badDomain = await call('bili_video', { target: 'https://example.com/video/BV1GJ411x7h7' });
  check('非 B站 域名被拒绝', badDomain.isError === true, badDomain.text.slice(0, 70));

  const junk = await call('bili_video', { target: 'rm -rf /' });
  check('非法 target 被拒绝', junk.isError === true, junk.text.slice(0, 70));

  const hot = await call('bili_hot', { limit: 3 });
  check('热门列表可用', !hot.isError && Array.isArray(hot.json?.videos) && hot.json.videos.length > 0, `count=${hot.json?.count}`);

  // 字幕兜底：这个视频有 B站 AI 字幕（ai-zh），bili-cli 拿不到时应该由 opencli 补上。
  // 依赖浏览器里已登录的 B站 会话；浏览器桥没起来时会失败，属于环境问题。
  const withSub = await call('bili_video', { target: 'BV1G5po6zECY', with_subtitle: true });
  const subOk = withSub.json?.subtitle?.available === true && String(withSub.json?.subtitle?.text ?? '').length > 20;
  check('字幕可读（bili 或 opencli 兜底）', subOk, `source=${withSub.json?.subtitle?.source} chars=${withSub.json?.subtitle?.chars}`);
} catch (error) {
  console.log(`❌ 自测异常：${error?.message ?? error}`);
  failures += 1;
} finally {
  try { await client.close(); } catch {}
}

console.log(failures === 0 ? '\nB站只读工具自测全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
