$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $workspacePath 'runtime'
$envPath = Join-Path $workspacePath '.env'
$supervisorPath = Join-Path $PSScriptRoot 'supervisor.js'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
if (!(Test-Path -LiteralPath $envPath)) { throw 'First run: use deploy.cmd to install and configure AutoChat.' }
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeExecutable = Get-AutoChatNode
# One judgement for "is it running": the lock the bot itself holds (src/lifecycle.js
# lockPathFor), read through the supervisor's --status. This script starts the
# supervisor, never a second bot, and runtime/autochat.pid is no longer written.
$state = (((& $nodeExecutable $supervisorPath --status) -join '').Trim() | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or !$state) { throw 'Cannot read the AutoChat lock state; the service was not started.' }
if ($state.running) {
    Write-Output "AutoChat is already running (pid $($state.botPid))."
    return
}
if ($state.supervisorPid) {
    Write-Output "AutoChat is supervised (pid $($state.supervisorPid)) and the bot is starting or restarting. Wait a moment, or run stop.cmd."
    return
}
$process = Start-Process -FilePath $nodeExecutable -WorkingDirectory $workspacePath -WindowStyle Hidden `
    -ArgumentList @(('--env-file-if-exists="' + $envPath + '"'), ('"' + $supervisorPath + '"')) `
    -RedirectStandardOutput (Join-Path $runtimePath 'autochat-output.log') `
    -RedirectStandardError (Join-Path $runtimePath 'autochat-error.log') -PassThru
Write-Output "AutoChat supervisor started in background (pid $($process.Id)); it owns the bot process. Logs are in logs/ and runtime/."
