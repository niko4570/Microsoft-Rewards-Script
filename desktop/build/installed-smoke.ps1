$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This installation check requires a disposable GitHub Actions Windows runner.'
}

$desktop = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $desktop 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $desktop "release/Rewards-Desktop-$version-x64.exe"
$installDirectory = Join-Path $env:RUNNER_TEMP ('Rewards Desktop acceptance-' + [guid]::NewGuid().ToString('N'))
$node = (Get-Command node.exe -ErrorAction Stop).Source
$savedPath = $env:Path
$savedNodePath = $env:NODE_PATH
$savedNodeOptions = $env:NODE_OPTIONS
$savedPackaged = $env:MRS_PACKAGED_EXECUTABLE
$savedScreenshot = $env:MRS_SMOKE_SCREENSHOT

try {
    $checksum = Get-Content (Join-Path $desktop 'release/SHA256SUMS.txt') |
        Where-Object { $_.EndsWith("  Rewards-Desktop-$version-x64.exe") }
    if (@($checksum).Count -ne 1) { throw 'Missing or ambiguous installer checksum.' }
    $expected = ($checksum -split '\s+')[0]
    if ((Get-FileHash $installer -Algorithm SHA256).Hash -ine $expected) {
        throw 'Installer checksum mismatch.'
    }

    # The harness uses its absolute Node path; the installed app only sees OS tools.
    $env:Path = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    $env:NODE_PATH = $null
    $env:NODE_OPTIONS = $null
    foreach ($tool in @('node.exe', 'npm.cmd', 'git.exe', 'docker.exe')) {
        if (Get-Command $tool -ErrorAction SilentlyContinue) {
            throw "Development tool remains on the application PATH: $tool"
        }
    }

    # NSIS requires /D to be the final argument, without surrounding quotes.
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    $executable = Join-Path $installDirectory 'Rewards Desktop.exe'
    if (-not (Test-Path $executable)) { throw 'Installed application executable is missing.' }

    & $node (Join-Path $PSScriptRoot 'smoke-runtime.mjs') (Join-Path $installDirectory 'resources/backend')
    if ($LASTEXITCODE -ne 0) { throw 'Installed runtime check failed.' }
    $env:MRS_PACKAGED_EXECUTABLE = $executable
    $env:MRS_SMOKE_SCREENSHOT = Join-Path $desktop 'release/installed-smoke.png'
    & $node (Join-Path $PSScriptRoot 'ui-smoke.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Installed application UI check failed.' }
    Write-Output 'Installer checksum, silent installation, bundled runtime and installed UI without development tools on PATH: PASS'
} finally {
    $env:Path = $savedPath
    $env:NODE_PATH = $savedNodePath
    $env:NODE_OPTIONS = $savedNodeOptions
    $env:MRS_PACKAGED_EXECUTABLE = $savedPackaged
    $env:MRS_SMOKE_SCREENSHOT = $savedScreenshot
}
