function Get-AutoChatNode {
    $portable = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node\node.exe'
    if (Test-Path -LiteralPath $portable) { return $portable }
    $installed = Get-Command node -ErrorAction SilentlyContinue
    if ($installed) {
        $version = & $installed.Source -p 'parseInt(process.versions.node)'
        if ($LASTEXITCODE -eq 0 -and [int]$version -ge 24) { return $installed.Source }
    }
    throw 'Node.js 24+ is required. Run deploy.cmd first.'
}
