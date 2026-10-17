[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$mainPath = Join-Path $workspacePath 'src\main.js'
$supervisorPath = Join-Path $PSScriptRoot 'supervisor.js'
$legacyPidPath = Join-Path $workspacePath 'runtime\autochat.pid'
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeExecutable = Get-AutoChatNode

function Get-AutoChatProcess([object]$processId) {
    if (!$processId) { return $null }
    return Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$processId)" -ErrorAction SilentlyContinue
}

# A pid is not an identity: the image name and command line decide. This is the
# existing guard, kept for both the bot and the supervisor, and it is why a stale
# file can never stop an unrelated node.exe.
function Assert-AutoChatProcess([object]$process, [string]$contains, [string]$label) {
    if (!$process) { return }
    if ($process.Name -ne 'node.exe' -or !$process.CommandLine -or !$process.CommandLine.Contains($contains)) {
        throw "$label pid $($process.ProcessId) does not belong to this AutoChat service. Refusing to stop it."
    }
}

# A lock file is deleted only after its holder is proven gone; a live holder keeps it.
function Remove-ProvenStaleLock([string]$lockPath, [string]$label) {
    if (!$lockPath -or !(Test-Path -LiteralPath $lockPath)) { return }
    $holder = $null
    try { $holder = [System.IO.File]::ReadAllText($lockPath) | ConvertFrom-Json } catch { }
    if ($holder -and (Get-AutoChatProcess $holder.pid)) {
        Write-Output "Keeping the $label lock: pid $($holder.pid) is still alive."
        return
    }
    Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue
}

# Legacy launcher file: nothing writes it any more (see start-autochat.ps1), so it
# is removed only once its pid is gone.
function Remove-LegacyPidFile() {
    if (!(Test-Path -LiteralPath $legacyPidPath)) { return }
    $savedProcessId = 0
    try { $savedProcessId = [int]([System.IO.File]::ReadAllText($legacyPidPath).Trim()) } catch { }
    if ($savedProcessId -and (Get-AutoChatProcess $savedProcessId)) {
        Write-Output "Keeping runtime\autochat.pid: pid $savedProcessId is still alive."
        return
    }
    Remove-Item -LiteralPath $legacyPidPath -ErrorAction SilentlyContinue
}

$state = (((& $nodeExecutable $supervisorPath --status) -join '').Trim() | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or !$state) { throw 'Cannot read the AutoChat lock state; nothing was stopped.' }
$bot = Get-AutoChatProcess $state.botPid
$supervisor = Get-AutoChatProcess $state.supervisorPid
if (!$bot -and !$supervisor) {
    Write-Output 'AutoChat is already stopped.'
    Remove-ProvenStaleLock $state.locks.bot 'bot'
    Remove-ProvenStaleLock $state.locks.supervisor 'supervisor'
    Remove-LegacyPidFile
    return
}
Assert-AutoChatProcess $bot $mainPath 'AutoChat bot'
Assert-AutoChatProcess $supervisor 'supervisor.js' 'AutoChat supervisor'
if ($PSCmdlet.ShouldProcess("bot pid $($state.botPid), supervisor pid $($state.supervisorPid)", 'Stop')) {
    # Supervisor first: left alive, it would relaunch the bot we are about to stop.
    if ($supervisor) {
        Stop-Process -Id $supervisor.ProcessId
        Wait-Process -Id $supervisor.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    if ($bot) {
        Stop-Process -Id $bot.ProcessId
        Wait-Process -Id $bot.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    if ((Get-AutoChatProcess $state.botPid) -or (Get-AutoChatProcess $state.supervisorPid)) {
        throw 'AutoChat did not stop within 5 seconds. Check Task Manager before retrying.'
    }
    # Both pids are gone, so these files are provably stale.
    Remove-ProvenStaleLock $state.locks.bot 'bot'
    Remove-ProvenStaleLock $state.locks.supervisor 'supervisor'
    Remove-LegacyPidFile
    Write-Output 'AutoChat stopped. NapCat and other QQ processes are unchanged.'
}
