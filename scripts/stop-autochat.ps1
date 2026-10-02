[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$mainPath = Join-Path $workspacePath 'src\main.js'
$pidPath = Join-Path $workspacePath 'runtime\autochat.pid'
if (!(Test-Path -LiteralPath $pidPath)) {
    Write-Output 'AutoChat is not running under the background launcher.'
    return
}
$savedProcessId = [int]([System.IO.File]::ReadAllText($pidPath).Trim())
$existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId"
if (!$existing) {
    Write-Output 'AutoChat is already stopped.'
    return
}
if (!$existing.CommandLine -or !$existing.CommandLine.Contains($mainPath) -or $existing.Name -ne 'node.exe') {
    throw 'Saved PID does not belong to this AutoChat service. Refusing to stop it.'
}
if ($PSCmdlet.ShouldProcess("AutoChat process $savedProcessId", 'Stop')) {
    Stop-Process -Id $savedProcessId
    Wait-Process -Id $savedProcessId -Timeout 5 -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
    Write-Output 'AutoChat stopped. NapCat and other QQ processes are unchanged.'
}
