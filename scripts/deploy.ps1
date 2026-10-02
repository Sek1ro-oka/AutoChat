param([switch]$PrepareOnly, [switch]$ConfigureOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$workspacePath = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspacePath
$downloadsPath = Join-Path $workspacePath 'runtime\downloads'
New-Item -ItemType Directory -Path $downloadsPath -Force | Out-Null
. (Join-Path $PSScriptRoot 'node-runtime.ps1')
try { $nodeExecutable = Get-AutoChatNode } catch {
    $version = 'v24.16.0'
    $archiveName = "node-$version-win-x64.zip"
    $archivePath = Join-Path $downloadsPath $archiveName
    Write-Host 'Downloading official Node.js portable runtime...'
    $checksums = (Invoke-WebRequest "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+$([regex]::Escape($archiveName))\s*$").Groups[1].Value
    if (!$expected) { throw 'Official Node checksum not found.' }
    Invoke-WebRequest "https://nodejs.org/dist/$version/$archiveName" -OutFile $archivePath -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expected) { throw 'Node checksum mismatch.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $downloadsPath -Force
    $portablePath = Join-Path $workspacePath 'runtime\node'
    New-Item -ItemType Directory -Path $portablePath -Force | Out-Null
    Copy-Item -Path (Join-Path $downloadsPath "node-$version-win-x64\*") -Destination $portablePath -Recurse -Force
    $nodeExecutable = Get-AutoChatNode
}
if (!(Test-Path -LiteralPath (Join-Path $workspacePath 'node_modules\ws\package.json'))) {
    $npmCli = Join-Path (Split-Path -Parent $nodeExecutable) 'node_modules\npm\bin\npm-cli.js'
    & $nodeExecutable $npmCli ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
$napcatPath = Join-Path $workspacePath 'runtime\napcat'
if (!(Test-Path -LiteralPath (Join-Path $napcatPath 'NapCatWinBootMain.exe'))) {
    Write-Host 'Downloading official NapCatQQ v4.18.28...'
    $archivePath = Join-Path $downloadsPath 'NapCat.Shell.zip'
    if (!(Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne 'bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94') {
        Invoke-WebRequest 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.28/NapCat.Shell.zip' -OutFile $archivePath -UseBasicParsing
    }
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne 'bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94') { throw 'NapCat checksum mismatch.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $napcatPath -Force
}
if ($PrepareOnly) { Write-Host 'Runtime preparation complete; no configuration or services changed.'; return }
$envPath = Join-Path $workspacePath '.env'
if (!(Test-Path -LiteralPath $envPath)) {
    Write-Host 'First-time setup. Existing .env files are preserved. English commas separate QQ IDs.'
    $values = @{}
    $values['BOT_QQ'] = Read-Host 'Bot QQ number'
    $values['PRIVATE_USER_QQS'] = Read-Host 'Allowed private QQ numbers (comma separated)'
    $values['GROUP_QQ'] = Read-Host 'Allowed group number'
    $values['ADMIN_QQ'] = Read-Host 'Administrator QQ number (one allowed private user)'
    $secret = Read-Host 'DeepSeek API key (hidden)' -AsSecureString
    $credential = New-Object System.Management.Automation.PSCredential('key', $secret)
    $values['DEEPSEEK_API_KEY'] = $credential.GetNetworkCredential().Password
    if ($values['DEEPSEEK_API_KEY'] -notmatch '^[a-zA-Z0-9_-]+$') { throw 'API key must contain only letters, digits, underscores or hyphens.' }
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($random) } finally { $rng.Dispose() }
    $values['ONEBOT_ACCESS_TOKEN'] = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
    Write-Host 'Verify current DeepSeek prices. Conservative reference: input 2, output 8 CNY per million tokens.'
    $values['PRICE_INPUT_CNY_PER_MILLION'] = Read-Host 'Verified input price in CNY per million tokens'
    $values['PRICE_OUTPUT_CNY_PER_MILLION'] = Read-Host 'Verified output price in CNY per million tokens'
    $values['PRICE_VERIFIED_DATE'] = Get-Date -Format 'yyyy-MM-dd'
    $template = [IO.File]::ReadAllText((Join-Path $workspacePath '.env.example'))
    foreach ($key in $values.Keys) {
        if ($values[$key] -match '[\r\n]') { throw 'Values must be a single line.' }
        $replacement = $key + '=' + $values[$key]
        $template = [regex]::Replace($template, "(?m)^$key=.*$", [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $replacement })
    }
    [IO.File]::WriteAllText($envPath, $template, [Text.UTF8Encoding]::new($false))
}
& $nodeExecutable '--env-file=.env' 'src/main.js' '--check'
if ($LASTEXITCODE -ne 0) { throw 'Edit .env to fix configuration, then run deploy.cmd again.' }
& $nodeExecutable '--env-file=.env' 'scripts/configure-napcat.js'
if ($LASTEXITCODE -ne 0) { throw 'NapCat configuration failed.' }
if ($ConfigureOnly) { Write-Host 'Configuration prepared; services were not started.'; return }
& (Join-Path $PSScriptRoot 'start-napcat.ps1')
& (Join-Path $PSScriptRoot 'start-autochat.ps1')
Write-Host 'AutoChat is running. First login: scan runtime\napcat\cache\qrcode.png with the bot QQ account.'
Write-Host 'QR image may take a few seconds to appear. Re-open it if refreshed. Do not log in the same account in desktop QQ.'
Write-Host 'Send the help command shown in README or a normal private message after login.'
