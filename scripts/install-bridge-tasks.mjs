#!/usr/bin/env node
/**
 * 把桥接的常驻守护装进 Windows 计划任务（幂等，默认只补缺、不动已有的）。
 *
 * 为什么需要它：`scripts/bridge-supervisor.mjs` 探活 3100、掉了就按 start.bat 拉起来，
 * 但它自己被杀之后没人管。桥接是「整个机器人在不在线」的那根线——它没了，QQ 那边
 * 还连着、消息还在进来，只是没人应答，看起来就像「断连」。
 *
 * 两层，和 DSH / SnowLuma 那两套同构：
 *   ① `AutoChat Bridge supervisor`：常驻，每 60s 探一次 3100，掉树就拉回来；
 *   ② `AutoChat Bridge supervisor keeper`：每 2 分钟跑 `ensure-bridge-supervisor.mjs`，
 *      发现 ① 的 pid 不在了就 `schtasks /Run` 让它重新接单。
 *
 * 用法：
 *   node scripts/install-bridge-tasks.mjs           # 只装缺的
 *   node scripts/install-bridge-tasks.mjs --force   # 覆盖重装（先 /End 旧实例）
 *   node scripts/install-bridge-tasks.mjs --dry-run # 只打印 XML
 *   node scripts/install-bridge-tasks.mjs --only=supervisor|keeper
 *
 * 坑：非管理员下 `schtasks /Create` 带 <LogonTrigger> 会被拒绝（Access is denied），
 * 所以这里和 SnowLuma 那套一样用 CalendarTrigger + StartWhenAvailable。
 * 坑：schtasks 只认 UTF-16 + BOM 的 XML。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const SUPERVISOR_TASK = 'AutoChat Bridge supervisor';
const KEEPER_TASK = 'AutoChat Bridge supervisor keeper';
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
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
  description: '常驻探活桥接 HTTP（3100）：整个进程树没了就按仓库自己的 start.bat 拉起来；端口没开但进程还在时只等，不双开（双开会抢 state/）。由 AutoChat Bridge supervisor keeper 兜底重启。',
  triggers: `    <CalendarTrigger>
      <StartBoundary>${new Date().toISOString().slice(0, 10)}T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`,
  actions: `    <Exec>
      <Command>${esc(NODE)}</Command>
      <Arguments>"${esc(path.join(ROOT, 'scripts', 'bridge-supervisor.mjs'))}"</Arguments>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>`,
  executionTimeLimit: 'PT0S',
  restartOnFailure: true,
});

const keeperXml = taskXml({
  uri: KEEPER_TASK,
  description: '每 2 分钟看一眼 AutoChat Bridge supervisor 还在不在；不在了就让计划任务把它拉起来（活着时一行日志都不写，存在 state/bridge-supervisor.pause 时什么也不做）。',
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
      <Arguments>"${esc(path.join(ROOT, 'scripts', 'ensure-bridge-supervisor.mjs'))}"</Arguments>
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
  console.log('\n用 `schtasks /Query /TN "AutoChat Bridge supervisor" /FO LIST /V` 看状态；');
  console.log('supervisor 日志：logs/bridge-supervisor.log（端口掉了/拉起时才写）');
  console.log('keeper 日志：logs/bridge-supervisor-keeper.log（发现 supervisor 不在了才写一行）');
  console.log('想停掉守护：建 state/bridge-supervisor.pause（删掉即恢复），或 schtasks /End 两个任务。');
}
process.exitCode = ok ? 0 : 1;
