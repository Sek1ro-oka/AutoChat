$ErrorActionPreference = 'Stop'
$workspacePath = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $workspacePath 'package.json') -Raw | ConvertFrom-Json).version
$stagePath = Join-Path $workspacePath ('dist\package-' + [guid]::NewGuid().ToString('N'))
$bundlePath = Join-Path $stagePath 'AutoChat'
New-Item -ItemType Directory -Path $bundlePath -Force | Out-Null
# Explicit allowlist: never copy the live .env, databases, account sessions or logs.
$items = @('src', 'scripts', 'test', 'docs', '.env.example', '.gitignore', 'package.json', 'package-lock.json', 'README.md', 'deploy.cmd', 'restart.cmd', 'stop.cmd', 'THIRD_PARTY_NOTICES.md')
foreach ($item in $items) {
    Copy-Item -LiteralPath (Join-Path $workspacePath $item) -Destination $bundlePath -Recurse
}
$dependencyPath = Join-Path $bundlePath 'node_modules'
New-Item -ItemType Directory -Path $dependencyPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $workspacePath 'node_modules\ws') -Destination $dependencyPath -Recurse
$releasePath = Join-Path $workspacePath 'downloads'
New-Item -ItemType Directory -Path $releasePath -Force | Out-Null
$zipPath = Join-Path $releasePath "AutoChat-v$version-windows.zip"
Compress-Archive -LiteralPath $bundlePath -DestinationPath $zipPath -Force
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($zipPath + '.sha256'), "$hash  $([IO.Path]::GetFileName($zipPath))`n", [Text.UTF8Encoding]::new($false))
Write-Output "Package: $zipPath"
Write-Output "SHA256: $hash"
