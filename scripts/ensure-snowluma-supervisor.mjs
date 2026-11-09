#!/usr/bin/env node
/**
 * SnowLuma supervisor 的「看门人的看门人」。
 *
 * 为什么需要它：`snowluma-supervisor.mjs` 能看住 SnowLuma（探 3001、死了就按 launcher.bat 拉起），
 * 但它自己也会被杀（2026-11-05 DSH 那半边就是 supervisor 跟着宿主进程树一起消失）。
 * Windows 任务计划对「进程被外部杀掉」不触发 RestartOnFailure（实测：Stop-Process 后任务直接
 * 变 Ready，不再重跑），所以另起一个每 2 分钟跑一次的定时任务，只做一件事：
 * supervisor 的 pid 不在 → 让任务计划把「AutoChat SnowLuma supervisor」重新拉起来。
 *
 * 注意用 `schtasks /Run` 而不是自己 spawn：直接 spawn 出来的子进程会落在本任务的作业对象里，
 * 任务实例结束时可能被一起收走；转交给任务计划才是干净的重启。
 *
 * 安静是硬要求：活着的时候一行日志都不写，只有「发现 supervisor 不在了、并且去拉它」时记一条。
 * 存在 state/snowluma-supervisor.pause 时什么也不做（那是操作者明确要求停掉守护）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PID_FILE = path.join(ROOT, 'state', 'snowluma-supervisor.pid');
const PAUSE_FILE = path.join(ROOT, 'state', 'snowluma-supervisor.pause');
const LOG_FILE = path.join(ROOT, 'logs', 'snowluma-supervisor-keeper.log');
const TASK_NAME = 'AutoChat SnowLuma supervisor';

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch { return 0; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (fs.existsSync(PAUSE_FILE)) process.exit(0);

const pid = readPid();
if (pid && alive(pid)) process.exit(0);

const why = pid ? `supervisor pid=${pid} 已不在` : 'state/snowluma-supervisor.pid 缺失或为空';
try {
  // 不要回显 schtasks 的 stdout：它按控制台代码页输出（中文机器上是 GBK），
  // 直接写进 UTF-8 日志就是乱码。这里只关心「有没有让任务计划接单」。
  execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], {
    stdio: 'ignore', windowsHide: true, timeout: 30000,
  });
  log(`${why} -> 已让任务计划重启 "${TASK_NAME}"`);
} catch (error) {
  log(`${why} -> schtasks /Run "${TASK_NAME}" 失败：${error.message}`);
  process.exitCode = 1;
}
