#!/usr/bin/env node
/**
 * 桥接 supervisor 的「看门人的看门人」。
 *
 * `scripts/bridge-supervisor.mjs` 能看住桥接（探 3100，掉了就按 start.bat 拉起来），
 * 但它自己被杀之后没人管：Windows 的任务计划对「进程被外部杀掉」不会触发
 * RestartOnFailure（2026-11-05 那次 DSH 丢了 30 小时就是这么来的）。
 *
 * 所以另起一个每 2 分钟跑一次的定时任务，只做一件事：
 * supervisor 的 pid 不在 → `schtasks /Run` 让「AutoChat Bridge supervisor」重新接单。
 *
 * 用 schtasks 而不是自己 spawn：直接 spawn 的子进程会落在本任务的作业对象里，
 * 任务实例结束可能被一起收走。
 *
 * 安静是硬要求：活着的时候一行日志都不写；存在 state/bridge-supervisor.pause 时直接退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PID_FILE = path.join(ROOT, 'state', 'bridge-supervisor.pid');
const PAUSE_FILE = path.join(ROOT, 'state', 'bridge-supervisor.pause');
const LOG_FILE = path.join(ROOT, 'logs', 'bridge-supervisor-keeper.log');
const TASK_NAME = 'AutoChat Bridge supervisor';

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

// 守护被明确暂停期间不要把它拉回来
if (fs.existsSync(PAUSE_FILE)) process.exit(0);

const pid = readPid();
if (pid && alive(pid)) process.exit(0);

const why = pid ? `supervisor pid=${pid} 已不在` : 'state/bridge-supervisor.pid 缺失或为空';
try {
  // 不回显 schtasks 的 stdout：它按控制台代码页输出（中文机器上是 GBK），写进 UTF-8 日志就是乱码。
  execFileSync('schtasks', ['/Run', '/TN', TASK_NAME], {
    stdio: 'ignore', windowsHide: true, timeout: 30000,
  });
  log(`${why} -> 已让任务计划重启 "${TASK_NAME}"`);
} catch (error) {
  log(`${why} -> schtasks /Run "${TASK_NAME}" 失败：${error.message}`);
  process.exitCode = 1;
}
