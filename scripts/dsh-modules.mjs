// 定位「DSH 安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 解析顺序：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（应指向 <DSH>/node_modules），显式覆盖直接用
//   2. 从 $DSH_HOME/profiles/<profile>/package.json 用 Node 模块解析反查真实安装位置
//      （profile 依次尝试 DSH_PROFILE、web、default，再兜底扫 profiles 下的其它目录）
//   3. 各平台的已知安装目录（…\Programs\DSH Desktop\resources\app\node_modules 等）
// 全部失败时抛出带指引的错误，不做任何写死路径的回退 —— 宁可显式报错，也不要静默用错版本。
//
// 为什么候选要过一道「是不是 DSH 运行时树」的检查
// ------------------------------------------------
// DSH Desktop 从 0.2.x 起把 dsh-* 包留在应用安装目录，profile 侧的 node_modules 只剩
// 插件带来的残留依赖（js-yaml、cosmokit、schemastery……）。从 profile 反查时 `js-yaml`
// 这条 specifier 会成功解析到那个**残缺**目录，于是 dshModulesDir() 返回一个
// `@deepseek-ai` 下只有 cosmokit/schemastery、一个 dsh-* 都没有的假答案：
//   · scan-dsh-tool-names 扫到 0 个包，把 59 个真实工具名全报成「假名」；
//   · verify-persona-config 找不到 @deepseek-ai/dsh-persona 而 ERR_MODULE_NOT_FOUND。
// 所以候选必须含至少一个 @deepseek-ai/dsh-* 包才算数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 这些脚本需要加载的包，任意一个能解析成功即可反推出 node_modules 位置。
const PROBE_SPECIFIERS = ['@deepseek-ai/dsh-persona', 'js-yaml'];

/** 判定一个目录是不是 DSH 运行时树：`@deepseek-ai` 下至少有一个 `dsh-*` 包。 */
export function looksLikeDshModules(dir) {
  if (!dir) return false;
  try {
    return fs.readdirSync(path.join(dir, '@deepseek-ai'), { withFileTypes: true })
      .some((entry) => entry.isDirectory() && entry.name.startsWith('dsh-'));
  } catch {
    return false;
  }
}

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function candidateProfiles(home) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

/** 各平台的已知安装布局（仅作 profile 反查落空后的兜底，不参与主判据）。 */
function knownInstallDirs() {
  const out = [];
  const push = (value) => { if (value) out.push(value); };
  const toModules = (...parts) => path.join(...parts, 'resources', 'app', 'node_modules');
  const localAppData = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
  const bases = [
    localAppData ? path.join(localAppData, 'Programs') : null,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ];
  for (const base of bases) {
    if (!base) continue;
    for (const app of ['DSH Desktop', 'DSH', 'dsh', 'DeepSeek Harness']) push(toModules(base, app));
  }
  if (process.platform === 'darwin') {
    push(toModules('/Applications', 'DSH Desktop.app', 'Contents'));
    push(toModules(path.join(os.homedir(), 'Applications'), 'DSH Desktop.app', 'Contents'));
  }
  if (process.platform === 'linux') {
    push('/opt/DSH/resources/app/node_modules');
    push('/usr/lib/dsh/resources/app/node_modules');
  }
  return out;
}

export function dshModulesDir() {
  const override = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (override) return override;

  const home = dshHome();
  const candidates = [];
  const seen = new Set();
  const add = (dir) => { if (dir && !seen.has(dir)) { seen.add(dir); candidates.push(dir); } };

  for (const profile of candidateProfiles(home)) {
    const anchor = path.join(home, 'profiles', profile, 'package.json');
    if (!fs.existsSync(anchor)) continue;
    const req = createRequire(anchor);
    for (const spec of PROBE_SPECIFIERS) {
      try { add(findNodeModules(req.resolve(spec))); } catch { /* 换下一个 specifier，再换下一个 profile */ }
    }
  }
  for (const dir of knownInstallDirs()) add(dir);

  const runtimeTree = candidates.find(looksLikeDshModules);
  if (runtimeTree) return runtimeTree;

  // 兼容 0.2.0 之前的布局（profile 里带整套 dsh-*）：反查结果本身仍是可用答案。
  // 只用于「连一个 dsh-* 都没有」的旧机器，加载 js-yaml 这类依赖的脚本照旧能跑。
  if (candidates.length) return candidates[0];

  throw new Error(
    '无法定位 DSH 安装目录下的 node_modules。\n'
    + '  请设置 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules 后重试；\n'
    + `  或设置 DSH_HOME 指向 DSH 根目录（当前解析为 ${home}）。`
  );
}
