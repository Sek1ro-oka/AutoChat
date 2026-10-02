$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $workspacePath '.env'
$mainPath = Join-Path $workspacePath 'src\main.js'
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
$nodeExecutable = Get-AutoChatNode
# Validate first: an invalid edit must not stop the existing working service.
& $nodeExecutable "--env-file-if-exists=$envPath" $mainPath --check
if ($LASTEXITCODE -ne 0) { throw 'Configuration check failed. The running service was not stopped.' }
& (Join-Path $PSScriptRoot 'stop-autochat.ps1')
& (Join-Path $PSScriptRoot 'start-autochat.ps1')
