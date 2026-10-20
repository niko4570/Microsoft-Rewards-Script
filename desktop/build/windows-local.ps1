param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$BuildRoot
)

$ErrorActionPreference = 'Stop'
if (-not $BuildRoot) { $BuildRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('RewardsDesktop-' + [guid]::NewGuid().ToString('N')) }
$buildRoot = $BuildRoot
$checkout = Join-Path $buildRoot 'source'
$savedPath = $env:Path
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $checkout -Force | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $checkout -Recurse -Force

try {
    $manifest = (Invoke-WebRequest -UseBasicParsing 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt').Content
    $entry = ($manifest -split "`n" | Where-Object { $_ -match 'node-v24\.\d+\.\d+-win-x64\.zip$' } | Select-Object -First 1).Trim() -split '\s+'
    if ($entry.Length -ne 2) { throw 'Cannot locate the official Node.js 24 Windows x64 archive' }
    $archive = Join-Path $buildRoot $entry[1]
    if (-not (Test-Path $archive)) { Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/latest-v24.x/' + $entry[1]) -OutFile $archive }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry[0].ToLowerInvariant()) { throw 'Node.js archive SHA-256 mismatch' }
    if (-not (Test-Path (Join-Path $buildRoot ($entry[1] -replace '\.zip$', '')))) { Expand-Archive -LiteralPath $archive -DestinationPath $buildRoot }
    $nodeDirectory = Join-Path $buildRoot ($entry[1] -replace '\.zip$', '')
    $node = Join-Path $nodeDirectory 'node.exe'
    $npmCli = Join-Path $nodeDirectory 'node_modules/npm/bin/npm-cli.js'
    $env:Path = $nodeDirectory + ';' + $savedPath
    $env:npm_config_cache = Join-Path $buildRoot 'npm-cache'
    $env:MRS_DESKTOP_NODE = $node
    Set-Location $checkout
    # Archive the clean allowlisted snapshot, never a checkout with dependencies.
    Compress-Archive -Path (Join-Path $Source '*') -DestinationPath (Join-Path $buildRoot 'rewards-desktop-source.zip') -Force

    function Invoke-Npm([string[]]$Arguments) {
        & $node $npmCli @Arguments
        if ($LASTEXITCODE -ne 0) { throw ('npm failed: ' + ($Arguments -join ' ')) }
    }
    if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) { throw 'Install Rust stable (MSVC), Visual Studio C++ Build Tools and WebView2 before building Tauri.' }
    Invoke-Npm @('ci', '--no-audit', '--no-fund')
    Invoke-Npm @('run', 'build')
    Invoke-Npm @('run', 'lint')
    Invoke-Npm @('run', 'test:tasks')
    Invoke-Npm @('run', 'test:log-parser')
    Invoke-Npm @('run', 'test:schedule')
    Invoke-Npm @('ci', '--prefix', 'desktop', '--no-audit', '--no-fund')
    Invoke-Npm @('test', '--prefix', 'desktop')
    Invoke-Npm @('run', 'build', '--prefix', 'desktop')
    Invoke-Npm @('run', 'test:native', '--prefix', 'desktop')
    Invoke-Npm @('run', 'package:win', '--prefix', 'desktop')
    Copy-Item (Join-Path $buildRoot 'rewards-desktop-source.zip') (Join-Path $checkout 'desktop/release/rewards-desktop-source.zip')
    & $node (Join-Path $checkout 'desktop/build/checksums.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Checksum generation failed' }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem (Join-Path $checkout 'desktop/release') -File | Where-Object { $_.Extension -in '.exe', '.zip', '.txt' } | Copy-Item -Destination $Destination -Force
    Write-Output ('WINDOWS_BUILD_ROOT=' + $buildRoot)
    Write-Output ('WINDOWS_ARTIFACTS=' + $Destination)
} finally {
    $env:Path = $savedPath
}
