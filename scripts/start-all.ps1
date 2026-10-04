param([switch]$OpenQr)
$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspacePath
$envPath = Join-Path $workspacePath '.env'
if (!(Test-Path -LiteralPath $envPath)) { throw 'First run: use deploy.cmd to install and configure AutoChat.' }
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeExecutable = Get-AutoChatNode
& $nodeExecutable "--env-file=$envPath" (Join-Path $workspacePath 'src\main.js') --check
if ($LASTEXITCODE -ne 0) { throw 'Fix .env first. Existing services were not stopped.' }
& (Join-Path $PSScriptRoot 'start-napcat.ps1')
& (Join-Path $PSScriptRoot 'start-autochat.ps1')
& $nodeExecutable "--env-file=$envPath" (Join-Path $PSScriptRoot 'connection-check.js')
if ($LASTEXITCODE -eq 0) {
    Write-Host 'AutoChat is ready. Closing this window will not stop the background services.'
    return
}
Write-Host 'Background services started, but QQ is not ready. Checking login...'
$loginOutput = & $nodeExecutable (Join-Path $PSScriptRoot 'napcat-login.js') 2>$null
$loginStatus = $null
foreach ($line in $loginOutput) {
    try {
        $record = $line | ConvertFrom-Json
        if ($record.PSObject.Properties.Name -contains 'isLogin') { $loginStatus = $record }
    } catch { }
}
if ($loginStatus -and $loginStatus.isLogin -eq $false) {
    Write-Host 'QQ needs login. Scan the QR code with the bot QQ account and confirm on your phone.'
    & $nodeExecutable (Join-Path $PSScriptRoot 'napcat-login.js') --refresh
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'QR refresh failed. Use the local NapCat WebUI to sign in, or run start.cmd again.'
        return
    }
    $qrPath = Join-Path $workspacePath 'runtime\napcat\cache\qrcode.png'
    Write-Host "QR image: $qrPath"
    if ($OpenQr -and (Test-Path -LiteralPath $qrPath)) { Start-Process -FilePath $qrPath }
    Write-Host 'After login AutoChat reconnects automatically; you do not need to run start.cmd again.'
    Write-Host 'If QR expires, run start.cmd again. Avoid logging the same account into another desktop QQ.'
    return
}
Write-Warning 'QQ login is not confirmed. Check runtime logs, OneBot port/Token, or http://127.0.0.1:6099/webui/.'
Write-Host 'The background bot keeps reconnecting. Run start.cmd again to recheck.'
