$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$napcatPath = Join-Path $workspacePath 'runtime\napcat'
$envPath = Join-Path $workspacePath '.env'
$envText = [System.IO.File]::ReadAllText($envPath)
$customQQ = [regex]::Match($envText, '(?m)^QQ_EXECUTABLE=(.+)\r?$').Groups[1].Value.Trim().Trim('"')
$candidates = @($customQQ,
    (Join-Path $env:ProgramFiles 'Tencent\QQNT\QQ.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tencent\QQNT\QQ.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Tencent\QQNT\QQ.exe'))
$qqExecutable = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$bootExecutable = Join-Path $napcatPath 'NapCatWinBootMain.exe'
if (!(Test-Path -LiteralPath $qqExecutable) -or !(Test-Path -LiteralPath $bootExecutable)) {
    throw 'Install QQ NT from https://im.qq.com/ first. For custom paths set QQ_EXECUTABLE in .env, then run deploy.cmd again.'
}
$existingQQ = Get-CimInstance Win32_Process -Filter "Name = 'QQ.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($napcatPath) }
if ($existingQQ) { Write-Output 'NapCat QQ process already running.'; return }
$launcherPidPath = Join-Path $workspacePath 'runtime\napcat-launcher.pid'
if (Test-Path -LiteralPath $launcherPidPath) {
    $launcherId = [int]([IO.File]::ReadAllText($launcherPidPath).Trim())
    $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $launcherId"
    if ($launcher -and $launcher.ExecutablePath -eq $bootExecutable) { Write-Output 'NapCat launcher already running.'; return }
}
$listeners = @(Get-NetTCPConnection -LocalPort 6099 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
    throw 'NapCat WebUI port 6099 is already occupied. Use the existing NapCat instance or stop its owned QQ process before deploying again. AutoChat can be restarted with restart.cmd.'
}
$botId = [regex]::Match($envText, '(?m)^BOT_QQ=(\d+)\s*$').Groups[1].Value
if (!$botId) { throw 'BOT_QQ is not configured.' }
$env:NAPCAT_PATCH_PACKAGE = Join-Path $napcatPath 'qqnt.json'
$env:NAPCAT_LOAD_PATH = Join-Path $napcatPath 'loadNapCat.js'
$env:NAPCAT_INJECT_PATH = Join-Path $napcatPath 'NapCatWinBootHook.dll'
$env:NAPCAT_MAIN_PATH = Join-Path $napcatPath 'napcat.mjs'
$moduleUri = ([System.Uri]$env:NAPCAT_MAIN_PATH).AbsoluteUri
[System.IO.File]::WriteAllText($env:NAPCAT_LOAD_PATH, "(async () => {await import('$moduleUri')})()", [System.Text.UTF8Encoding]::new($false))
$outputPath = Join-Path $workspacePath 'runtime\napcat-output.log'
$errorPath = Join-Path $workspacePath 'runtime\napcat-error.log'
# Ordinary-user launch; no UAC, no changes to the installed QQ files.
$process = Start-Process -FilePath $bootExecutable -WorkingDirectory $napcatPath -WindowStyle Hidden `
    -ArgumentList @(('"' + $qqExecutable + '"'), ('"' + $env:NAPCAT_INJECT_PATH + '"'), '-q', $botId) `
    -RedirectStandardOutput $outputPath -RedirectStandardError $errorPath -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $workspacePath 'runtime\napcat-launcher.pid')
Write-Output 'NapCat launcher started. Awaiting QQ login; logs are in runtime.'
