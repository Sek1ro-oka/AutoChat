$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $workspacePath 'runtime'
$mainPath = Join-Path $workspacePath 'src\main.js'
$envPath = Join-Path $workspacePath '.env'
$pidPath = Join-Path $runtimePath 'autochat.pid'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
if (Test-Path -LiteralPath $pidPath) {
    $savedProcessId = [int]([System.IO.File]::ReadAllText($pidPath).Trim())
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $savedProcessId"
    if ($existing -and $existing.CommandLine.Contains($mainPath)) {
        Write-Output 'AutoChat is already running.'
        return
    }
}
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeExecutable = Get-AutoChatNode
$process = Start-Process -FilePath $nodeExecutable -WorkingDirectory $workspacePath -WindowStyle Hidden `
    -ArgumentList @(('--env-file="' + $envPath + '"'), ('"' + $mainPath + '"')) `
    -RedirectStandardOutput (Join-Path $runtimePath 'autochat-output.log') `
    -RedirectStandardError (Join-Path $runtimePath 'autochat-error.log') -PassThru
$process.Id | Set-Content -LiteralPath $pidPath
Write-Output 'AutoChat started in background. Logs are in logs/ and runtime/.'
