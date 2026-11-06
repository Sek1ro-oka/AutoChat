#!/usr/bin/env node
/**
 * 把 DSH 的常驻部分装进 Windows 计划任务（幂等，默认只补缺、不动已有的）。
 *
 * 为什么需要它：`scripts/dsh-web-supervisor.mjs` 能探活 3080、重建 DSH、修 MCP 区块，
 * 但**它自己被杀之后没人管**。2026-11-05 就是这种情况——supervisor 跟着宿主进程树一起
 * 消失，DSH 停了 30 小时，桥接一直报 `dshReady=false`，而任务计划里的
 * `RestartOnFailure` 对「进程被外部杀掉」并不触发（实测）。
 *
 * 于是分成两层：
 *   ① `AutoChat DSH supervisor`：登录后 30 秒起 supervisor（隐藏窗口、常驻、单实例）；
 *   ② `AutoChat DSH supervisor keeper`：每 2 分钟跑 `ensure-dsh-supervisor.mjs`，
 *      发现 pid 文件里的 supervisor 不在了，就 `schtasks /Run` 让 ① 重新接单。
 *
 * 用法：
 *   node scripts/install-dsh-tasks.mjs           # 只装缺的
 *   node scripts/install-dsh-tasks.mjs --force   # 覆盖重装（会先停掉正在跑的那个任务）
 *   node scripts/install-dsh-tasks.mjs --dry-run # 只打印 XML
 *
 * 注意：schtasks 只认 **UTF-16 + BOM** 的 XML，声明写成 UTF-8 会报「无法切换编码」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const SUPERVISOR_TASK = 'AutoChat DSH supervisor';
const KEEPER_TASK = 'AutoChat DSH supervisor keeper';
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
// 只想替换其中一个任务时用 --only=keeper / --only=supervisor（--force 会把正在跑的实例 End 掉）
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : '';

const user = process.env.USERNAME
  ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME)
  : '';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function taskXml({ uri, description, triggers, actions, executionTimeLimit, restartOnFailure = false }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>AutoChat</Author>
    <Description>${esc(description)}</Description>
    <URI>\\${esc(uri)}</URI>
  </RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>${executionTimeLimit}</ExecutionTimeLimit>
    <Priority>7</Priority>
${restartOnFailure ? `    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
` : ''}  </Settings>
  <Actions Context="Author">
${actions}
  </Actions>
</Task>
`;
}

const supervisorXml = taskXml({
  uri: SUPERVISOR_TASK,
  description: '常驻探活 DSH Web（3080）：掉了就重建，MCP 区块被抹掉就补回去。由 AutoChat DSH supervisor keeper 兜底重启。',
  triggers: `    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </LogonTrigger>`,
  actions: `    <Exec>
      <Command>${esc(NODE)}</Command>
      <Arguments>"${esc(path.join(ROOT, 'scripts', 'dsh-web-supervisor.mjs'))}"</Arguments>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>`,
  executionTimeLimit: 'PT0S',
  restartOnFailure: true,
});

const keeperXml = taskXml({
  uri: KEEPER_TASK,
  description: '每 2 分钟看一眼 AutoChat DSH supervisor 还在不在；不在了就让计划任务把它拉起来（活着时脚本一行日志都不写）。',
  triggers: `    <CalendarTrigger>
      <StartBoundary>${new Date().toISOString().slice(0, 10)}T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT2M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`,
  actions: `    <Exec>
      <Command>${esc(NODE)}</Command>
      <Arguments>"${esc(path.join(ROOT, 'scripts', 'ensure-dsh-supervisor.mjs'))}"</Arguments>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>`,
  executionTimeLimit: 'PT5M',
});

function exists(name) {
  try {
    execFileSync('schtasks', ['/Query', '/TN', name], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

function install(name, xml) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autochat-task-'));
  const file = path.join(dir, `${name.replace(/[^\w.-]+/g, '-')}.xml`);
  try {
    if (dryRun) {
      console.log(`--- ${name} ---\n${xml}`);
      return true;
    }
    // UTF-16LE + BOM：schtasks 只吃这种编码
    writeFileSync(file, `\uFEFF${xml}`, 'utf16le');
    if (exists(name) && !force) {
      console.log(`[skip] ${name} 已存在（要重装加 --force）`);
      return true;
    }
    if (exists(name) && force) {
      // 覆盖一个正在运行的任务前先停：否则 /Create /F 可能失败，且旧实例还占着端口
      try { execFileSync('schtasks', ['/End', '/TN', name], { stdio: 'ignore', windowsHide: true, timeout: 20000 }); } catch { /* 没在跑 */ }
    }
    execFileSync('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], { stdio: 'inherit', windowsHide: true, timeout: 60000 });
    console.log(`[ok] ${name}`);
    return true;
  } catch (error) {
    console.error(`[fail] ${name}: ${error?.message ?? error}`);
    return false;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录而已 */ }
  }
}

console.log(`仓库：${ROOT}`);
console.log(`用户：${user || '(未知)'}${force ? '（--force）' : ''}`);
let ok = true;
if (!only || only === 'supervisor') ok = install(SUPERVISOR_TASK, supervisorXml) && ok;
if (!only || only === 'keeper') ok = install(KEEPER_TASK, keeperXml) && ok;
if (!dryRun) {
  console.log('\n用 `schtasks /Query /TN "AutoChat DSH supervisor" /FO LIST /V` 看状态；');
  console.log('keeper 的动作日志只在「发现 supervisor 不在了」时写一行：logs/dsh-supervisor-keeper.log');
}
process.exitCode = ok ? 0 : 1;
