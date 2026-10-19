#!/usr/bin/env node
/**
 * 打印 config.json 里的一个点号路径（给 .cmd / .ps1 启动脚本用）。
 *
 * 为什么需要它：启动脚本必须知道 SnowLuma 装在哪（config.json 的 `snowluma.homeDir`）。
 * 把「<盘符>:\SnowLuma」写死进 .cmd 有两个真实代价：
 *   1. 仓库克隆到别的盘/别的机器就跑不起来，而 homeDir 本来就在配置里；
 *   2. `scripts/privacy-scan.mjs` 会把"非系统盘的顶层绝对路径"判为泄漏，闸门永远是红的。
 *
 * 用法：
 *   node scripts/print-config.mjs snowluma.homeDir      # 打印值
 *   node scripts/print-config.mjs dsh.profile --default web
 *
 * 退出码：0=找到；1=config.json 缺失/解析失败/路径不存在或为空；2=用法错误。
 * 注意：只读，绝不改写 config.json（写操作只属于桥接自身的持久化逻辑）。
 *
 * .cmd 里的典型用法（`2^>nul` 把错误提示让给 exit code，避免污染 for 的输出）：
 *   for /f "usebackq delims=" %%i in (`node "%~dp0scripts\print-config.mjs" snowluma.homeDir 2^>nul`) do set "SNOWLUMA_DIR=%%i"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const argv = process.argv.slice(2);
const usage = () => console.error('用法: node scripts/print-config.mjs <点号路径，如 snowluma.homeDir> [--default <值>]');

let key = '';
let fallback = '';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--default') { fallback = argv[i + 1] ?? ''; i += 1; continue; }
  if (!key) key = argv[i];
}
if (!key) { usage(); process.exit(2); }

function fail(message) {
  if (fallback !== '') {
    // 调用方显式给了兜底值：照常输出，退出码仍为 0，让 .cmd 能继续走。
    console.log(fallback);
    process.exit(0);
  }
  console.error(`[print-config] ${message}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
} catch (error) {
  fail(`读不到或解析不了 config.json（${CONFIG_FILE}）：${error?.message ?? error}`);
}

let cur = cfg;
for (const part of key.split('.')) {
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(part in cur)) {
    fail(`config.json 里没有 ${key}（断在「${part}」）`);
  }
  cur = cur[part];
}

if (cur === null || cur === undefined || cur === '') fail(`config.json 的 ${key} 是空的`);
// 对象/数组用一行 JSON 输出，标量直接输出——启动脚本只应该取标量，这里只是不崩。
console.log(typeof cur === 'object' ? JSON.stringify(cur) : String(cur));
